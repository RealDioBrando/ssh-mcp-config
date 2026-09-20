<#
.SYNOPSIS
Test the ssh-mcp connection directly, bypassing the agent entirely.

.DESCRIPTION
Runs ssh-mcp's own config loader, credential resolver and SSH stack in this
PowerShell session, and reports every step: config, profile, keychain entry
presence, environment variables, resolved credential sources, and the actual
connection result. Prints lengths only - never a secret.

.EXAMPLE
.\test-connection.ps1

.EXAMPLE
.\test-connection.ps1 -Profile gpu-01
#>
param(
  [string]$BundlePath = "C:\tools\ssh-mcp-offline",
  [string]$Profile
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$js = Join-Path $scriptDir "test-connection.mjs"

if (-not (Test-Path -LiteralPath (Join-Path $BundlePath "package.json"))) {
  throw "Offline bundle not found at: $BundlePath (the extracted folder with package.json and node_modules). Use -BundlePath."
}

if ($Profile) {
  node $js $BundlePath $Profile
} else {
  node $js $BundlePath
}
exit $LASTEXITCODE
