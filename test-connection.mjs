#!/usr/bin/env node
// Direct ssh-mcp connectivity test, bypassing any agent / MCP client.
// Uses ssh-mcp's OWN config loader, credential resolver and SSH stack, so
// the result is exactly what the MCP server would see in this session.
//
// Usage:
//   node test-connection.mjs <bundlePath> [profileName] [--config=<path>]
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
console.log('profiles    :', config.profiles.map((p) => p.name).join(', ') || '(none)');

const profile = profileArg
  ? config.profiles.find((p) => p.name === profileArg)
  : config.profiles.find((p) => p.name === config.defaults.defaultProfile) || config.profiles[0];
if (!profile) {
  console.error('profile not found: ' + (profileArg || '(default)'));
  process.exit(1);
}

console.log('profile     :', profile.name);
console.log('target      :', profile.host + ':' + profile.port + ' as ' + profile.user);
console.log('auth        :', profile.auth + (profile.keychainEntry ? ' (' + profile.keychainEntry + ')' : ''));
if (profile.auth !== 'keychain') {
  console.log('NOTE        : auth is not "keychain" - a set-credential.ps1 entry is NOT used by this profile.');
}

// 2. Keychain diagnostics: direct read with the same library ssh-mcp uses.
const keyringAvailable = await initKeychain();
console.log('keyring     :', keyringAvailable ? 'available' : 'UNAVAILABLE in this process');
if (profile.auth === 'keychain') {
  try {
    const req = createRequire(path.join(bundlePath, 'package.json'));
    const keyring = req('@napi-rs/keyring');
    const [svc, acc] = (profile.keychainEntry || '').split('/');
    const stored = new keyring.Entry(svc || 'ssh-mcp', acc || profile.name).getPassword();
    console.log('keychain    :', stored == null ? 'entry NOT FOUND' : 'entry present (' + stored.length + ' chars)');
  } catch (e) {
    console.log('keychain    : READ FAILED - ' + (e && e.message ? e.message : e));
  }
}

// 3. Environment variable diagnostics (names and lengths only). A stale
// SSH_MCP_PASSWORD from earlier setx experiments is a classic override.
const envName =
  'SSH_MCP_' + profile.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_PASSWORD';
for (const name of [envName, 'SSH_MCP_PASSWORD']) {
  const v = process.env[name];
  console.log('env         :', name, v ? 'set (' + v.length + ' chars)' : 'not set');
}

// 4. Resolve credentials exactly like the server does.
let creds;
try {
  creds = await resolveCredentials(profile);
} catch (e) {
  console.error('CREDENTIALS FAILED: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
console.log(
  'resolved    : password=' + (creds.password ? creds.password.length + ' chars' : 'none') +
  ' privateKey=' + (creds.privateKey ? 'yes' : 'no') +
  ' agent=' + (creds.agentSocket ? 'yes' : 'no'),
);

// 5. Connect with ssh-mcp's own SSH stack (same algorithms, same everything).
console.log('connecting  : ...');
const conn = new SSHConnection(profile, creds, new Map(), 'tofu');
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('outer timeout (30s)')), 30000));
try {
  await Promise.race([conn.ensureConnected(), timeout]);
  console.log('RESULT      : CONNECTED as ' + profile.user + '@' + profile.host);
  console.log('Credential and server are fine in THIS process. If the agent still fails,');
  console.log('the difference is the agent process: its environment variables, its');
  console.log('ability to read Credential Manager, or which machine it runs on.');
  await conn.close().catch(() => {});
  process.exit(0);
} catch (e) {
  console.error('RESULT      : FAILED - ' + (e && e.message ? e.message : e));
  console.error('Compare this against the keychain/env lines above: the resolver offered');
  console.error('exactly what is listed there, and the server rejected it.');
  process.exit(1);
}
