#!/usr/bin/env node
// Direct ssh-mcp connectivity test, bypassing any agent / MCP client.
// Uses ssh-mcp's OWN config loader, credential resolver and SSH stack, so
// the result is exactly what the MCP server would see in this session.
//
// Usage:
//   node test-connection.mjs <bundlePath> [--config=<path>]           # ALL profiles
//   node test-connection.mjs <bundlePath> <profileName> [--config=]   # ONE profile
//
// Prints only names, booleans and lengths - never a secret.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const bundlePath = args.find((a) => !a.startsWith('--'));
const configArg = args.find((a) => a.startsWith('--config='));
const profileArg = args.find((a) => !a.startsWith('--') && a !== bundlePath);

if (!bundlePath) {
  console.error('usage: node test-connection.mjs <bundlePath> [profileName] [--config=<path>]');
  console.error('       no profileName = test ALL profiles, then print a summary');
  process.exit(2);
}

const base = (p) =>
  pathToFileURL(path.join(bundlePath, 'node_modules', 'ssh-mcp', 'build', p)).href;

let loadConfig, getConfigPath, initKeychain, resolveCredentials, SSHConnection;
try {
  ({ loadConfig, getConfigPath } = await import(base('config/loader.js')));
  ({ initKeychain, resolveCredentials } = await import(base('config/credential-resolver.js')));
  ({ SSHConnection } = await import(base('ssh/connection.js')));
} catch (e) {
  console.error('Cannot load ssh-mcp from the bundle: ' + (e && e.message ? e.message : e));
  process.exit(1);
}

// 1. Load the config exactly like the server does (default location unless
// --config= is given). ACL findings downgrade to warnings so this diagnostic
// can still run; a real server start keeps refusing them.
let config;
try {
  const aclOpts = {
    enforce: false,
    allowUnchecked: true,
    onFinding: (f) => console.error('ACL warning: ' + f.message),
  };
  config = await loadConfig(configArg ? configArg.slice('--config='.length) : undefined, aclOpts);
} catch (e) {
  console.error('CONFIG FAILED: ' + (e && e.message ? e.message : e));
  if (!configArg) console.error('(looked at the default location: ' + getConfigPath() + ')');
  process.exit(1);
}

console.log('config path :', configArg ? configArg.slice('--config='.length) : getConfigPath());
if (!config.profiles.length) {
  console.error('No profiles configured.');
  process.exit(1);
}
console.log('profiles    :', config.profiles.map((p) => p.name).join(', '));

const keyringAvailable = await initKeychain();
console.log('keyring     :', keyringAvailable ? 'available' : 'UNAVAILABLE in this process');

const req = createRequire(path.join(bundlePath, 'package.json'));
let keyring = null;
try {
  keyring = req('@napi-rs/keyring');
} catch {
  /* diagnostics below report this per profile */
}

const msg = (e) => (e && e.message ? e.message : String(e));
const withTimeout = (p, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' outer timeout (30s)')), 30000)),
  ]);

// ProxyJump support, mirroring ConnectionRegistry: connect the bastion
// (recursively, for chains), then forward a channel to the target.
async function openJump(profile, created) {
  if (!profile.via) return undefined;
  const viaProfile = config.profiles.find((p) => p.name === profile.via);
  if (!viaProfile) throw new Error('via profile not found: ' + profile.via);
  const nestedSock = await openJump(viaProfile, created);
  const viaCreds = await resolveCredentials(viaProfile);
  const bastion = new SSHConnection(viaProfile, viaCreds, new Map(), 'tofu', nestedSock);
  created.push(bastion);
  await withTimeout(bastion.ensureConnected(), 'bastion "' + viaProfile.name + '"');
  const client = bastion.getClient();
  return await new Promise((resolve, reject) => {
    client.forwardOut('', 0, profile.host, profile.port, (err, stream) => {
      if (err) reject(new Error('ProxyJump via "' + profile.via + '" failed: ' + err.message));
      else resolve(stream);
    });
  });
}

