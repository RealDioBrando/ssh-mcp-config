# ssh-mcp-config

Personal config for [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp) v2.9.0,
for a single agent working on a **shared server as root** - an accepted-risk setup,
made as safe as that constraint allows without changing anything on the server.

Primary target: a **Claude Code-based company agent** (see `claude-code/`).
Secondary: Codex (see `codex-mcp-snippet.toml`). The ssh-mcp server config
(`config.example.toml`) is identical for both.

## Where does each detail go?

| Your detail | Goes in | Example |
|---|---|---|
| Server IP / hostname | `host` in the profile | `host = "192.168.1.100"` |
| SSH username | `user` in the profile | `user = "root"` |
| Password | **Nowhere in the config.** `.\set-credential.ps1 -Account server` stores it once (masked) in Windows Credential Manager; the profile's `keychainEntry = "ssh-mcp/server"` reads it | - |
| Project folder on the server | `workdir` in the profile | `workdir = "/root/project"` |
| Private key path (only for `auth = "key"`) | `keyRef` in the profile | `keyRef = "~/.ssh/id_ed25519"` |

Three steps total: run the helper once per server (or
`-Batch -Accounts server,gpu-01` for many), fill `host` / `user` / `workdir`
per profile, done. Passwords never touch any file. The name of the profile
must match the helper's `-Account` name, and `keychainEntry` is always
`"ssh-mcp/<that name>"`.
## Accepted risk, and what compensates

