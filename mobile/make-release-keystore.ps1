# =============================================================
#  Create the release signing keystore, once, and print the
#  fingerprints the vendor push platforms ask for.
#
#  Usage (in PowerShell):
#     cd E:\miniSoftware\ProjectRecorder\mobile
#     powershell -File make-release-keystore.ps1
#
#  ## Why this must come FIRST
#
#  Huawei and Honor validate the app's signing certificate when you
#  register a push app. If you register while the app is debug-signed
#  and later switch to a release certificate, **every vendor
#  registration breaks** and has to be redone.
#
#  So: create the release keystore first, register the vendor apps
#  with THAT certificate's fingerprint, then never change it.
#
#  ## What it does
#
#     1. generates the keystore (release.keystore)
#     2. writes keystore.properties (credentials, gitignored)
#     3. prints SHA-256 / SHA-1 fingerprints
#        -> paste the SHA-256 into Huawei / Honor consoles
#
#  ## READ THIS
#
#  * The keystore file AND its password are the only way to ship
#    future updates of this app. **Lose them and you cannot update.**
#    Back up both somewhere safe (password manager + offline copy).
#
#  * Do not commit release.keystore or keystore.properties.
#    .gitignore already excludes them.
#
#  * ASCII-only on purpose: Windows PowerShell 5.1 decodes a
#    BOM-less file as GBK, which mangles Chinese text and full-width
#    punctuation badly enough to break the parser.
# =============================================================

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$appDir      = Join-Path $projectRoot "android\app"
$storeFile   = Join-Path $appDir "release.keystore"
$propsFile   = Join-Path $appDir "keystore.properties"

Write-Host ""
Write-Host "=== Release keystore ===" -ForegroundColor Cyan
Write-Host ""

if (Test-Path $storeFile) {
    Write-Host "release.keystore already exists:" -ForegroundColor Yellow
    Write-Host "  $storeFile"
    Write-Host ""
    $again = Read-Host "Recreating it will BREAK apps already registered with the old signature. Recreate? (type YES)"
    if ($again -ne "YES") {
        Write-Host "Kept the existing keystore." -ForegroundColor Green
        Write-Host ""
        Write-Host "Printing its fingerprints anyway (useful for the vendor consoles)..."
    } else {
        Remove-Item $storeFile -Force
        if (Test-Path $propsFile) { Remove-Item $propsFile -Force }
    }
}

if (-not (Test-Path $storeFile)) {
    # ---------- passwords ----------
    Write-Host "Choose a keystore password."
    Write-Host "It must be at least 6 characters. It will NOT be shown." -ForegroundColor DarkGray
    Write-Host ""

    $pass1 = Read-Host "Keystore password" -AsSecureString
    $plain1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass1))
    if (-not $plain1 -or $plain1.Length -lt 6) {
        Write-Host "Password too short (need 6+). Aborting." -ForegroundColor Red
        exit 1
    }

    $pass2 = Read-Host "Repeat password" -AsSecureString
    $plain2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass2))
    if ($plain1 -ne $plain2) {
        Write-Host "Passwords do not match. Aborting." -ForegroundColor Red
        exit 1
    }

    $alias = Read-Host "Key alias [Enter = projectrecorder]"
    if (-not $alias) { $alias = "projectrecorder" }

    # ---------- find keytool ----------
    $keytool = $null
    if ($env:JAVA_HOME) {
        $candidate = Join-Path $env:JAVA_HOME "bin\keytool.exe"
        if (Test-Path $candidate) { $keytool = $candidate }
    }
    if (-not $keytool) {
        $cmd = Get-Command keytool -ErrorAction SilentlyContinue
        if ($cmd) { $keytool = $cmd.Source }
    }
    if (-not $keytool) {
        # Android Studio bundles a JDK
        $guesses = @(
            "$env:ProgramFiles\Android\Android Studio\jbr\bin\keytool.exe",
            "$env:LOCALAPPDATA\Programs\Android Studio\jbr\bin\keytool.exe",
            "D:\Android\Android Studio\jbr\bin\keytool.exe"
        )
        foreach ($g in $guesses) { if (Test-Path $g) { $keytool = $g; break } }
    }
    if (-not $keytool) {
        Write-Host "Cannot find keytool. Install a JDK or Android Studio, then re-run." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "Using keytool: $keytool" -ForegroundColor DarkGray

    # ---------- create ----------
    Write-Host ""
    Write-Host "Creating the keystore..."
    & $keytool -genkeypair -v `
        -keystore $storeFile `
        -alias $alias `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $plain1 -keypass $plain1 `
        -dname "CN=ProjectRecorder, OU=Mobile, O=ProjectRecorder, L=Unknown, ST=Unknown, C=CN"

    if (-not (Test-Path $storeFile)) {
        Write-Host "Keystore creation failed." -ForegroundColor Red
        exit 1
    }

    # ---------- credentials file ----------
    @(
        "# Written by make-release-keystore.ps1 -- DO NOT COMMIT",
        "storeFile=release.keystore",
        "storePassword=$plain1",
        "keyAlias=$alias",
        "keyPassword=$plain1"
    ) | Set-Content -Path $propsFile -Encoding ASCII

    Write-Host "Keystore created." -ForegroundColor Green
    Write-Host ""
    Write-Host "  $storeFile"
    Write-Host "  $propsFile"
}

# ---------- fingerprints ----------
Write-Host ""
Write-Host "=== Certificate fingerprints ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Huawei and Honor ask for the SHA-256. Copy the line below it." -ForegroundColor DarkGray
Write-Host ""

$props = @{}
Get-Content $propsFile | ForEach-Object {
    $t = $_.Trim()
    if ($t -and -not $t.StartsWith("#") -and $t.Contains("=")) {
        $i = $t.IndexOf("=")
        $props[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1)
    }
}

$keytool = $null
if ($env:JAVA_HOME) {
    $c = Join-Path $env:JAVA_HOME "bin\keytool.exe"
    if (Test-Path $c) { $keytool = $c }
}
if (-not $keytool) {
    $cmd = Get-Command keytool -ErrorAction SilentlyContinue
    if ($cmd) { $keytool = $cmd.Source }
}
if (-not $keytool) {
    foreach ($g in @(
        "$env:ProgramFiles\Android\Android Studio\jbr\bin\keytool.exe",
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr\bin\keytool.exe")) {
        if (Test-Path $g) { $keytool = $g; break }
    }
}

& $keytool -list -v `
    -keystore $storeFile `
    -alias $props["keyAlias"] `
    -storepass $props["storePassword"] 2>&1 |
    Select-String -Pattern "SHA1:|SHA256:|MD5:|Valid from|Alias name" |
    ForEach-Object { "  " + $_.Line.Trim() }

Write-Host ""
Write-Host "=== Next ===" -ForegroundColor Cyan
Write-Host ""
Write-Host " 1. Copy the SHA-256 above into the Huawei and Honor consoles"
Write-Host "    (they validate the app signature; a mismatch means no"
Write-Host "     offline push on those brands)."
Write-Host ""
Write-Host " 2. BACK UP both files somewhere safe:"
Write-Host "      $storeFile"
Write-Host "      $propsFile"
Write-Host "    Lose them and you can never ship an update to this app."
Write-Host ""
Write-Host " 3. Then register the vendor push apps and run:"
Write-Host "      powershell -File setup-push-params.ps1"
Write-Host ""
