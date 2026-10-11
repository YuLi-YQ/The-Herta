# Regenerate build/icon.ico from build/icon.png (audit 2026-07-13 T3.2).
#
# electron-builder can convert a .png to .ico at package time via a bundled
# WASM tool, but that tool OOM'd on the Electron-43 packaging run
# ("WebAssembly.Memory(): could not allocate memory"). Committing a real
# multi-resolution .ico removes that build-time dependency and gives crisp
# icons at every Windows size. Run this (Windows PowerShell, System.Drawing)
# whenever build/icon.png changes:
#
#   powershell -File packages/gui/scripts/make-icon-ico.ps1
#
param(
  [string]$SrcPath = "$PSScriptRoot\..\build\icon.png",
  [string]$OutPath = "$PSScriptRoot\..\build\icon.ico"
)
Add-Type -AssemblyName System.Drawing

# electron-builder requires a 256 entry; the smaller sizes render crisply in
# the taskbar, tray, and Explorer without runtime downscaling.
$sizes = 16, 24, 32, 48, 64, 128, 256

$srcImg = [System.Drawing.Image]::FromFile((Resolve-Path $SrcPath))
$blobs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($srcImg, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $blobs += , ($ms.ToArray())
  $bmp.Dispose(); $ms.Dispose()
}
$srcImg.Dispose()

# Assemble the ICO: 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per size,
# then the PNG blobs (PNG-in-ICO is valid since Vista).
$count = $sizes.Count
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$count)
$offset = 6 + 16 * $count
for ($i = 0; $i -lt $count; $i++) {
  $s = $sizes[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }  # 0 means 256 in the ICO dir
  $bw.Write([byte]$dim)       # width
  $bw.Write([byte]$dim)       # height
  $bw.Write([byte]0)          # palette size (0 = truecolor)
  $bw.Write([byte]0)          # reserved
  $bw.Write([uint16]1)        # color planes
  $bw.Write([uint16]32)       # bits per pixel
  $bw.Write([uint32]$blobs[$i].Length)
  $bw.Write([uint32]$offset)
  $offset += $blobs[$i].Length
}
foreach ($b in $blobs) { $bw.Write($b) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path (Split-Path -Parent (Resolve-Path $SrcPath)) "icon.ico"), $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

$fi = Get-Item $OutPath
Write-Output "wrote $($fi.FullName) ($($fi.Length) bytes; sizes $($sizes -join ','))"