async function testProfile(profile) {
  console.log('');
  console.log('=== profile: ' + profile.name + ' ===');
  console.log('target      :', profile.host + ':' + profile.port + ' as ' + profile.user);
  console.log('auth        :', profile.auth + (profile.keychainEntry ? ' (' + profile.keychainEntry + ')' : '') + (profile.via ? ' via ' + profile.via : ''));
  if (profile.auth !== 'keychain') {
    console.log('NOTE        : auth is not "keychain" - a set-credential.ps1 entry is NOT used by this profile.');
  }

  // Keychain diagnostics: direct read with the same library ssh-mcp uses.
  if (profile.auth === 'keychain') {
    try {
      if (!keyring) throw new Error('keyring library unavailable');
      const [svc, acc] = (profile.keychainEntry || '').split('/');
      const stored = new keyring.Entry(svc || 'ssh-mcp', acc || profile.name).getPassword();
      console.log('keychain    :', stored == null ? 'entry NOT FOUND' : 'entry present (' + stored.length + ' chars)');
    } catch (e) {
      console.log('keychain    : READ FAILED - ' + msg(e));
    }
  }

  // Environment variable diagnostics (names and lengths only).
  const envName =
    'SSH_MCP_' + profile.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_PASSWORD';
  for (const name of [envName, 'SSH_MCP_PASSWORD']) {
    const v = process.env[name];
    console.log('env         :', name, v ? 'set (' + v.length + ' chars)' : 'not set');
  }

  // Resolve credentials exactly like the server does.
  let creds;
  try {
    creds = await resolveCredentials(profile);
  } catch (e) {
    console.error('CREDENTIALS FAILED: ' + msg(e));
    return { name: profile.name, ok: false, reason: 'credentials: ' + msg(e) };
  }
  console.log(
    'resolved    : password=' + (creds.password ? creds.password.length + ' chars' : 'none') +
    ' privateKey=' + (creds.privateKey ? 'yes' : 'no') +
    ' agent=' + (creds.agentSocket ? 'yes' : 'no'),
  );

  // Connect with ssh-mcp's own SSH stack (same algorithms, same everything).
  console.log('connecting  : ...');
  const created = [];
  try {
    const sock = await openJump(profile, created);
    const conn = new SSHConnection(profile, creds, new Map(), 'tofu', sock);
    created.push(conn);
    await withTimeout(conn.ensureConnected(), profile.name);
    console.log('RESULT      : CONNECTED as ' + profile.user + '@' + profile.host);
    return { name: profile.name, ok: true };
  } catch (e) {
    const reason = msg(e);
    console.error('RESULT      : FAILED - ' + reason);
    return { name: profile.name, ok: false, reason };
  } finally {
    for (const c of created) await c.close().catch(() => {});
  }
}

// Select targets: one named profile, or all of them.
let targets;
if (profileArg) {
  const one = config.profiles.find((p) => p.name === profileArg);
  if (!one) {
    console.error('profile not found: ' + profileArg + ' (available: ' + config.profiles.map((p) => p.name).join(', ') + ')');
    process.exit(1);
  }
  targets = [one];
} else {
  targets = config.profiles;
}

const results = [];
for (const p of targets) {
  results.push(await testProfile(p));
}

if (results.length > 1 || !profileArg) {
  console.log('');
  console.log('=== SUMMARY ===');
  for (const r of results) {
    console.log('  ' + r.name.padEnd(20) + ': ' + (r.ok ? 'CONNECTED' : 'FAILED - ' + r.reason));
  }
}

const failed = results.filter((r) => !r.ok);
if (!failed.length) {
  console.log('');
  console.log('All tested profiles connected. If the agent still fails, the difference is');
  console.log('the agent process: its environment variables, its ability to read');
  console.log('Credential Manager, or which machine it runs on.');
}
process.exit(failed.length ? 1 : 0);
