#!/usr/bin/env node
// Credential helper for ssh-mcp's auth = "keychain" on Windows.
//
// Uses the SAME library ssh-mcp reads with (@napi-rs/keyring, from the
// offline bundle), so stored entries are compatible by construction.
//
// Usage:
//   node keychain.mjs <bundlePath> set <service> <account>   # secret on stdin
//   node keychain.mjs <bundlePath> test <service> <account>  # exists? no secret printed
//   node keychain.mjs <bundlePath> delete <service> <account>
//   node keychain.mjs <bundlePath> list [service]            # accounts only
//
// The secret arrives on stdin (one line) so it never appears in a process
// list or shell history.

import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const [bundlePath, cmd, service = 'ssh-mcp', account] = process.argv.slice(2);

function usage() {
  console.error('usage: node keychain.mjs <bundlePath> set <service> <account>   (secret on stdin)');
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
      new keyring.Entry(service, account).setPassword(secret);
      const back = new keyring.Entry(service, account).getPassword();
      if (back !== secret) {
        console.error('Stored but read-back verification failed.');
        process.exit(1);
      }
      console.log('Stored ' + service + '/' + account + ' (' + secret.length + ' chars, verified).');
      break;
    }
    case 'test': {
      if (!account) usage();
      const pw = new keyring.Entry(service, account).getPassword();
      if (pw == null) {
        console.log(service + '/' + account + ': NOT FOUND');
        process.exit(1);
      }
      console.log(service + '/' + account + ': present (' + pw.length + ' chars)');
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
