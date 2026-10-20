# 给已经下载这个文件的用户。打开 PowerShell，粘贴下面这一行后回车：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\reset-silverstar-windows.ps1"
# 会清掉本机已安装的 Silverstar 和数据。下载的安装包不会删除。

$ErrorActionPreference = "Continue"
$ProductNames = @(
  "Silverstar",
  "Silverstar Beta",
  "DSH Desktop",
  "DSH Desktop Beta"
)
$DataNames = @(
  "YX Desktop",
  "YX Desktop Beta",
  "DSH Desktop",
  "DSH Desktop Beta",
  "Silverstar",
  "Silverstar Beta"
)
$BundleIds = @(
  "ai.deepseek.dsh.desktop",
  "ai.deepseek.dsh.desktop.beta"
)

function Test-SafeProductDir([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $full = [System.IO.Path]::GetFullPath($Path.TrimEnd('\', '/'))
  if ($full.Length -lt 4) { return $false }
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full -eq $root.TrimEnd('\')) { return $false }
  $leaf = Split-Path -Leaf $full
  if ($ProductNames -notcontains $leaf) { return $false }
  $blocked = @($env:USERPROFILE, $env:USERPROFILE + "\Desktop", $env:USERPROFILE + "\Downloads", $env:PUBLIC)
  foreach ($item in $blocked) {
    if ([string]::IsNullOrWhiteSpace($item)) { continue }
    if ($full -eq [System.IO.Path]::GetFullPath($item)) { return $false }
  }
  if (-not (Test-Path -LiteralPath $full)) { return $false }
  $packages = Get-ChildItem -LiteralPath $full -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '(?i)(Setup\.exe|\.dmg|\.msi|\.zip)$' }
  if ($packages) { return $false }
  return $true
}

function Remove-Tree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Path) {
    Write-Host "未能删除: $Path"
  } else {
    Write-Host "已删除: $Path"
  }
}

Write-Host "正在退出 Silverstar…"
foreach ($name in @("Silverstar", "Silverstar Beta", "DSH Desktop", "DSH Desktop Beta")) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

$installDirs = New-Object System.Collections.Generic.List[string]
$localPrograms = Join-Path $env:LOCALAPPDATA "Programs"
foreach ($name in $ProductNames) {
  $installDirs.Add((Join-Path $localPrograms $name))
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not [string]::IsNullOrWhiteSpace($root)) {
      $installDirs.Add((Join-Path $root $name))
    }
  }
}

$uninstallRoots = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $props) { return }
    if ($ProductNames -notcontains $props.DisplayName) { return }
    if (-not [string]::IsNullOrWhiteSpace($props.InstallLocation)) {
      $installDirs.Add($props.InstallLocation)
    }
    Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "已删除卸载登记: $($props.DisplayName)"
  }
}

foreach ($id in $BundleIds) {
  foreach ($hive in @("HKCU:\Software", "HKLM:\Software")) {
    $key = Join-Path $hive $id
    if (Test-Path $key) {
      Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "已删除注册表: $key"
    }
  }
}

Write-Host "正在删除已安装的程序…"
$seen = @{}
foreach ($dir in $installDirs) {
  if ([string]::IsNullOrWhiteSpace($dir)) { continue }
  $full = [System.IO.Path]::GetFullPath($dir.TrimEnd('\', '/'))
  if ($seen.ContainsKey($full)) { continue }
  $seen[$full] = $true
  if (Test-SafeProductDir $full) {
    Remove-Tree $full
  } elseif (Test-Path -LiteralPath $full) {
    Write-Host "已跳过（目录里有安装包，或不是 Silverstar 的安装目录）: $full"
  }
}

Write-Host "正在删除快捷方式…"
$shortcutRoots = @(
  (Join-Path $env:USERPROFILE "Desktop"),
  (Join-Path $env:PUBLIC "Desktop"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
  (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs")
)
foreach ($root in $shortcutRoots) {
  if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) { continue }
  foreach ($name in $ProductNames) {
    Remove-Tree (Join-Path $root ($name + ".lnk"))
    $folder = Join-Path $root $name
    if ((Test-Path -LiteralPath $folder) -and (Test-SafeProductDir $folder)) {
      Remove-Tree $folder
    }
  }
}

Write-Host "正在删除应用数据…"
foreach ($name in $DataNames) {
  Remove-Tree (Join-Path $env:APPDATA $name)
  Remove-Tree (Join-Path $env:LOCALAPPDATA $name)
}
Remove-Tree (Join-Path $env:USERPROFILE ".dsh")
Remove-Tree (Join-Path $env:USERPROFILE ".dsh-beta")

Write-Host ""
Write-Host "清除完成。下载的安装包没有删除。"
Write-Host "现在可以重新安装 Silverstar。"
