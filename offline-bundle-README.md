# ssh-mcp offline bundle (Windows x64)

Bundled: ssh-mcp plus all production dependencies, installed from npm on
Windows x64. No npm or network access is needed on the target machine.

## Requirements

- Node.js >= 20.6 on PATH (any recent LTS). That is the only requirement.

## Smoke test (after extracting)

    node node_modules\ssh-mcp\build\index.js --dumpToolHashes

Should print a JSON map of 14 tool names to hashes and exit with code 0.

## Run

    node node_modules\ssh-mcp\build\index.js --config C:\path\to\config.toml

## Wire into your agent (Claude Code style mcp.json)

    {
      "mcpServers": {
        "ssh-mcp": {
          "command": "node",
          "args": [
            "C:/tools/ssh-mcp-offline/node_modules/ssh-mcp/build/index.js",
            "--config", "C:/Users/<you>/AppData/Roaming/ssh-mcp/config.toml"
          ]
        }
      }
    }

## Notes

- Windows Credential Manager support (keychain auth, @napi-rs/keyring) is included.
- ssh2 runs in pure-JS mode (its optional native bindings were not built);
  fully functional, marginally slower crypto handshake.
- Put the real config at %APPDATA%\ssh-mcp\config.toml - that location has the
  restrictive ACL ssh-mcp requires for files that can hold credentials.
- package-lock.json is included: the bundle is exactly what npm installed.
- Windows x64 target. Most contents are pure JS, but the keyring binary is
  platform-specific.
