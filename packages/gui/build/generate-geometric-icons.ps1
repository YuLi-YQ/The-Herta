$ErrorActionPreference = 'Stop'

# Superseded in R75: the app mark is drawn in build/icon.svg (and icon-small.svg
# for 16-32 px) and rendered by Electron's own Chromium, so gradients and curves
# come out exactly as drawn. This wrapper keeps the old entry point working.
# Original geometric mark. No downloaded art, character likeness or fonts.
$taskGuiRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskElectron = Join-Path $taskGuiRoot 'node_modules/electron/dist/electron.exe'
& $taskElectron (Join-Path $PSScriptRoot 'render-icons.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Icon rendering failed.' }
Write-Output 'Rendered build/icon.png, resources/herta-icon.png, build/icon.ico and assets/atelier-mark.svg.'
