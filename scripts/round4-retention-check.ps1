[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$ProfileDirectory,
  [Parameter(Mandatory = $true)][string]$Installer,
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$verificationRoot = Join-Path $workspaceRoot '.verification/round-4'
$evidenceRoot = Join-Path $workspaceRoot 'docs/reports/evidence/round-4'

function Assert-ExactDirectory([string]$Path, [string]$Expected) {
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'An explicit absolute path is required.' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  if (-not $full.Equals([IO.Path]::GetFullPath($Expected).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Path is outside the exact round-4 test scope.'
  }
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Reparse-point paths are forbidden for this destructive installer test.'
      }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  return $full
}

$InstallDirectory = Assert-ExactDirectory $InstallDirectory (Join-Path $verificationRoot 'installed')
$ProfileDirectory = Assert-ExactDirectory $ProfileDirectory (Join-Path $verificationRoot 'profile-native')
$Installer = Assert-ExactDirectory $Installer (Join-Path $workspaceRoot 'packages/gui/release-round-4/The-Herta-Setup-0.4.0-x64.exe')
$uninstaller = Join-Path $InstallDirectory 'Uninstall The Herta.exe'
$installedExe = Join-Path $InstallDirectory 'The Herta.exe'
foreach ($required in @($uninstaller, $installedExe, $Installer, $ProfileDirectory)) {
  if (-not (Test-Path -LiteralPath $required)) { throw 'A required installer, uninstaller or isolated profile is absent.' }
}

function File-Facts([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    path = $Path; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    fileVersion = $item.VersionInfo.FileVersion; signature = (Get-AuthenticodeSignature -LiteralPath $Path).Status.ToString()
  }
}

function Profile-Facts {
  $files = @(Get-ChildItem -LiteralPath $ProfileDirectory -Force -Recurse)
  foreach ($item in $files) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point inside the isolated profile.' }
  }
  return @($files | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName | ForEach-Object {
    [ordered]@{ relativePath = [IO.Path]::GetRelativePath($ProfileDirectory, $_.FullName); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  })
}

# Existing originals were captured before this round's install. Never substitute
# newly generated shortcuts for them, and never log a shortcut's arguments.
$originals = @()
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($index in @(0, 1)) {
  $metadataPath = Join-Path $verificationRoot "shortcut-backup/$index.json"
  $originalPath = Join-Path $verificationRoot "shortcut-backup/$index.lnk"
  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  if ((Get-FileHash -LiteralPath $originalPath -Algorithm SHA256).Hash -ne $metadata.sha256) { throw 'Original shortcut backup hash mismatch.' }
  $allowedShortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'The Herta.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'The Herta.lnk')
  )
  if ($metadata.path -notin $allowedShortcutPaths) { throw 'Shortcut backup destination is outside the two known original paths.' }
  if (Test-Path -LiteralPath $metadata.path) {
    $target = $shortcutShell.CreateShortcut($metadata.path).TargetPath
    if ($target -ne $installedExe -and $target -ne $metadata.target) { throw 'A shortcut now targets an unrelated application; refusing to overwrite it.' }
  }
  $originals += [pscustomobject]@{ metadata = $metadata; source = $originalPath }
}

$plan = [ordered]@{
  mode = $(if ($Execute) { 'execute' } else { 'plan-only' })
  installDirectory = $InstallDirectory; profileDirectory = $ProfileDirectory
  uninstaller = $uninstaller; uninstallArguments = @('/S', "_?=$InstallDirectory")
  installer = (File-Facts $Installer)
  installArguments = @('/S', '--no-desktop-shortcut', "/D=$InstallDirectory")
  launchesApplication = $false; closesApplication = $false; deletesAppData = $false
  scope = 'Real uninstall/reinstall of round-4 test installation; existing isolated data hashes only. No claim of authentic legacy user-data migration.'
}
if (-not $Execute) { $plan | ConvertTo-Json -Depth 8; return }

# The appId is intentionally unchanged. A later personal installation must not
# be silently replaced just because the test-directory executable still exists.
foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (-not (Test-Path -LiteralPath $registryRoot)) { continue }
  foreach ($entry in @(Get-ChildItem -LiteralPath $registryRoot)) {
    $registration = Get-ItemProperty -LiteralPath $entry.PSPath
    if ($registration.DisplayName -match '^The Herta(?:\s|$)') {
      if (-not $registration.UninstallString -or $registration.UninstallString.IndexOf($uninstaller, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'A different The Herta installation is registered. Refusing uninstall/reinstall until the coordinator resolves its ownership.'
      }
    }
  }
}

# The coordinator must close the application first. Do not print process command
# lines, which might contain application inputs. No Stop-Process or taskkill.
foreach ($process in @(Get-CimInstance Win32_Process)) {
  if ($process.ExecutablePath -eq $installedExe -or ($process.CommandLine -and $process.CommandLine.Contains($ProfileDirectory))) {
    throw 'The test application/profile is in use. Close it explicitly before running retention verification.'
  }
}

New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$before = @(Profile-Facts)
$before | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'retention-before.json') -Encoding utf8
$result = [ordered]@{ plan = $plan; beforeInstalled = (File-Facts $installedExe); uninstallExitCode = $null; installExitCode = $null; preserved = $false; shortcutsRestored = $false }
try {
  $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList $plan.uninstallArguments -WindowStyle Hidden -Wait -PassThru
  $result.uninstallExitCode = $uninstallProcess.ExitCode
  if ($uninstallProcess.ExitCode -ne 0) { throw 'Silent test uninstallation failed.' }
  if (Test-Path -LiteralPath $installedExe) { throw 'Installed executable remains after uninstall; refusing to hide this failure with reinstall.' }
  $afterUninstall = @(Profile-Facts)
  $afterUninstall | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'retention-after-uninstall.json') -Encoding utf8
  $installProcess = Start-Process -FilePath $Installer -ArgumentList $plan.installArguments -WindowStyle Hidden -Wait -PassThru
  $result.installExitCode = $installProcess.ExitCode
  if ($installProcess.ExitCode -ne 0) { throw 'Silent test reinstallation failed.' }
  $after = @(Profile-Facts)
  $after | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'retention-after-reinstall.json') -Encoding utf8
  $beforeJson = ConvertTo-Json -InputObject $before -Depth 5 -Compress
  $result.preserved = $beforeJson -eq (ConvertTo-Json -InputObject $afterUninstall -Depth 5 -Compress) -and $beforeJson -eq (ConvertTo-Json -InputObject $after -Depth 5 -Compress)
  $result.afterInstalled = File-Facts $installedExe
  if (-not $result.preserved) { throw 'Isolated profile hashes changed during uninstall/reinstall.' }
} finally {
  foreach ($original in $originals) {
    if (Test-Path -LiteralPath $original.metadata.path) {
      $target = $shortcutShell.CreateShortcut($original.metadata.path).TargetPath
      if ($target -ne $installedExe -and $target -ne $original.metadata.target) { throw 'Shortcut changed to an unrelated target during testing; manual restoration required.' }
    }
    Copy-Item -LiteralPath $original.source -Destination $original.metadata.path -Force
    if ((Get-FileHash -LiteralPath $original.metadata.path -Algorithm SHA256).Hash -ne $original.metadata.sha256) { throw 'Original shortcut restoration failed.' }
  }
  $result.shortcutsRestored = $true
  $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'retention-result.json') -Encoding utf8
}
$result | ConvertTo-Json -Depth 10
