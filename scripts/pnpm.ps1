$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $workspacePath '.runtime/node-v22.23.3-win-x64'
$nodeBinary = Join-Path $nodeDirectory 'node.exe'
$pnpmScript = Join-Path $workspacePath '.runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs'
if (-not (Test-Path -LiteralPath $nodeBinary) -or -not (Test-Path -LiteralPath $pnpmScript)) {
    throw 'Run ./scripts/bootstrap-windows.ps1 first.'
}
$env:PATH = (Join-Path $workspacePath '.runtime/pnpm/node_modules/.bin') + ';' + $nodeDirectory + ';' + $env:PATH
Set-Location -LiteralPath $workspacePath
& $nodeBinary $pnpmScript @args
exit $LASTEXITCODE
