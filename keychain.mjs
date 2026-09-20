#!/usr/bin/env node
// Credential helper for ssh-mcp's auth = "keychain" on Windows.
//
// Uses the SAME library ssh-mcp reads with (@napi-rs/keyring, from the
// offline bundle), so stored entries are compatible by construction.
//
// Usage:
//   node keychain.mjs <bundlePath> set <service> <account>     # secret on stdin
//   node keychain.mjs <bundlePath> set-from-env <service> <account> [VAR]  # secret from env var
//   node keychain.mjs <bundlePath> verify <service> <account>  # candidate on stdin
//   node keychain.mjs <bundlePath> test <service> <account>    # exists? no secret printed
//   node keychain.mjs <bundlePath> delete <service> <account>
//   node keychain.mjs <bundlePath> list [service]              # accounts only
//
// The secret arrives on stdin (one line) so it never appears in a process
// list or shell history.

import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const [bundlePath, cmd, service = 'ssh-mcp', account] = process.argv.slice(2);

function usage() {
  console.error('usage: node keychain.mjs <bundlePath> set <service> <account>    (secret on stdin)');
  console.error('       node keychain.mjs <bundlePath> set-from-env <service> <account> [VAR]');
  console.error('       node keychain.mjs <bundlePath> verify <service> <account> (candidate on stdin)');
  console.error('       node keychain.mjs <bundlePath> test <service> <account>');
  console.error('       node keychain.mjs <bundlePath> delete <service> <account>');
  console.error('       node keychain.mjs <bundlePath> list [service]');
  process.exit(2);
}

if (!bundlePath || !cmd) usage();

const require2 = createRequire(path.join(bundlePath, 'package.json'));
let keyring;
try {
  keyring = require2('@napi-rs/keyring');
} catch {
  console.error('Cannot load @napi-rs/keyring from: ' + bundlePath);
  console.error('Point the first argument at the extracted offline bundle -');
  console.error('the folder that contains package.json and node_modules.');
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

// Control characters (CR, LF, tab, ...) cannot be typed into any SSH password
// prompt. Their presence in a stored secret means corruption - almost always
// a paste artifact - and a one-character difference is enough to break auth
// while manual ssh (where you retype the real password) still works.
function controlChars(s) {
  const hits = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code === 127) hits.push({ pos: i + 1, code });
  }
  return hits;
}
function describe(hits) {
  return hits.map((h) => 'position ' + h.pos + ' (code ' + h.code + ')').join(', ');
}

// Leading/trailing whitespace on a stored secret is almost always an input
// artifact (paste, IME) and is invisible in a masked prompt - the exact bug
// where -Verify "passes" because BOTH entries carry the same stray space.
function whitespaceEnds(s) {
  const w = [];
  if (s.length && /\s/.test(s[0])) w.push('leading whitespace (code ' + s.charCodeAt(0) + ')');
  if (s.length > 1 && /\s/.test(s[s.length - 1])) w.push('trailing whitespace (code ' + s.charCodeAt(s.length - 1) + ')');
  return w;
}

