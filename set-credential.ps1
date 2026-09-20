<#
.SYNOPSIS
Store server passwords in Windows Credential Manager for ssh-mcp keychain auth.

.DESCRIPTION
Prompts for each password with masked input and stores it in Windows Credential
Manager under service "ssh-mcp" (or -Service), using the same library ssh-mcp
reads with (@napi-rs/keyring from the offline bundle). Verifies each entry by
reading it back, then prints the profile lines to paste into config.toml.

-Verify re-prompts and compares what you type with the stored entry, without
ever printing the password - use it after storing to prove the entry is exact.

Passwords travel PowerShell -> node via stdin, never as command-line
arguments, so they never show in a process list. Never put passwords in a
file - provide names only, and let this script prompt for each secret.

.EXAMPLE
.\set-credential.ps1 -Account gpu-01

.EXAMPLE
.\set-credential.ps1 -Account gpu-01 -Verify

.EXAMPLE
.\set-credential.ps1 -Batch -Accounts gpu-01,gpu-02,web-1

.EXAMPLE
.\set-credential.ps1 -Batch -AccountList C:\tools\server-names.txt

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

  [Parameter(ParameterSetName = 'Account')]
  [switch]$Verify,

  # Store from an environment variable instead of a prompt - no typing, no
  # paste, no IME. Pass the variable name, e.g: -FromEnv SSH_MCP_PASSWORD
  [Parameter(ParameterSetName = 'Account')]
  [string]$FromEnv,

  [Parameter(ParameterSetName = 'List')]
  [switch]$List,

  [Parameter(ParameterSetName = 'Batch')]
  [switch]$Batch,

  # Comma-separated account names. NAMES ONLY - never passwords.
  [Parameter(ParameterSetName = 'Batch')]
  [string]$Accounts,

  # Path to a text file with one account name per line. NAMES ONLY.
  [Parameter(ParameterSetName = 'Batch')]
  [string]$AccountList
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

function Read-MaskedSecret([string]$prompt) {
  $secure = Read-Host -AsSecureString $prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Invoke-Keychain([string[]]$NodeArgs, [string]$plainSecret) {
  # PS 5.1 pipes to native processes as ASCII by default; force UTF-8 so
  # non-ASCII passwords survive the trip.
  $prevEncoding = $OutputEncoding
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false
  try {
    if ($null -ne $plainSecret) {
      $plainSecret | node $keychainJs @NodeArgs
    } else {
      node $keychainJs @NodeArgs
    }
    if ($LASTEXITCODE -ne 0) { throw "keychain.mjs exited with $LASTEXITCODE." }
  } finally {
    $OutputEncoding = $prevEncoding
  }
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
if ($Verify) {
  $plain = Read-MaskedSecret "Re-enter password for $Service/$Account (compared with stored)"
  try {
    Invoke-Keychain @($BundlePath, "verify", $Service, $Account) $plain
  } finally {
    $plain = $null
  }
  exit 0
}

if ($PSBoundParameters.ContainsKey('FromEnv')) {
  if (-not $FromEnv) { $FromEnv = 'SSH_MCP_PASSWORD' }
  if (-not [Environment]::GetEnvironmentVariable($FromEnv)) {
    throw "Environment variable $FromEnv is not set in THIS session. Set it first: `$env:$FromEnv = 'the-password' (setx-set values need a NEW window to appear)."
  }
  node $keychainJs $BundlePath set-from-env $Service $Account $FromEnv
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  ""
  "Stored from $FromEnv - no prompt, no paste, no IME. The profile keeps:"
  "    auth = `"keychain`""
  "    keychainEntry = `"$Service/$Account`""
  exit 0
}

if ($Batch) {
  if ($Accounts -and $AccountList) {
    throw "Use either -Accounts or -AccountList, not both."
  }
  $names = @()
  if ($Accounts) { $names += ($Accounts -split ',') }
  if ($AccountList) {
    if (-not (Test-Path -LiteralPath $AccountList)) { throw "Account list file not found: $AccountList" }
    $names += (Get-Content -LiteralPath $AccountList)
  }
  $names = @($names | ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Select-Object -Unique)
  if (-not $names.Count) { throw "No account names. Pass -Accounts a,b,c or -AccountList <file> (names only, no passwords)." }

  # Validate every name BEFORE prompting, so a typo does not leave a
  # half-finished batch. '/' and '\' would break keychainEntry parsing.
  $bad = @($names | Where-Object { $_ -match '[\s/\\]' })
  if ($bad.Count) { throw "Invalid account name(s) - must not contain whitespace, / or \: $($bad -join ', ')" }

  ""
  "Batch: $($names.Count) account(s). You will be prompted for each password"
  "with masked input. Ctrl+C is safe - already-stored entries stay stored."
  ""
  $done = @()
  foreach ($n in $names) {
    $plain = Read-MaskedSecret "Password for $Service/$n"
    try {
      Invoke-Keychain @($BundlePath, "set", $Service, $n) $plain
      $done += $n
      "  stored $Service/$n"
    } finally {
      $plain = $null
    }
  }
  ""
  "Done. For each profile in %APPDATA%\ssh-mcp\config.toml add:"
  "    auth = `"keychain`""
  "    keychainEntry = `"$Service/<account>`""
  "Accounts stored this run: $($done -join ', ')"
  "Do NOT set keyRef on these profiles: with keychain auth, keyRef means the"
  "entry holds a private key instead of a password."
  exit 0
}

# Single-account mode.
$plain = Read-MaskedSecret "Password for $Service/$Account"
try {
  Invoke-Keychain @($BundlePath, "set", $Service, $Account) $plain
  ""
  "Stored. Add these lines to that server's profile in %APPDATA%\ssh-mcp\config.toml:"
  ""
  "    auth = `"keychain`""
  "    keychainEntry = `"$Service/$Account`""
  ""
  "Do NOT set keyRef on that profile: with keychain auth, keyRef means the"
  "entry holds a private key instead of a password."
  ""
  "Confirm the entry is exact:  .\set-credential.ps1 -Account $Account -Verify"
} finally {
  $plain = $null
}

