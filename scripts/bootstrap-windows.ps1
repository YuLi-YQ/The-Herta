param([switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspacePath
$runtimePath = Join-Path $workspacePath '.runtime'
$nodeDirectory = Join-Path $runtimePath 'node-v22.23.3-win-x64'
$nodeBinary = Join-Path $nodeDirectory 'node.exe'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
if (-not (Test-Path -LiteralPath $nodeBinary)) {
    $archivePath = Join-Path $runtimePath 'node.zip'
    Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip' -OutFile $archivePath
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71') { throw 'Node checksum mismatch' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimePath -Force
}
$env:PATH = (Join-Path $runtimePath 'pnpm/node_modules/.bin') + ';' + $nodeDirectory + ';' + $env:PATH
$pnpmScript = Join-Path $runtimePath 'pnpm/node_modules/pnpm/bin/pnpm.cjs'
if (-not (Test-Path -LiteralPath $pnpmScript)) {
    & (Join-Path $nodeDirectory 'npm.cmd') install --prefix (Join-Path $runtimePath 'pnpm') pnpm@9.15.0 --save-exact --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'pnpm installation failed' }
}
if (-not $SkipInstall) {
    & $nodeBinary $pnpmScript install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Workspace installation failed' }
    # Electron 43 exposes an explicit installer instead of a postinstall hook.
    & $nodeBinary $pnpmScript prepare:desktop
    if ($LASTEXITCODE -ne 0) {
        # Some Windows networks work through .NET but not Node fetch. Use the
        # same official artifact and locked npm package's checksum, never a mirror.
        $electronPackage = Join-Path $workspacePath 'packages/gui/node_modules/electron'
        $electronVersion = (Get-Content -LiteralPath (Join-Path $electronPackage 'package.json') -Raw | ConvertFrom-Json).version
        $artifactName = "electron-v$electronVersion-win32-x64.zip"
        $electronArchive = Join-Path $runtimePath $artifactName
        $checksums = Get-Content -LiteralPath (Join-Path $electronPackage 'checksums.json') -Raw | ConvertFrom-Json
        $expectedHash = $checksums.$artifactName
        if (-not $expectedHash) { throw 'Locked Electron package has no matching checksum' }
        Invoke-WebRequest -Uri "https://github.com/electron/electron/releases/download/v$electronVersion/$artifactName" -OutFile $electronArchive
        if ((Get-FileHash -LiteralPath $electronArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Electron checksum mismatch' }
        Expand-Archive -LiteralPath $electronArchive -DestinationPath (Join-Path $electronPackage 'dist') -Force
        Set-Content -LiteralPath (Join-Path $electronPackage 'path.txt') -Value 'electron.exe' -NoNewline
        Write-Output "Installed checksum-verified Electron $electronVersion through PowerShell fallback."
    }
}
Write-Output 'Toolchain ready. Run ./scripts/pnpm.ps1 build, dev:gui, or dist:personal.'
