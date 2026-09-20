<#
.SYNOPSIS
Rebuild the ssh-mcp offline bundle on a machine WITH npm access.

.DESCRIPTION
Installs a pinned ssh-mcp version plus its production dependencies into a
fresh staging folder, runs the built-in smoke test, and zips the result.
The README packed into the zip is offline-bundle-README.md next to this
script - edit that file, not the zip.

Run this on Windows x64 - the bundle includes the win-x64 @napi-rs/keyring
binary for Windows Credential Manager auth.

.EXAMPLE
.\pack-offline.ps1 -Version 2.9.1
#>
param(
  [string]$Version = "2.9.0"
)

$ErrorActionPreference = "Stop"

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "Pack on Windows x64: the bundle ships the win-x64 @napi-rs/keyring binary."
}

$readmeSrc = Join-Path $PSScriptRoot "offline-bundle-README.md"
if (-not (Test-Path -LiteralPath $readmeSrc)) {
  throw "Missing offline-bundle-README.md next to this script."
}

$stage = Join-Path $PSScriptRoot ".pack-staging"
$zip   = Join-Path $PSScriptRoot "ssh-mcp-$Version-win-x64-offline.zip"

# Safety guard for the recursive delete below: only ever delete the staging
# dir we own, inside the folder this script lives in.
if (Test-Path -LiteralPath $stage) {
  $resolved = (Resolve-Path -LiteralPath $stage).Path
  if (-not $resolved.StartsWith($PSScriptRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete staging dir outside this folder: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null

Set-Content -LiteralPath (Join-Path $stage "package.json") `
  -Value ('{"name":"ssh-mcp-offline-bundle","private":true,"version":"' + $Version + '"}')

Push-Location $stage
try {
  # Fresh install, never "npm update" in place: a fresh tree cannot carry
  # stale dependencies from a previous version.
  npm install "ssh-mcp@$Version" --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

  # Smoke test: this flag loads every module in the bundle and prints the
  # tool table. Exit 0 = the bundle is complete and runnable.
  node "node_modules\ssh-mcp\build\index.js" --dumpToolHashes
  if ($LASTEXITCODE -ne 0) { throw "smoke test failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Copy-Item -LiteralPath $readmeSrc -Destination (Join-Path $stage "README.md")

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

# Staging is build output; remove it so it never gets committed by accident.
$resolved = (Resolve-Path -LiteralPath $stage).Path
if ($resolved.StartsWith($PSScriptRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

""
"Bundle ready: $zip"
"{0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB)
"If the version changed: remove the old zip from the repo, commit, push."
