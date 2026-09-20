#!/usr/bin/env node
// ssh-mcp-tool - unified helper for ssh-mcp on Windows.
//
// Two jobs, one tool:
//   1. Credential management in Windows Credential Manager, compatible with
//      ssh-mcp's auth = "keychain" (same @napi-rs/keyring library).
//   2. Connection testing with ssh-mcp's own loader/resolver/SSH stack,
//      bypassing any agent or MCP client entirely.
//
// Commands (engine level; ssh-mcp-tool.ps1 is the friendly face):
//   set <account> [--service=S]                 secret on stdin (one line)
//   set-from-env <account> [VAR] [--service=S]  secret from an env var
//   verify <account> [--service=S]              candidate on stdin
//   check <account> [--service=S]
//   delete <account> [--service=S]
//   list [--service=S]
//   connect [profile] [--config=PATH]           all profiles if none named
//
// Exit codes: 0 = ok, 1 = operation failed, 2 = usage error.
// Prints names, booleans and lengths only - never a secret.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const FAIL = 1;
const USAGE = 2;

const USAGE_TEXT = [
  'usage: node ssh-mcp-tool.mjs <bundlePath> <command> [args] [--service=S] [--config=PATH]',
  '',
  'commands:',
  '  set <account>                 store the secret read from stdin',
  '  set-from-env <account> [VAR]  store from an env var (default SSH_MCP_PASSWORD)',
  '  verify <account>              compare the stdin candidate with the stored entry',
  '  check <account>               entry present? length? stray characters?',
  '  delete <account>',
  '  list                          entries under the service (names only)',
  '  connect [profile]             test all profiles, or one',
].join('\n');

function usageExit() {
  console.error(USAGE_TEXT);
  process.exit(USAGE);
}

// ---------- argv ----------

const rawArgs = process.argv.slice(2);
const flags = rawArgs.filter((a) => a.startsWith('--'));
const plain = rawArgs.filter((a) => !a.startsWith('--'));
const bundlePath = plain.shift();
const command = plain.shift();
const rest = plain;

const opt = {};
for (const f of flags) {
  const eq = f.indexOf('=');
  if (eq === -1) opt[f.slice(2)] = true;
  else opt[f.slice(2, eq)] = f.slice(eq + 1);
}

if (!bundlePath || !command) usageExit();
const service = opt.service || 'ssh-mcp';

// ---------- shared helpers ----------

const msg = (e) => (e && e.message ? e.message : String(e));
const envNameFor = (profileName) =>
  'SSH_MCP_' + profileName.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_PASSWORD';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

// Control characters cannot be typed into any SSH password prompt, so their
// presence means corruption. CR/LF (10/13) are fatal. Other control chars and
// leading/trailing whitespace are warnings: a password can theoretically
// contain a space, but a STRAY one is invisible in the masked prompt - which
// is exactly how "verify passes but auth keeps failing" happens.
function controlChars(s) {
  const hits = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code === 127) hits.push({ pos: i + 1, code });
  }
  return hits;
}
const describeHits = (hits) =>
  hits.map((h) => 'position ' + h.pos + ' (code ' + h.code + ')').join(', ');

function whitespaceEnds(s) {
  const w = [];
  if (s.length && /\s/.test(s[0])) w.push('leading whitespace (code ' + s.charCodeAt(0) + ')');
  if (s.length > 1 && /\s/.test(s[s.length - 1])) w.push('trailing whitespace (code ' + s.charCodeAt(s.length - 1) + ')');
  return w;
}

function fatalSecretProblem(s) {
  if (!s) return 'the secret is empty';
  const crlf = controlChars(s).filter((h) => h.code === 10 || h.code === 13);
  if (crlf.length) {
    return 'the secret contains CR/LF at ' + describeHits(crlf) +
      ' - no real password contains these, they are paste artifacts';
  }
  return null;
}

function secretWarnings(s) {
  const w = [];
  const other = controlChars(s).filter((h) => h.code !== 10 && h.code !== 13);
  if (other.length) w.push('control character(s) at ' + describeHits(other));
  w.push(...whitespaceEnds(s));
  return w;
}

