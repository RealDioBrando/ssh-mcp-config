<#
.SYNOPSIS
Unified ssh-mcp helper: credential management + connection testing.

.DESCRIPTION
One tool for the Windows Credential Manager credentials ssh-mcp reads with
auth = "keychain", and for testing ssh connections outside any agent.
Replaces the earlier set-credential.ps1 and test-connection.ps1.

Verbs:
  Set <account> [-FromEnv VAR]   store a password (masked prompt, or from env var)
  Verify <account>               re-enter and compare with the stored entry
  Check <account>                entry present? length? stray whitespace/control chars?
  Delete <account>               remove the stored entry
  List                           all entries under the service (names only)
  Batch -Accounts a,b,c          store many: names via -Accounts or -AccountList file,
       -AccountList <file>       masked prompt for each. Never put passwords in files.
  Connect [profile]              test connections outside any agent: all profiles by
                                 default, or one. -ConfigPath tests a non-default toml.
  Help                           this text

Common parameters: -Service (default ssh-mcp), -BundlePath (default
C:\tools\ssh-mcp-offline). Profile wiring: profile name = the account name,
auth = "keychain", keychainEntry = "<service>/<account>"; never set keyRef
on such a profile.

.EXAMPLE
.\ssh-mcp-tool.ps1 Set server

.EXAMPLE
.\ssh-mcp-tool.ps1 Set server -FromEnv SSH_MCP_PASSWORD

.EXAMPLE
.\ssh-mcp-tool.ps1 Connect
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('Set', 'Verify', 'Check', 'Delete', 'List', 'Batch', 'Connect', 'Help')]
  [string]$Verb = 'Help',

  [Parameter(Position = 1)]
  [string]$Name,

  [string]$Service = 'ssh-mcp',
  [string]$BundlePath = 'C:\tools\ssh-mcp-offline',
  [string]$FromEnv,
  [string[]]$Accounts,
  [string]$AccountList,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$engine = Join-Path $scriptDir 'ssh-mcp-tool.mjs'

