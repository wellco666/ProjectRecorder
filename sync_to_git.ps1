param(
    [string]$Destination = "C:\Users\34590\Documents\Codex\2026-10-31\d-xianmugual-projectrecorder-main\work\ProjectRecorder-target",
    [switch]$Commit,
    [switch]$Push,
    [string]$Message = "chore: sync source from working copy"
)

$ErrorActionPreference = "Stop"
$Source = $PSScriptRoot
$Destination = (Resolve-Path -LiteralPath $Destination).Path
$Manifest = Join-Path $Source "sync_manifest.txt"

if (-not (Test-Path -LiteralPath (Join-Path $Destination ".git"))) {
    throw "目标目录不是 Git 仓库：$Destination"
}
if (-not (Test-Path -LiteralPath $Manifest)) {
    throw "找不到同步清单：$Manifest"
}

# Repository files use LF internally. This avoids line-ending-only diffs
# when copying from a normal Windows working tree.
git -C $Destination config core.autocrlf true

$paths = Get-Content -LiteralPath $Manifest |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith("#") }

$copied = @()
foreach ($relative in $paths) {
    $from = Join-Path $Source $relative
    $to = Join-Path $Destination $relative
    if (-not (Test-Path -LiteralPath $from)) {
        Write-Warning "源文件不存在，跳过：$relative"
        continue
    }
    if (Test-Path -LiteralPath $from -PathType Container) {
        Get-ChildItem -LiteralPath $from -File -Recurse | ForEach-Object {
            $childRelative = $_.FullName.Substring($Source.Length).TrimStart('\')
            $childTarget = Join-Path $Destination $childRelative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $childTarget) | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $childTarget -Force
            $copied += $childRelative
        }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
        Copy-Item -LiteralPath $from -Destination $to -Force
        $copied += $relative
    }
}

Write-Host "已同步 $($copied.Count) 个文件到：$Destination"
Write-Host "`n仓库状态："
git -C $Destination status --short

if ($Commit) {
    git -C $Destination add -A
    $changes = git -C $Destination status --short
    if ($changes) {
        git -C $Destination commit -m $Message
    } else {
        Write-Host "没有需要提交的改动。"
    }
}

if ($Push) {
    git -C $Destination push origin main
}

exit 0
