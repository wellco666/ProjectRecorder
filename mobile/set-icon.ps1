# =============================================================
#  Set the app icon from the supplied image, then regenerate the
#  whole mipmap set.
#
#  ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as GBK,
#  so UTF-8 Chinese comments get mangled and can break parsing.
#
#  Source image: the 1224x1224 JPEG supplied for the icon.
#  Output: assets/icon.png (source) + android mipmaps.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File set-icon.ps1
# =============================================================

Add-Type -AssemblyName System.Drawing

$root = "E:\miniSoftware\ProjectRecorder\mobile"
$jpg = "C:\Users\cj\.dsh\attachments\v1\objects\e8\e865ef0d5301c3308993a0047613b931e41159d1214e0490e169476a92001015"
$assetDir = Join-Path $root "assets"
$png = Join-Path $assetDir "icon.png"

if (-not (Test-Path $assetDir)) {
    New-Item -Path $assetDir -ItemType Directory | Out-Null
}

# ---- 1. JPEG -> PNG, at 1024x1024 ----
# Android launcher icons top out at 192px (xxxhdpi), but we keep a
# 1024px master so regenerating at any size later stays sharp.
if (Test-Path $jpg) {
    $src = [System.Drawing.Image]::FromFile($jpg)
    Write-Host "Source: $($src.Width) x $($src.Height)  JPEG"

    $size = 1024
    $master = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($master)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    # Fill white first: the source JPEG has no alpha, and a white
    # backdrop keeps the legacy square icon from showing black corners.
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()

    $master.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $master.Dispose()
    $src.Dispose()
    Write-Host "Master written: $png  (1024 x 1024)"
} elseif (Test-Path $png) {
    Write-Host "JPEG not found, reusing existing $png"
} else {
    Write-Host "ERROR: no source image available."
    exit 1
}

Write-Host ""
Write-Host "Generating mipmaps..."

# ---- 2. Reuse the existing generator ----
# make-icons.ps1 reads assets/icon.png and writes every density.
& (Join-Path $root "make-icons.ps1")

Write-Host ""
Write-Host "Done. Rebuild with:"
Write-Host "  cd $root"
Write-Host "  npx cap sync android"
Write-Host "  cd android"
Write-Host "  .\gradlew.bat assembleDebug"
Write-Host ""
Write-Host "Uninstall the old app first, or Android may keep showing"
Write-Host "the cached launcher icon."