try {
  switch (cmd) {
    case 'set': {
      if (!account) usage();
      const raw = await readStdin();
      const secret = raw.replace(/\r?\n$/, '');
      if (!secret) {
        console.error('Empty secret, nothing stored.');
        process.exit(1);
      }
      const fatal = controlChars(secret).filter((h) => h.code === 10 || h.code === 13);
      if (fatal.length) {
        console.error('Refused: the secret contains CR/LF at ' + describe(fatal) + '.');
        console.error('No real password contains these - they are paste artifacts.');
        console.error('Nothing was stored. Re-enter the password.');
        process.exit(1);
      }
      new keyring.Entry(service, account).setPassword(secret);
      const back = new keyring.Entry(service, account).getPassword();
      if (back !== secret) {
        console.error('Stored but read-back verification failed.');
        process.exit(1);
      }
      console.log('Stored ' + service + '/' + account + ' (' + secret.length + ' chars, verified).');
      console.log('Check that length against the real password before moving on.');
      const warn = controlChars(secret);
      if (warn.length) {
        console.log('WARNING: control character(s) at ' + describe(warn) + ' - verify this is intended.');
      }
      const ws = whitespaceEnds(secret);
      if (ws.length) {
        console.log('WARNING: ' + ws.join(' and ') + ' - almost certainly an input artifact.');
        console.log('Re-store from a known-good env var: set-credential.ps1 -Account ' + account + ' -FromEnv SSH_MCP_PASSWORD');
      }
      break;
    }
    case 'set-from-env': {
      if (!account) usage();
      const varName = process.argv[6] || 'SSH_MCP_PASSWORD';
      const secret = process.env[varName];
      if (!secret) {
        console.error('Environment variable ' + varName + ' is not set in this process.');
        console.error('Set it for this session first:  $env:' + varName + " = 'the-password'");
        console.error('(setx-set user variables are NOT visible to an already-open window; use a new window.)');
        process.exit(1);
      }
      const fatalEnv = controlChars(secret).filter((h) => h.code === 10 || h.code === 13);
      if (fatalEnv.length) {
        console.error('Refused: ' + varName + ' contains CR/LF at ' + describe(fatalEnv) + '. Nothing was stored.');
        process.exit(1);
      }
      new keyring.Entry(service, account).setPassword(secret);
      const backEnv = new keyring.Entry(service, account).getPassword();
      if (backEnv !== secret) {
        console.error('Stored but read-back verification failed.');
        process.exit(1);
      }
      console.log('Stored ' + service + '/' + account + ' from ' + varName + ' (' + secret.length + ' chars, verified).');
      const wsEnv = whitespaceEnds(secret);
      if (wsEnv.length) {
        console.log('WARNING: ' + wsEnv.join(' and ') + ' - the env var itself carries whitespace.');
      }
      break;
    }
    case 'verify': {
      if (!account) usage();
      const stored = new keyring.Entry(service, account).getPassword();
      const candidate = (await readStdin()).replace(/\r?\n$/, '');
      if (stored == null) {
        console.log(service + '/' + account + ': NOT FOUND');
        process.exit(1);
      }
      if (stored === candidate) {
        console.log('MATCH: the stored entry is exactly what you just entered (' + stored.length + ' chars).');
        break;
      }
      console.log('MISMATCH: stored entry is ' + stored.length + ' chars, you entered ' + candidate.length + ' chars.');
      const hits = controlChars(stored);
      if (hits.length) {
        console.log('The STORED value contains control character(s) at ' + describe(hits) + ' - almost certainly a paste artifact.');
      }
      const wsV = whitespaceEnds(stored);
      if (wsV.length) {
        console.log('The STORED value has ' + wsV.join(' and ') + ' - invisible in the masked prompt.');
        console.log('Re-store from a known-good env var: set-credential.ps1 -Account ' + account + ' -FromEnv SSH_MCP_PASSWORD');
      }
      console.log('Re-store the password: set-credential.ps1 -Account ' + account);
      process.exit(1);
    }
    case 'test': {
      if (!account) usage();
      const pw = new keyring.Entry(service, account).getPassword();
      if (pw == null) {
        console.log(service + '/' + account + ': NOT FOUND');
        process.exit(1);
      }
      console.log(service + '/' + account + ': present (' + pw.length + ' chars)');
      const hits = controlChars(pw);
      if (hits.length) {
        console.log('  WARNING: control character(s) at ' + describe(hits) + ' - a real password');
        console.log('  cannot contain these. This entry is corrupt; re-store the password.');
        process.exit(1);
      }
      const wsT = whitespaceEnds(pw);
      if (wsT.length) {
        console.log('  WARNING: ' + wsT.join(' and ') + ' - invisible in the masked prompt, and');
        console.log('  exactly the kind of stray character that makes -Verify "pass" while auth fails.');
        console.log('  Re-store from a known-good env var: set-credential.ps1 -Account ' + account + ' -FromEnv SSH_MCP_PASSWORD');
        process.exit(1);
      }
      break;
    }
    case 'delete': {
      if (!account) usage();
      const ok = new keyring.Entry(service, account).deleteCredential();
      console.log(ok ? 'Deleted ' + service + '/' + account + '.' : service + '/' + account + ': nothing to delete.');
      break;
    }
    case 'list': {
      const creds = keyring.findCredentials(service);
      if (!creds.length) {
        console.log('No entries under service "' + service + '".');
        break;
      }
      console.log('Entries under service "' + service + '":');
      for (const c of creds) console.log('  ' + service + '/' + c.account);
      break;
    }
    default:
      usage();
  }
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exit(1);
}