| Accepted | Compensating control |
|---|---|
| Root SSH user (can't create a scoped account) | `ask-destructive`: every destructive command stops for a human |
| No snapshots on the shared server | denylist for never-ok actions + audit log of everything that ran |
| Shared box with coworkers | `shutdown`/`reboot`/force-push hard-denied; output and length caps |
| Single agent, lazy operator | 5-minute approval grants so identical commands don't re-prompt |
| LLM + SSH (prompt injection) | client-side tool allow/deny lists on top of ssh-mcp's own policy |

The biggest safety win costs nothing: **the agent edits code and scripts locally on
Windows** (diff visible), syncs with your existing VS Code SFTP, and only reaches the
server to run, inspect and debug. The SSH surface stays small.

## What prompts you vs. what just runs

With `role = "operator"`, `group = "dev"`, `approvalPolicy = "ask-destructive"`:

| Action | Class | Behavior |
|---|---|---|
| `nvidia-smi`, `ps`, `tail log`, `docker ps` | read-only / safe | runs, no prompt |
| `./build.sh`, `make`, `python train.py` | safe | runs, no prompt |
| `rm -rf build/`, `kill`, `chmod -R` | destructive | **ssh-mcp approval prompt** |
| `sudo ...` | privileged | **denied** (operator role; root doesn't need sudo) |
| `shutdown`, `reboot`, `git push --force` | denylist | **denied, no prompt possible** |

Note the split: the denylist is for *never*; the approval gate is for
*routine-but-risky* (cleaning a build dir, killing a job). That is why `rm -rf` is
NOT in the denylist - it would make normal cleanup impossible instead of reviewed.

## Multiple servers and password auth

**Multiple servers:** yes - each `[[profiles]]` block is one server, with its own
`role` / `group` / `approvalPolicy`, so trust can differ per machine (a build box
can be `operator`/`dev` while a database host is `viewer`/`prod`, read-only). The
agent selects with the `profile` tool argument; `defaults.defaultProfile` is used
when it doesn't. `via = "profile-name"` chains through a bastion. See the
commented examples in `config.example.toml`.

**Password auth:** yes - `auth = "password"` on the profile, but the password
itself never goes in the config file or on the command line. It comes from an
environment variable:

- `SSH_MCP_<PROFILE>_PASSWORD` - per profile. Non-alphanumerics become
  underscores: profile `server` -> `SSH_MCP_SERVER_PASSWORD`, `gpu-01` ->
  `SSH_MCP_GPU_01_PASSWORD`.
- `SSH_MCP_PASSWORD` - generic fallback for all profiles.

On Windows: `setx SSH_MCP_SERVER_PASSWORD "..."` once, then restart the agent so
the MCP server process inherits it - that keeps the secret out of every config
file. (Alternative: `auth = "keychain"` + `keychainEntry` uses Windows
Credential Manager via the optional `@napi-rs/keyring` dependency.)

## Storing passwords: setx vs Windows Credential Manager

Neither option "converts" the password - it is stored exactly as typed. The
difference is only **where it lives and who can read it**:

| | `setx` env var | Credential Manager (`auth = "keychain"`) |
|---|---|---|
| Where | Registry (`HKCU\Environment`) | OS-managed secret store |
| Who reads it | Every process you start inherits it | Only a program that explicitly asks for that named entry |
| Per-server | One oddly-named var per server (`SSH_MCP_GPU_01_PASSWORD`) | One named entry per server (`ssh-mcp/gpu-01`) |
| In any file? | No | No |

For a bunch of servers, Credential Manager is the tidier fit - and
`set-credential.ps1` manages it:

    .\set-credential.ps1 -Account gpu-01     # masked prompt -> stores ssh-mcp/gpu-01, verifies, prints config lines
    .\set-credential.ps1 -Account gpu-01 -Test
    .\set-credential.ps1 -Account gpu-01 -Verify   # re-enter, compare with stored (MATCH/MISMATCH)
    .\set-credential.ps1 -Account gpu-01 -FromEnv SSH_MCP_PASSWORD   # store from env var, no typing
    .\set-credential.ps1 -Account gpu-01 -Delete
    .\set-credential.ps1 -List               # all ssh-mcp/* entries (names only)
    .\set-credential.ps1 -Batch -Accounts gpu-01,gpu-02,web-1
    .\set-credential.ps1 -Batch -AccountList C:\tools\server-names.txt

Defaults: service `ssh-mcp`, bundle at `C:\tools\ssh-mcp-offline` (override
with `-BundlePath`). The password is passed to node via stdin - never a
command-line argument - and the helper uses the same `@napi-rs/keyring`
library from the bundle that ssh-mcp reads with. Verified end-to-end: a
credential stored by the helper was read back by ssh-mcp's own
`resolveCredentials()`.

### Batch mode (many servers, one run)

Both batch forms take **names only** - never passwords. The script validates
every name first (no whitespace, `/` or `\`, because a typo'd name would
silently store the credential under the wrong name), then prompts for each
password with masked input, one after another. Ctrl+C mid-batch is safe:
entries already stored stay stored.

**Do not prepare a list of passwords.** A `server,password` file recreates the
plaintext-on-disk problem the keychain exists to solve - and deleting such a
file is not reliable (recycle bin, SSD wear-leveling, editor history, sync
folders, backups). Names in a file; secrets at the prompt.

### Persistence

Everything here is one-time setup:

- Credential Manager entries survive reboots, logouts and agent restarts.
- `config.toml` profiles are a plain file, read at server startup.
- `setx` env vars live in the registry (`HKCU\Environment`).

The only ephemeral thing is the SSH connection itself (closed when idle,
reopened using the stored credential). Re-run the helper for a single account
only when that server's password changes - storing again overwrites the entry.

Then the profile:

    [[profiles]]
    name = "gpu-01"
    auth = "keychain"
    keychainEntry = "ssh-mcp/gpu-01"
    # no keyRef here: with keychain auth, keyRef means the entry holds a
    # private key, not a password

Why this fits a shared all-root server: password auth needs zero changes on
the server - no authorized_keys edits, no risk of touching coworkers' keys,
one helper command per server.
## What role/group already covers vs. the extra [policy] block

`role` + `group` + `approvalPolicy` are the main machinery:

1. **role x group** (the RBAC matrix) decides which command *classes* may run at
   all - `operator` on `dev` allows read-only + safe + destructive, denies
   privileged (sudo).
2. **approvalPolicy** decides what happens to an allowed-but-dangerous class:
   `ask-destructive` prompts you before destructive commands run.
3. ssh-mcp's **built-in never-allowed list** (`rm -rf /`, `mkfs`, fork bombs,
   `chmod -R 777 /`, writing `authorized_keys`, `iptables -F`, ...) always
   applies and cannot be switched off by any config.

The `[policy]` section is purely additional: `denylist` adds *your* never-allow
rules on top (here: `shutdown`/`reboot`/force-push on a shared box - without the
list they would merely classify as destructive and prompt you). `roleBindings`
would reshape the RBAC matrix itself; the defaults fit, so it is not used.
Delete the whole `[policy]` block and the setup still works - you just lose the
hard denials.
## Offline install (no npm access)

The repo ships a prebuilt bundle: `ssh-mcp-2.9.0-win-x64-offline.zip` (~22 MB) -
ssh-mcp v2.9.0 plus all production dependencies, installed from npm on Windows
x64 and round-trip verified (extract -> `--dumpToolHashes` -> 14 tools, exit 0).

1. `git clone https://github.com/RealDioBrando/ssh-mcp-config` (or download the zip).
2. Extract `ssh-mcp-2.9.0-win-x64-offline.zip` to e.g. `C:\tools\ssh-mcp-offline`.
3. Verify: `node C:\tools\ssh-mcp-offline\node_modules\ssh-mcp\build\index.js --dumpToolHashes`
   - needs Node.js >= 20.6 on PATH, the only requirement.
4. Put your config at `%APPDATA%\ssh-mcp\config.toml` (copy `config.example.toml`,
   fill the `<-- FILL` lines). That location has the restrictive ACL ssh-mcp
   requires for credential files.
5. Register with your agent using `claude-code/mcp-offline.json` instead of
   `claude-code/mcp.json`. The permission rules in `claude-code/settings.json`
   are unchanged - same tool names either way.

The bundle includes Windows Credential Manager support (`@napi-rs/keyring`) and
the exact `package-lock.json` of what was installed. `ssh2` runs in pure-JS mode
(its optional native bindings were not built) - fully functional. Windows x64
target; most contents are pure JS but the keyring binary is platform-specific.
## Updating the bundle

On a machine WITH npm access (e.g. your personal machine), run:

    .\pack-offline.ps1 -Version 2.9.1

The script installs the pinned version into a fresh staging folder (never
`npm update` in place - a fresh tree cannot carry stale dependencies), runs
the smoke test itself, and writes `ssh-mcp-<version>-win-x64-offline.zip`
next to itself. Remove the old zip from the repo, commit, push.

On the work machine:

1. `git pull`
2. Delete the old extracted folder (e.g. `C:\tools\ssh-mcp-offline`) and
   extract the new zip to the same path. Always extract clean - overlaying a
   new zip on an old folder leaves orphaned files from the previous
   dependency tree.
3. Nothing else changes: your config lives at `%APPDATA%\ssh-mcp\config.toml`,
   outside the bundle, so an update never touches credentials, and the agent's
   mcp.json keeps pointing at the same path.
4. Restart the agent - MCP servers are spawned at startup.
5. Smoke test again (below).

## The smoke test, explained

`--dumpToolHashes` is a built-in flag of ssh-mcp itself - not something you
have to write. It loads the entire program, which means every module and every
dependency in the bundle must resolve, then prints a JSON table of the 14 MCP
tools and exits. Open PowerShell on the work machine and run:

    node C:\tools\ssh-mcp-offline\node_modules\ssh-mcp\build\index.js --dumpToolHashes

Expected output (v2.9.0): 14 tool entries, then exit code 0:

    {
      "list-connections": "1cd9da668b3b3c2f",
      "list-sessions": "91f5bb270c4bb1ed",
      ...
      "signal-process": "2f40c610b52c05f9"
    }

- **What it proves:** the bundle is complete and runnable - Node found and
  loaded everything. No server, no SSH connection, no config needed.
- **What it does not prove:** that the SSH connection or credentials work.
  The end-to-end test happens through your agent: ask it to call
  `list-connections`, then `read-command "hostname"`.
- Each value is the SHA-256 of that tool's description (first 16 hex chars) -
  diffing them between versions tells you whether the agent-visible tool
  behavior changed.
## Troubleshooting: startup and connection errors

**`--config needs a path: --config=<path>`** - ssh-mcp's argument parser only
accepts the `--flag=value` form, as a single argument. `"--config", "C:/path"`
(two array elements) does NOT work; use one element:
`"--config=C:/path/config.toml"`. This is ssh-mcp's parser, not your agent's.
Better still: put the config at the default location
`%APPDATA%\ssh-mcp\config.toml` and drop `--config` entirely.

**`Config file ... can be modified by accounts other than its owner`** -
ssh-mcp's Windows ACL check (also ssh-mcp's behavior, not your agent's). The
config names your servers and decides what the agent may do, so ssh-mcp
refuses to run from a file - or a folder - that other local accounts can read
or modify. A config on `D:\` inherits broad ACLs (Users, Authenticated Users)
and fails this check.

Fix, easiest first:

1. Move the config to `%APPDATA%\ssh-mcp\config.toml` (create the folder
   with `mkdir $env:APPDATA\ssh-mcp`). User-profile folders already have the
   restricted ACL ssh-mcp requires, and the default location also removes
   the need for `--config` at all.
2. Or keep your location and run the two `icacls` commands ssh-mcp prints -
   on BOTH the config file and the folder containing it (both are checked).
   On a drive outside your user profile, stripping broad entries from the
   folder can affect other users of the machine, which is why option 1 is
   recommended.
**`SSH connection error: All configured authentication methods failed`** -
the TCP connection and SSH handshake SUCCEEDED (host and port are right),
and a credential WAS found and offered - a keychain miss gives a different
error (`No credentials resolved`). The server rejected what was offered.
Check in this order:

1. Sanity-check the stored entry: `.\set-credential.ps1 -Account server -Test`
   - "present (N chars)": does N match the real password's length? A
   ONE-character difference is enough to break auth while manual ssh (where
   you retype the real password) still works. The command also fails loudly
   if the stored value contains control characters, such as a stray
   carriage return from pasting.
2. Re-store, then prove it: `.\set-credential.ps1 -Account server` - watch
   the printed char count - then `.\set-credential.ps1 -Account server
   -Verify` to re-enter and compare. It must print MATCH before you retry
   the connection. (Storing refuses CR/LF outright; no real password
   contains them.)
4. Check `user` in the profile - exact and case-sensitive (`root` is not
   `Root` on Linux).
5. Shortcut: your VS Code SFTP already reaches this server. Open its
   `sftp.json` and see whether it uses a password or a key - then mirror
   that in the ssh-mcp profile.
6. Try the same user and password with plain OpenSSH in PowerShell:
   `ssh root@<host>`. If it also fails, the problem is the credentials or
   the server, not ssh-mcp. If it logs in WITHOUT prompting for a password,
   a default key in `~/.ssh` works - use `auth = "key"` on the profile.
7. On the server (via whatever access you already have), check what sshd
   allows and what it logged:

       sudo sshd -T | grep -Ei 'permitrootlogin|passwordauthentication|kbdinteractive|allowusers'
       sudo journalctl -u ssh -n 50 --no-pager    # or: sudo tail -50 /var/log/auth.log

   The most common cause on shared servers: `permitrootlogin
   prohibit-password` - the OpenSSH DEFAULT - root may use keys but never
   passwords, so even the correct root password fails.
8. ssh-mcp offers password and publickey auth only; it does not do
   keyboard-interactive (PAM) prompts. If plain `ssh` works with the
   password but ssh-mcp does not, the server is probably
   keyboard-interactive-only - use key auth in that case.

### Temporary env-var bypass (debug only)

When keychain debugging stalls, take the keychain out of the picture entirely:

1. In `%APPDATA%\ssh-mcp\config.toml`, change the profile's
   `auth = "keychain"` to `auth = "password"` (one line; `keychainEntry`
   is simply ignored now).
2. Give ssh-mcp the password via `SSH_MCP_PASSWORD` (the generic name works
   for every profile - no name-mapping mistakes):
   - Agent-scoped (recommended): add an `env` block to the ssh-mcp entry in
     the agent's MCP config. The password sits in that file temporarily -
     remove it afterwards.
   - User-wide: `[Environment]::SetEnvironmentVariable('SSH_MCP_PASSWORD','<pw>','User')`
     then FULLY restart the agent so it inherits the new value.
3. Restart the agent and test.
4. Session-only check, no agent involved (truly temporary - gone when the
   window closes):

       $env:SSH_MCP_PASSWORD = '<pw>'
       .\test-connection.ps1

5. Revert afterwards: remove the env block (or
   `[Environment]::SetEnvironmentVariable('SSH_MCP_PASSWORD',$null,'User')`)
   and set `auth` back to `"keychain"`.

Once the env var is PROVEN good (test-connection connects with it), bake it
into the keychain with no typing, paste or IME involved:

    .\set-credential.ps1 -Account server -FromEnv SSH_MCP_PASSWORD
    .\set-credential.ps1 -Account server -Test     # length must equal the env var's

then set `auth = "keychain"` back in the config, remove the env block/var,
and restart the agent.

Why this can be needed: a masked prompt can consistently add one invisible
character (a trailing space, an IME artifact). `-Verify` then prints MATCH
because BOTH entries carry the same stray character - it proves consistency,
not correctness. `-Test` and `-Verify` now fail loudly when the stored value
has leading/trailing whitespace, naming the exact culprit (e.g. "trailing
whitespace (code 32)").

If even this fails with the same error, the password itself is being rejected
in the ssh2 path - run `ssh -v root@<host>` and check WHICH method actually
succeeds (`Offering public key` vs `password`); interactive ssh may be quietly
using a key.
If root is key-only on the server, switch the profile to key auth:
`ssh-keygen -t ed25519` on Windows, append the new `~/.ssh/id_ed25519.pub`
to the server's `/root/.ssh/authorized_keys` (appending one line is
additive - it does not disturb anyone else's keys), then set
`auth = "key"` and `keyRef = "~/.ssh/id_ed25519"`.
## Claude Code setup

1. Create the config folder and file (PowerShell):
   `mkdir $env:APPDATA\ssh-mcp -Force`, then copy `config.example.toml` there
   as `config.toml` and fill in the three `<-- FILL` lines: host, user,
   workdir. Store the password once with `.\set-credential.ps1 -Account server`
   (or `-Batch -Accounts server,gpu-01` for many servers) - it never goes in
   the config file.
2. Register the MCP server: merge `claude-code/mcp.json` into your project's
   `.mcp.json` (or `~/.claude.json`), or run:
   `claude mcp add ssh-mcp -- npx ssh-mcp`
   No `--config` is needed at the default location. On Windows, if `npx`
   fails to spawn, use `"command": "cmd"` with `"args": ["/c", "npx", "ssh-mcp"]`.
3. Merge `claude-code/settings.json` into your settings (`.claude/settings.local.json`
   or `~/.claude/settings.json`).

### How the approval gate reaches you in Claude Code

ssh-mcp's destructive-command approvals arrive as **MCP elicitation** requests.
In Claude Code (verified against a March 2026 source snapshot):

- Interactively, they render as an **Accept/Decline dialog** (`ElicitationDialog`).
- **Elicitation hooks** can answer programmatically - that is Claude Code's only
  "approve for me" equivalent, and it is rule-based, not an AI reviewer.
- On any error, abort, or headless run with nothing attached to answer,
  the response is **cancel/decline - the command is refused, never auto-approved.**

### IMPORTANT: test your company agent first

Your agent is a customized fork, newer than the public snapshot. Before relying on
the approval gate, run this one-line test:

```
run-command "rm -rf /tmp/ssh-mcp-approval-test"
```

- An approval dialog appears -> the gate works. Decline it; nothing ran.
- You get `APPROVAL_UNAVAILABLE` -> your agent does not surface elicitations.
  Every destructive command will be **refused** (fail-closed, not silently run).
  Your options then: have the agent surface elicitations, add an Elicitation hook,
  or keep the agent on read-only/safe work and do destructive steps yourself.

### Tool restriction (Claude Code)

Claude Code has no per-server structural tool allow-list like Codex's
`enabled_tools`. The equivalent is `permissions.deny` rules:

- `allow`: the 9 workflow tools (inspection, sessions, run-command, signal-process,
  sftp-upload). The client will not prompt on these; ssh-mcp's own policy is the gate.
- `deny`: the other 5 tools (`privileged-command`, `sftp-download`, `sftp-list`,
  `sftp-upload-file`, `sftp-download-file`). The model still sees their descriptions,
  but cannot execute them - slightly weaker than Codex's registration-time filtering.
- `disableBypassPermissionsMode: true` locks off `--dangerously-skip-permissions`.

Do not run this agent in `bypassPermissions` mode: it removes the client-side
prompts for everything else, and the whole point of this setup is layered gates.

## Codex setup (secondary)

Merge `codex-mcp-snippet.toml` into `C:\Users\<you>\.codex\config.toml`:

- `approvals_reviewer = "user"` keeps a human on the destructive band.
- `[approval_policy.granular]` with `mcp_elicitations = true` is REQUIRED -
  without it, ssh-mcp's prompts are auto-rejected. If your config already has an
  `approval_policy = "..."` line, replace it with the granular table.
- `enabled_tools` is a structural allow-list: only 9 of 14 tools are even
  registered, so the agent cannot see or be prompt-injected into the excluded ones.
- `tool_timeout_sec = 900` keeps long builds from hitting Codex's MCP tool timeout.

## v2.9.0 notes

- New streaming SFTP tools `sftp-list` / `sftp-upload-file` / `sftp-download-file`
  transfer between the remote host and a local `transferRoot` without file contents
  entering model context.
- **On Windows the two transfer tools refuse to run** - ssh-mcp cannot yet verify a
  private transfer root there. `sftp-list` works everywhere, and the older
  content-based `sftp-upload` / `sftp-download` still work for small text files.
- `read-command` and `run-command` now refuse multi-line commands. For anything
  multi-line, the agent should put a script on the server (`sftp-upload`, which
  prompts you) or - the normal path here - edit the script locally and sync.
- New `transferMaxBytes` (256 MB) and `transferTimeoutMs` (5 min idle) settings are
  kept at their defaults in the config.

## Dials, tightest to loosest

1. **Default here:** `ask-destructive` + human approval + 5-min grants.
2. Less labor, same gate: raise `approvalGrantTtlMs` (e.g. 900000 = 15 min).
3. Much less labor, weaker gate: an Elicitation hook (Claude Code) or
   `approvals_reviewer = "auto_review"` (Codex) answers approvals for you.
   Keep the denylist and quotas as the hard floor underneath.
4. **Never:** `approvalPolicy = "auto"` on this profile. That is no gate at all on
   a root account, and upstream's README says exactly this.

## Honest caveats

- The classifier judges the command string (`./build.sh`), not what is inside your
  scripts. A script containing `rm -rf` runs as "safe". Review script diffs locally -
  that is the real guard for scripted work.
- Upstream's own README: "never point it at a root account, never set `auto` on a
  production profile." This config deliberately lives at the edge of that guidance
  because the server account can't be changed; the human gate is what makes it
  defensible. Keep it.
- Prompt-injected tool output is a real threat on any LLM+SSH setup (the "lethal
  trifecta"). The classification/approval layer narrows it; it does not remove it.
- Your company agent is a closed-source fork newer than the public Claude Code
  snapshot these findings are based on. The elicitation test above is the only way
  to know the approval gate actually surfaces in your build.












