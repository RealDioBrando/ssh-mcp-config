# ssh-mcp-config

Personal config for [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp) v2.9.0,
for a single agent working on a **shared server as root** - an accepted-risk setup,
made as safe as that constraint allows without changing anything on the server.

Primary target: a **Claude Code-based company agent** (see `claude-code/`).
Secondary: Codex (see `codex-mcp-snippet.toml`). The ssh-mcp server config
(`config.example.toml`) is identical for both.

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

## Claude Code setup

1. Copy `config.example.toml` to `%APPDATA%\ssh-mcp\config.toml` and fill in the
   `<-- FILL` lines (host, key path, workdir).
2. Register the MCP server: merge `claude-code/mcp.json` into your project's
   `.mcp.json` (or `~/.claude.json`), or run:
   `claude mcp add ssh-mcp -- npx ssh-mcp --config <path-to-config.toml>`
   On Windows, if `npx` fails to spawn, use `"command": "cmd"` with
   `"args": ["/c", "npx", "ssh-mcp", "--config", "<path>"]`.
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