function storedProblems(s) {
  const problems = [];
  const ctrl = controlChars(s);
  if (ctrl.length) problems.push('control character(s) at ' + describeHits(ctrl));
  problems.push(...whitespaceEnds(s));
  return problems;
}

// ---------- keyring ----------

const require2 = createRequire(path.join(bundlePath, 'package.json'));
let keyring;
try {
  keyring = require2('@napi-rs/keyring');
} catch {
  console.error('ERROR: cannot load @napi-rs/keyring from: ' + bundlePath);
  console.error('       point the first argument at the extracted offline bundle');
  process.exit(FAIL);
}

function readStored(svc, account) {
  try {
    return new keyring.Entry(svc, account).getPassword();
  } catch (e) {
    throw new Error('Credential Manager read failed: ' + msg(e));
  }
}

function storeSecret(account, secret, source) {
  const fatal = fatalSecretProblem(secret);
  if (fatal) {
    console.error('ERROR: refused - ' + fatal + '. Nothing was stored.');
    process.exit(FAIL);
  }
  new keyring.Entry(service, account).setPassword(secret);
  const back = readStored(service, account);
  if (back !== secret) {
    console.error('ERROR: stored, but the read-back verification failed.');
    process.exit(FAIL);
  }
  console.log('Stored ' + service + '/' + account + ' from ' + source + ' (' + secret.length + ' chars, verified).');
  console.log('Check that length against the real password before moving on.');
  for (const w of secretWarnings(secret)) {
    console.log('WARNING: ' + w + ' - almost certainly an input artifact.');
    console.log('         re-store with: ssh-mcp-tool.ps1 Set ' + account + ' -FromEnv SSH_MCP_PASSWORD');
  }
}

// ---------- credential commands ----------

async function cmdSet(account) {
  if (!account) usageExit();
  const raw = await readStdin();
  storeSecret(account, raw.replace(/\r?\n$/, ''), 'stdin');
}

function cmdSetFromEnv(account, varName) {
  if (!account) usageExit();
  const name = varName || 'SSH_MCP_PASSWORD';
  const secret = process.env[name];
  if (!secret) {
    console.error('ERROR: environment variable ' + name + ' is not set in this process.');
    console.error('       set it for this session first:  $env:' + name + " = 'the-password'");
    console.error('       (setx-set user variables are NOT visible to an already-open window)');
    process.exit(FAIL);
  }
  storeSecret(account, secret, name);
}

async function cmdVerify(account) {
  if (!account) usageExit();
  const stored = readStored(service, account);
  const candidate = (await readStdin()).replace(/\r?\n$/, '');
  if (stored == null) {
    console.log(service + '/' + account + ': NOT FOUND');
    process.exit(FAIL);
  }
  if (stored === candidate) {
    console.log('MATCH: the stored entry is exactly what you just entered (' + stored.length + ' chars).');
    return;
  }
  console.log('MISMATCH: stored entry is ' + stored.length + ' chars, you entered ' + candidate.length + ' chars.');
  const problems = storedProblems(stored);
  if (problems.length) {
    console.log('The STORED value has ' + problems.join('; ') + ' - invisible in the masked prompt.');
  }
  console.log('Re-store with: ssh-mcp-tool.ps1 Set ' + account + ' -FromEnv SSH_MCP_PASSWORD');
  process.exit(FAIL);
}

function cmdCheck(account) {
  if (!account) usageExit();
  const stored = readStored(service, account);
  if (stored == null) {
    console.log(service + '/' + account + ': NOT FOUND');
    process.exit(FAIL);
  }
  console.log(service + '/' + account + ': present (' + stored.length + ' chars)');
  const problems = storedProblems(stored);
  if (problems.length) {
    console.log('  WARNING: ' + problems.join('; ') + ' - invisible in the masked');
    console.log('  prompt, and exactly how "verify passes but auth fails" happens.');
    console.log('  Re-store with: ssh-mcp-tool.ps1 Set ' + account + ' -FromEnv SSH_MCP_PASSWORD');
    process.exit(FAIL);
  }
}

