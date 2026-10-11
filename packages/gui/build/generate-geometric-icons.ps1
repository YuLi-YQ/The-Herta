$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Original geometric mark. No downloaded art, character likeness or fonts.
# Re-run from any directory. All outputs stay in this GUI package.
$taskGuiRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSvgSource = Join-Path $taskGuiRoot 'src/renderer/assets/atelier-mark.svg'
Copy-Item -LiteralPath $taskSvgSource -Destination (Join-Path $PSScriptRoot 'icon.svg') -Force

function New-AtelierBitmap([int] $taskSize) {
  $taskBitmap = [Drawing.Bitmap]::new($taskSize, $taskSize, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
  $taskGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $taskGraphics.Clear([Drawing.ColorTranslator]::FromHtml('#121016'))
  $taskGraphics.ScaleTransform($taskSize / 256.0, $taskSize / 256.0)
  $taskPanel = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#1E1925'))
  $taskPurple = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#C0A0EE'))
  $taskCenter = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#21132F'))
  $taskGold = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#CBB17A'))
  $taskPen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#CBB17A'), 3)
  $taskRounded = [Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $taskRounded.AddArc(20, 20, 92, 92, 180, 90)
    $taskRounded.AddArc(144, 20, 92, 92, 270, 90)
    $taskRounded.AddArc(144, 144, 92, 92, 0, 90)
    $taskRounded.AddArc(20, 144, 92, 92, 90, 90)
    $taskRounded.CloseFigure()
    $taskGraphics.FillPath($taskPanel, $taskRounded)
    $taskGraphics.DrawEllipse($taskPen, 53, 53, 150, 150)
    [Drawing.PointF[]] $taskStar = @(
      [Drawing.PointF]::new(128, 52), [Drawing.PointF]::new(146, 110),
      [Drawing.PointF]::new(204, 128), [Drawing.PointF]::new(146, 146),
      [Drawing.PointF]::new(128, 204), [Drawing.PointF]::new(110, 146),
      [Drawing.PointF]::new(52, 128), [Drawing.PointF]::new(110, 110)
    )
    [Drawing.PointF[]] $taskDiamond = @(
      [Drawing.PointF]::new(128, 95), [Drawing.PointF]::new(161, 128),
      [Drawing.PointF]::new(128, 161), [Drawing.PointF]::new(95, 128)
    )
    $taskGraphics.FillPolygon($taskPurple, $taskStar)
    $taskGraphics.FillPolygon($taskCenter, $taskDiamond)
    $taskGraphics.DrawPolygon($taskPen, $taskDiamond)
    $taskGraphics.FillEllipse($taskGold, 190, 57, 14, 14)
  } finally {
    $taskGraphics.Dispose()
    $taskPanel.Dispose()
    $taskPurple.Dispose()
    $taskCenter.Dispose()
    $taskGold.Dispose()
    $taskPen.Dispose()
    $taskRounded.Dispose()
  }
  return $taskBitmap
}

$taskLarge = New-AtelierBitmap 1024
try { $taskLarge.Save((Join-Path $PSScriptRoot 'icon.png'), [Drawing.Imaging.ImageFormat]::Png) }
finally { $taskLarge.Dispose() }
$taskTray = New-AtelierBitmap 256
try { $taskTray.Save((Join-Path $taskGuiRoot 'resources/herta-icon.png'), [Drawing.Imaging.ImageFormat]::Png) }
finally { $taskTray.Dispose() }

$taskSizes = @(16, 24, 32, 48, 64, 128, 256)
$taskFrames = @()
foreach ($taskSize in $taskSizes) {
  $taskFrame = New-AtelierBitmap $taskSize
  $taskStream = [IO.MemoryStream]::new()
  try {
    $taskFrame.Save($taskStream, [Drawing.Imaging.ImageFormat]::Png)
    $taskFrames += ,$taskStream.ToArray()
  } finally { $taskFrame.Dispose(); $taskStream.Dispose() }
}
$taskIconStream = [IO.File]::Create((Join-Path $PSScriptRoot 'icon.ico'))
$taskWriter = [IO.BinaryWriter]::new($taskIconStream)
try {
  $taskWriter.Write([UInt16] 0)
  $taskWriter.Write([UInt16] 1)
  $taskWriter.Write([UInt16] $taskSizes.Count)
  $taskOffset = 6 + 16 * $taskSizes.Count
  for ($taskIndex = 0; $taskIndex -lt $taskSizes.Count; $taskIndex++) {
    $taskDimension = if ($taskSizes[$taskIndex] -eq 256) { 0 } else { $taskSizes[$taskIndex] }
    $taskWriter.Write([Byte] $taskDimension)
    $taskWriter.Write([Byte] $taskDimension)
    $taskWriter.Write([Byte] 0)
    $taskWriter.Write([Byte] 0)
    $taskWriter.Write([UInt16] 1)
    $taskWriter.Write([UInt16] 32)
    $taskWriter.Write([UInt32] $taskFrames[$taskIndex].Length)
    $taskWriter.Write([UInt32] $taskOffset)
    $taskOffset += $taskFrames[$taskIndex].Length
  }
  foreach ($taskFrameBytes in $taskFrames) { $taskWriter.Write([Byte[]] $taskFrameBytes) }
} finally { $taskWriter.Dispose(); $taskIconStream.Dispose() }

Write-Output 'Generated original geometric SVG, 1024px PNG, 256px tray PNG and 7-frame ICO.'
