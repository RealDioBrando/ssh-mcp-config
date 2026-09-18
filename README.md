# ssh-mcp-config

Personal config for [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp) v2.9.0,
for a single agent working on a **shared server as root** - an accepted-risk setup,
made as safe as that constraint allows without changing anything on the server.

## Accepted risk, and what compensates

| Accepted | Compensating control |
|---|---|
| Root SSH user (can't create a scoped account) | `ask-destructive`: every destructive command stops for a human |
| No snapshots on the shared server | denylist for never-ok actions + audit log of everything that ran |
| Shared box with coworkers | `shutdown`/`reboot`/force-push hard-denied; output and length caps |
| Single agent, lazy operator | 5-minute approval grants so identical commands don't re-prompt |
| LLM + SSH (prompt injection) | Codex `enabled_tools` allow-list: most tools are not even registered |

The biggest safety win costs nothing: **the agent edits code and scripts locally on
Windows** (sandboxed, diff visible), syncs with your existing VS Code SFTP, and only
reaches the server to run, inspect and debug. The SSH surface stays small.

## What prompts you vs. what just runs

With `role = "operator"`, `group = "dev"`, `approvalPolicy = "ask-destructive"`:

| Action | Class | Behavior |
|---|---|---|
| `nvidia-smi`, `ps`, `tail log`, `docker ps` | read-only / safe | runs, no prompt |
| `./build.sh`, `make`, `python train.py` | safe | runs, no prompt |
| `rm -rf build/`, `kill`, `chmod -R` | destructive | **prompts you** |
| `sudo ...` | privileged | **denied** (operator role; root doesn't need sudo) |
| `shutdown`, `reboot`, `git push --force` | denylist | **denied, no prompt possible** |

Note the split: the denylist is for *never*; the approval gate is for
*routine-but-risky* (cleaning a build dir, killing a job). That is why `rm -rf` is
NOT in the denylist - it would make normal cleanup impossible instead of reviewed.

## Two layers of tool restriction

1. **ssh-mcp server-side** (config.example.toml): role `operator` denies the
   `privileged` class; `ask-destructive` gates destructive commands; the denylist
   blocks never-ok actions.
2. **Codex client-side** (codex-mcp-snippet.toml): `enabled_tools` is a structural
   allow-list - only 9 of ssh-mcp's 14 tools are even registered. The agent cannot
   see, call, or be prompt-injected into the excluded ones:
   - `privileged-command` - root needs no sudo
   - `sftp-download`, `sftp-list` - `read-command "cat"/"ls"` covers them
   - `sftp-upload-file`, `sftp-download-file` - they refuse on Windows anyway

   Re-enable any tool by adding its name to the `enabled_tools` list.

## Setup

1. `npm install -g ssh-mcp` (or rely on `npx`, as the Codex snippet does).
2. Copy `config.example.toml` to `%APPDATA%\ssh-mcp\config.toml` and fill in the
   four `<-- FILL` lines (host, key path, workdir).
3. Merge `codex-mcp-snippet.toml` into `C:\Users\<you>\.codex\config.toml`.
   - If your config already has an `approval_policy = "..."` line, replace it with
     the `[approval_policy.granular]` table.
   - `mcp_elicitations = true` is REQUIRED - without it, ssh-mcp's approval
     prompts are auto-rejected, not approved.
4. Restart Codex and test with a read-only call, e.g. ask the agent to
   `read-command "nvidia-smi"`.

The real `config.toml` is gitignored so your host and key details stay local.

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

1. **Default here:** `ask-destructive` + human reviewer + 5-min grants.
2. Less labor, same gate: raise `approvalGrantTtlMs` (e.g. 900000 = 15 min).
3. Much less labor, weaker gate: `approvals_reviewer = "auto_review"` - a reviewer
   model instead of you. Non-deterministic; keep the denylist and quotas as the
   hard floor underneath.
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
