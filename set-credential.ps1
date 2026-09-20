<#
.SYNOPSIS
Store a server password in Windows Credential Manager for ssh-mcp keychain auth.

.DESCRIPTION
Prompts for the password with masked input and stores it in Windows Credential
Manager under service "ssh-mcp" (or -Service), using the same library ssh-mcp
reads with (@napi-rs/keyring from the offline bundle). Verifies by reading it
back, then prints the exact profile lines to paste into config.toml.

The password travels PowerShell -> node via stdin, never as a command-line
argument, so it never shows in a process list.

.EXAMPLE
.\set-credential.ps1 -Account gpu-01

.EXAMPLE
.\set-credential.ps1 -Account gpu-01 -Test

.EXAMPLE
.\set-credential.ps1 -List
#>
[CmdletBinding(DefaultParameterSetName = 'Account')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Account')]
  [string]$Account,

  [string]$Service = "ssh-mcp",
  [string]$BundlePath = "C:\tools\ssh-mcp-offline",

  [Parameter(ParameterSetName = 'Account')]
  [switch]$Delete,

  [Parameter(ParameterSetName = 'Account')]
  [switch]$Test,

  [Parameter(ParameterSetName = 'List')]
  [switch]$List
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$keychainJs = Join-Path $scriptDir "keychain.mjs"

if (-not (Test-Path -LiteralPath $keychainJs)) {
  throw "keychain.mjs not found next to this script: $keychainJs"
}
if (-not (Test-Path -LiteralPath (Join-Path $BundlePath "package.json"))) {
  throw "Offline bundle not found at: $BundlePath (the extracted folder with package.json and node_modules). Use -BundlePath."
}

if ($List) {
  node $keychainJs $BundlePath list $Service
  exit $LASTEXITCODE
}
if ($Test) {
  node $keychainJs $BundlePath test $Service $Account
  exit $LASTEXITCODE
}
if ($Delete) {
  node $keychainJs $BundlePath delete $Service $Account
  exit $LASTEXITCODE
}

# Masked prompt. Plain text exists only in memory for the pipe below.
$secure = Read-Host -AsSecureString "Password for $Service/$Account"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

# PS 5.1 pipes to native processes as ASCII by default; force UTF-8 so
# non-ASCII passwords survive the trip.
$prevEncoding = $OutputEncoding
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try {
  $plain | node $keychainJs $BundlePath set $Service $Account
  if ($LASTEXITCODE -ne 0) { throw "Storing the credential failed." }

  ""
  "Stored. Add these lines to that server's profile in %APPDATA%\ssh-mcp\config.toml:"
  ""
  "    auth = `"keychain`""
  "    keychainEntry = `"$Service/$Account`""
  ""
  "Do NOT set keyRef on that profile: with keychain auth, keyRef means the"
  "entry holds a private key instead of a password."
} finally {
  $plain = $null
  $OutputEncoding = $prevEncoding
}
