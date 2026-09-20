# ssh-mcp offline bundle (Windows x64)

Bundled: ssh-mcp plus all production dependencies, installed from npm on
Windows x64. No npm or network access is needed on the target machine.

## Requirements

- Node.js >= 20.6 on PATH (any recent LTS). That is the only requirement.

## Smoke test (after extracting)

    node node_modules\ssh-mcp\build\index.js --dumpToolHashes

Should print a JSON map of 14 tool names to hashes and exit with code 0.

## Run

    node node_modules\ssh-mcp\build\index.js

Reads the config automatically from %APPDATA%\ssh-mcp\config.toml. For a
custom location, pass ONE argument with "=" (the two-token form does not
work in ssh-mcp's parser):

    node node_modules\ssh-mcp\build\index.js --config=D:/path/config.toml

## Wire into your agent (Claude Code style mcp.json)

    {
      "mcpServers": {
        "ssh-mcp": {
          "command": "node",
          "args": [
            "C:/tools/ssh-mcp-offline/node_modules/ssh-mcp/build/index.js"
          ]
        }
      }
    }

No --config argument: the config lives at the default location
%APPDATA%\ssh-mcp\config.toml (create that folder if it does not exist).
That location also passes ssh-mcp's Windows ACL check automatically.

## Notes

- Windows Credential Manager support (keychain auth, @napi-rs/keyring) is included.
- ssh2 runs in pure-JS mode (its optional native bindings were not built);
  fully functional, marginally slower crypto handshake.
- Put the real config at %APPDATA%\ssh-mcp\config.toml - that location has the
  restrictive ACL ssh-mcp requires for files that can hold credentials.
- package-lock.json is included: the bundle is exactly what npm installed.
- Windows x64 target. Most contents are pure JS, but the keyring binary is
  platform-specific.