function cmdDelete(account) {
  if (!account) usageExit();
  const ok = new keyring.Entry(service, account).deleteCredential();
  console.log(ok ? 'Deleted ' + service + '/' + account + '.' : service + '/' + account + ': nothing to delete.');
}

function cmdList() {
  const creds = keyring.findCredentials(service);
  if (!creds.length) {
    console.log('No entries under service "' + service + '".');
    return;
  }
  console.log('Entries under service "' + service + '":');
  for (const c of creds) console.log('  ' + service + '/' + c.account);
}

// ---------- connect ----------

const withTimeout = (p, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' outer timeout (30s)')), 30000)),
  ]);

async function cmdConnect(profileName, configPath) {
  const base = (p) =>
    pathToFileURL(path.join(bundlePath, 'node_modules', 'ssh-mcp', 'build', p)).href;
  let loadConfig, getConfigPath, initKeychain, resolveCredentials, SSHConnection;
  try {
    ({ loadConfig, getConfigPath } = await import(base('config/loader.js')));
    ({ initKeychain, resolveCredentials } = await import(base('config/credential-resolver.js')));
    ({ SSHConnection } = await import(base('ssh/connection.js')));
  } catch (e) {
    console.error('ERROR: cannot load ssh-mcp from the bundle: ' + msg(e));
    process.exit(FAIL);
  }

  let config;
  try {
    config = await loadConfig(configPath, {
      enforce: false,
      allowUnchecked: true,
      onFinding: (f) => console.error('ACL warning: ' + f.message),
    });
  } catch (e) {
    console.error('CONFIG FAILED: ' + msg(e));
    if (!configPath) console.error('(looked at the default location: ' + getConfigPath() + ')');
    process.exit(FAIL);
  }

  console.log('config path :', configPath || getConfigPath());
  if (!config.profiles.length) {
    console.error('No profiles configured.');
    process.exit(FAIL);
  }
  console.log('profiles    :', config.profiles.map((p) => p.name).join(', '));

  const keyringAvailable = await initKeychain();
  console.log('keyring     :', keyringAvailable ? 'available' : 'UNAVAILABLE in this process');

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
      console.log('NOTE        : auth is not "keychain" - a stored entry is NOT used by this profile.');
    }

    if (profile.auth === 'keychain') {
      try {
        const [svc, acc] = (profile.keychainEntry || '').split('/');
        const stored = readStored(svc || 'ssh-mcp', acc || profile.name);
        console.log('keychain    :', stored == null ? 'entry NOT FOUND' : 'entry present (' + stored.length + ' chars)');
      } catch (e) {
        console.log('keychain    : READ FAILED - ' + msg(e));
      }
    }

    for (const name of [envNameFor(profile.name), 'SSH_MCP_PASSWORD']) {
      const v = process.env[name];
      console.log('env         :', name, v ? 'set (' + v.length + ' chars)' : 'not set');
    }

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

  let targets;
  if (profileName) {
    const one = config.profiles.find((p) => p.name === profileName);
    if (!one) {
      console.error('profile not found: ' + profileName + ' (available: ' + config.profiles.map((p) => p.name).join(', ') + ')');
      process.exit(FAIL);
    }
    targets = [one];
  } else {
    targets = config.profiles;
  }

  const results = [];
  for (const p of targets) {
    results.push(await testProfile(p));
  }

  if (results.length > 1 || !profileName) {
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
  process.exit(failed.length ? FAIL : 0);
}

// ---------- dispatch ----------

try {
  switch (command) {
    case 'set': await cmdSet(rest[0]); break;
    case 'set-from-env': cmdSetFromEnv(rest[0], rest[1]); break;
    case 'verify': await cmdVerify(rest[0]); break;
    case 'check': cmdCheck(rest[0]); break;
    case 'delete': cmdDelete(rest[0]); break;
    case 'list': cmdList(); break;
    case 'connect': await cmdConnect(rest[0], opt.config); break;
    default:
      console.error('ERROR: unknown command: ' + command);
      usageExit();
  }
} catch (e) {
  console.error('ERROR: ' + msg(e));
  process.exit(FAIL);
}