if (-not (Test-Path -LiteralPath $engine)) {
  throw "ssh-mcp-tool.mjs not found next to this script: $engine"
}
if ($Verb -ne 'Help' -and -not (Test-Path -LiteralPath (Join-Path $BundlePath 'package.json'))) {
  throw "Offline bundle not found at: $BundlePath (the folder with package.json and node_modules). Use -BundlePath."
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

# Pipe a secret to the engine as UTF-8 (PS 5.1 defaults to ASCII for native
# pipes), or run it without stdin. Propagates the engine's exit code.
function Invoke-Engine([string[]]$EngineArgs, [string]$Secret) {
  $prev = $OutputEncoding
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false
  try {
    if ($null -ne $Secret) { $Secret | node $engine @EngineArgs }
    else { node $engine @EngineArgs }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    $OutputEncoding = $prev
  }
}

function Show-Usage() {
  $lines = @(
    'ssh-mcp-tool - unified ssh-mcp helper (credentials + connection testing)',
    '',
    '  Set <account> [-FromEnv VAR]   Store a password: masked prompt, or from an env',
    '                                 var (-FromEnv defaults to SSH_MCP_PASSWORD; this',
    '                                 is the recovery path when the prompt adds a',
    '                                 stray invisible character).',
    '  Verify <account>               Re-enter the password; compares with the stored',
    '                                 entry. Prints MATCH/MISMATCH, never the secret.',
    '  Check <account>                Entry present? Length? Stray whitespace or',
    '                                 control characters named by code and position.',
    '  Delete <account>               Remove the stored entry.',
    '  List                           All entries under the service (names only).',
    '  Batch -Accounts a,b,c          Store many in one run: names via -Accounts or',
    '       -AccountList <file>       -AccountList (NAMES ONLY - never passwords);',
    '                                 masked prompt for each. Ctrl+C mid-batch is safe.',
    '  Connect [profile]              Test ssh-mcp connections outside any agent: ALL',
    '                                 profiles by default, or one. -ConfigPath <toml>',
    '                                 tests a config file outside %APPDATA%\ssh-mcp.',
    '',
    'Common parameters: -Service (default ssh-mcp), -BundlePath (default',
    'C:\tools\ssh-mcp-offline). Profile wiring: profile name = the account name,',
    'auth = "keychain", keychainEntry = "<service>/<account>". Never set keyRef on',
    'such a profile: with keychain auth, keyRef means the entry holds a private key.'
  )
  $lines -join [Environment]::NewLine
}

switch ($Verb) {
  'Help' { Show-Usage; exit 0 }

  'List' {
    Invoke-Engine @($BundlePath, 'list', "--service=$Service")
    exit 0
  }

  'Check' {
    if (-not $Name) { throw 'Check needs an account name.' }
    Invoke-Engine @($BundlePath, 'check', $Name, "--service=$Service")
    exit 0
  }

  'Delete' {
    if (-not $Name) { throw 'Delete needs an account name.' }
    Invoke-Engine @($BundlePath, 'delete', $Name, "--service=$Service")
    exit 0
  }

  'Verify' {
    if (-not $Name) { throw 'Verify needs an account name.' }
    $plain = Read-MaskedSecret "Re-enter password for $Service/$Name (compared with stored)"
    try {
      Invoke-Engine @($BundlePath, 'verify', $Name, "--service=$Service") $plain
    } finally {
      $plain = $null
    }
    exit 0
  }

  'Set' {
    if (-not $Name) { throw 'Set needs an account name.' }
    if ($PSBoundParameters.ContainsKey('FromEnv') -and -not $FromEnv) { $FromEnv = 'SSH_MCP_PASSWORD' }
    if ($FromEnv) {
      if (-not [Environment]::GetEnvironmentVariable($FromEnv)) {
        throw "Environment variable $FromEnv is not set in THIS session. Set it first: `$env:$FromEnv = 'the-password' (setx values need a NEW window to appear)."
      }
      Invoke-Engine @($BundlePath, 'set-from-env', $Name, $FromEnv, "--service=$Service")
    } else {
      $plain = Read-MaskedSecret "Password for $Service/$Name"
      try {
        Invoke-Engine @($BundlePath, 'set', $Name, "--service=$Service") $plain
      } finally {
        $plain = $null
      }
    }
    ''
    'Stored. The profile keeps:'
    "    auth = `"keychain`""
    "    keychainEntry = `"$Service/$Name`""
    'Do NOT set keyRef on that profile: with keychain auth, keyRef means the'
    'entry holds a private key instead of a password.'
    exit 0
  }

  'Batch' {
    if ($Accounts -and $AccountList) { throw 'Use either -Accounts or -AccountList, not both.' }
    $names = @()
    if ($Accounts) { foreach ($a in $Accounts) { $names += ($a -split ',') } }
    if ($AccountList) {
      if (-not (Test-Path -LiteralPath $AccountList)) { throw "Account list file not found: $AccountList" }
      $names += (Get-Content -LiteralPath $AccountList)
    }
    $names = @($names | ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Select-Object -Unique)
    if (-not $names.Count) { throw 'No account names. Pass -Accounts a,b,c or -AccountList <file> (names only, no passwords).' }
    $bad = @($names | Where-Object { $_ -match '[\s/\\]' })
    if ($bad.Count) { throw "Invalid account name(s) - must not contain whitespace, / or \: $($bad -join ', ')" }
    ''
    "Batch: $($names.Count) account(s), masked prompt for each. Ctrl+C is safe -"
    'entries already stored stay stored.'
    ''
    $done = @()
    foreach ($n in $names) {
      $plain = Read-MaskedSecret "Password for $Service/$n"
      try {
        Invoke-Engine @($BundlePath, 'set', $n, "--service=$Service") $plain
      } finally {
        $plain = $null
      }
      $done += $n
      "  stored $Service/$n"
    }
    ''
    'Done. For each profile in %APPDATA%\ssh-mcp\config.toml:'
    '    auth = "keychain"'
    "    keychainEntry = `"$Service/<account>`""
    "Accounts stored this run: $($done -join ', ')"
    exit 0
  }

  'Connect' {
    $engineArgs = @($BundlePath, 'connect')
    if ($Name) { $engineArgs += $Name }
    if ($ConfigPath) { $engineArgs += ('--config=' + $ConfigPath) }
    Invoke-Engine $engineArgs
    exit 0
  }
}

