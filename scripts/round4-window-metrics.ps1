param([Parameter(Mandatory=$true)][string]$Label)
$ErrorActionPreference = 'Stop'
if ($Label -notmatch '^[a-z0-9-]+$') { throw 'Invalid evidence label' }
$workspacePath = Split-Path -Parent $PSScriptRoot
$verificationRoot = Join-Path $workspacePath '.verification/round-4'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HertaWindowMetrics {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$processes = @(Get-Process -Name 'The Herta' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path.StartsWith($verificationRoot, [StringComparison]::OrdinalIgnoreCase) -or $_.Path.Contains('Temp')) })
$windows = @()
$previousContext = [HertaWindowMetrics]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
  foreach ($process in $processes) {
    if ($process.MainWindowHandle -eq 0) { continue }
    $rect = New-Object HertaWindowMetrics+Rect
    $client = New-Object HertaWindowMetrics+Rect
    [void][HertaWindowMetrics]::GetWindowRect($process.MainWindowHandle, [ref]$rect)
    [void][HertaWindowMetrics]::GetClientRect($process.MainWindowHandle, [ref]$client)
    $dpi = [HertaWindowMetrics]::GetDpiForWindow($process.MainWindowHandle)
    $windows += [pscustomobject]@{pid=$process.Id;handle=$process.MainWindowHandle.ToInt64();x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top;clientWidth=$client.Right;clientHeight=$client.Bottom;dpi=$dpi;scale=$dpi/96;minimized=[HertaWindowMetrics]::IsIconic($process.MainWindowHandle);maximized=[HertaWindowMetrics]::IsZoomed($process.MainWindowHandle)}
  }
} finally { [void][HertaWindowMetrics]::SetThreadDpiAwarenessContext($previousContext) }
$beforeCPU = ($processes | Measure-Object CPU -Sum).Sum
Start-Sleep -Milliseconds 1000
$after = @($processes | ForEach-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue })
$afterCPU = ($after | Measure-Object CPU -Sum).Sum
$result = [pscustomobject]@{label=$Label;at=[DateTime]::UtcNow.ToString('o');measurement='Win32 physical geometry at per-monitor aware measurement thread; process CPU delta over 1 second';windows=$windows;processCount=$after.Count;workingSetBytes=($after | Measure-Object WorkingSet64 -Sum).Sum;privateBytes=($after | Measure-Object PrivateMemorySize64 -Sum).Sum;cpuSecondsInOneSecond=$afterCPU-$beforeCPU;processes=@($after | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU)}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $workspacePath "docs/reports/evidence/round-4/$Label-metrics.json") -Encoding utf8
$result | Select-Object label,windows,processCount,workingSetBytes,privateBytes,cpuSecondsInOneSecond | ConvertTo-Json -Depth 4
