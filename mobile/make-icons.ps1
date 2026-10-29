# =============================================================
#  Generate Android launcher icons (no external tools needed)
#
#  Why not @capacitor/assets:
#    it depends on "sharp", which downloads a prebuilt libvips
#    binary from GitHub. That download often fails on networks
#    in China. We only need to resize one 1024px image into a
#    few sizes, and Windows already ships .NET for that.
#
#  This script is deliberately ASCII-only.
#    Windows PowerShell 5.1 reads .ps1 files as GBK by default,
#    so UTF-8 Chinese comments get mangled and can even produce
#    a stray backtick that breaks parsing.
#
#  Three kinds of icons are generated:
#    ic_launcher.png            legacy square (Android 7 and older)
#    ic_launcher_round.png      legacy round
#    ic_launcher_foreground.png adaptive foreground (Android 8+)
#
#  Adaptive icon gotcha:
#    the canvas is 108dp but only the middle 72dp is guaranteed
#    visible. Anything outside gets cropped, and the crop shape
#    is decided by the phone vendor. So the foreground must be
#    scaled to about 62% and centred, with transparent padding.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File make-icons.ps1
# =============================================================

Add-Type -AssemblyName System.Drawing

$root = "E:\miniSoftware\ProjectRecorder\mobile"
$source = Join-Path $root "assets\icon.png"
$resDir = Join-Path $root "android\app\src\main\res"

if (-not (Test-Path $source)) {
    Write-Host "ERROR: source image not found: $source"
    Write-Host "Put a 1024x1024 PNG at mobile\assets\icon.png"
    exit 1
}

# Official Android launcher icon sizes per density bucket
$sizes = @{
    "mipmap-mdpi"    = 48
    "mipmap-hdpi"    = 72
    "mipmap-xhdpi"   = 96
    "mipmap-xxhdpi"  = 144
    "mipmap-xxxhdpi" = 192
}

function Resize-Image {
    param(
        [System.Drawing.Image]$Source,
        [int]$Size,
        [int]$InnerSize,
        [bool]$Transparent
    )
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $offset = [int](($Size - $InnerSize) / 2)
    $g.DrawImage($Source, $offset, $offset, $InnerSize, $InnerSize)
    $g.Dispose()
    return $bmp
}

$src = [System.Drawing.Image]::FromFile($source)
Write-Host "Source: $($src.Width) x $($src.Height)"
Write-Host ""

# ---- 1. Legacy icons: artwork fills the whole canvas ----
foreach ($folder in $sizes.Keys) {
    $size = $sizes[$folder]
    $dir = Join-Path $resDir $folder
    if (-not (Test-Path $dir)) {
        New-Item -Path $dir -ItemType Directory | Out-Null
    }

    $bmp = Resize-Image -Source $src -Size $size -InnerSize $size -Transparent $false

    $squarePath = Join-Path $dir "ic_launcher.png"
    $roundPath = Join-Path $dir "ic_launcher_round.png"
    $bmp.Save($squarePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Save($roundPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Host ("  {0,-16} {1,3}px  legacy square + round" -f $folder, $size)
}

Write-Host ""

# ---- 2. Adaptive foreground: 62% centred, transparent padding ----
foreach ($folder in $sizes.Keys) {
    $size = $sizes[$folder]
    $dir = Join-Path $resDir $folder
    $inner = [int]($size * 0.62)

    $bmp = Resize-Image -Source $src -Size $size -InnerSize $inner -Transparent $true
    $forePath = Join-Path $dir "ic_launcher_foreground.png"
    $bmp.Save($forePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Host ("  {0,-16} {1,3}px  foreground {2}px centred" -f $folder, $size, $inner)
}

$src.Dispose()

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  cd $root\android"
Write-Host "  .\gradlew.bat assembleDebug"
Write-Host ""
Write-Host "Uninstall the old app from the phone before installing the new one."
Write-Host "Android caches launcher icons, so an in-place update often"
Write-Host "still shows the old icon."
