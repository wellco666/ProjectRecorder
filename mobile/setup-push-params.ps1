# =============================================================
#  Configure Getui (GeTui) push parameters
#
#  Usage (in PowerShell):
#     cd E:\miniSoftware\ProjectRecorder\mobile
#     powershell -File setup-push-params.ps1
#
#  ## What it does
#
#  Writes the Getui / vendor AppID and AppKey values into
#     C:\Users\<you>\.gradle\gradle.properties
#
#  That file lives outside the project, is not committed, and is
#  not packaged into the APK. It is the standard place for local
#  Android build parameters.
#
#  ## Important
#
#  * MasterSecret is NEVER asked for and NEVER written here.
#    It belongs only in the Supabase Edge Function secrets
#    (see SETUP-GETUI.md step 3). Anything inside the APK is
#    effectively public.
#
#  * Press Enter to skip any vendor you do not have yet, but skipped
#    vendor credentials mean that brand's offline channel is not enabled.
#    Fill every supported brand you intend to serve for broad background
#    delivery. Getui AppID + AppKey alone do not guarantee delivery after
#    the Android process sleeps or is killed.
#
#  * Running it again overwrites the same keys and leaves the
#    rest of the file alone.
#
#  ## Why this file is plain English / ASCII
#
#  Windows PowerShell 5.1 reads a BOM-less file as GBK, which
#  mangles Chinese text and full-width punctuation badly enough
#  to break the parser. Keeping this script ASCII-only means it
#  runs the same on every PowerShell version. (The project has
#  been bitten by encoding twice already: full-width dollar signs
#  breaking SQL delimiters, and this.)
# =============================================================

$ErrorActionPreference = "Stop"

$gradleDir = Join-Path $env:USERPROFILE ".gradle"
$propsFile = Join-Path $gradleDir "gradle.properties"

Write-Host ""
Write-Host "=== Getui push parameter setup ===" -ForegroundColor Cyan
Write-Host "Target file: $propsFile"
Write-Host ""

# key, label, required, hint
#
# Each entry carries where the value comes from and what that brand
# needs. A form is much easier to fill when the prompt itself says
# where the value lives, instead of jumping back to a table in a doc.
$fields = @(
    @{ Key = "GETUI_APPID"; Label = "Getui AppID"; Required = $true;
       Hint = "dev.getui.com -> your app -> App config" }
    @{ Key = "GETUI_APPKEY"; Label = "Getui AppKey"; Required = $true;
       Hint = "dev.getui.com -> your app -> App config" }
    @{ Key = "VIVO_APP_ID"; Label = "vivo AppID"; Required = $false;
       Hint = "dev.vivo.com.cn -> Push -> app details. Needs AppID + AppKey." }
    @{ Key = "VIVO_APP_KEY"; Label = "vivo AppKey"; Required = $false;
       Hint = "same page as vivo AppID" }
    @{ Key = "XIAOMI_APP_ID"; Label = "Xiaomi AppID"; Required = $false;
       Hint = "dev.mi.com -> Push -> app. Needs AppID + AppKey." }
    @{ Key = "XIAOMI_APP_KEY"; Label = "Xiaomi AppKey"; Required = $false;
       Hint = "same page as Xiaomi AppID" }
    @{ Key = "OPPO_APP_KEY"; Label = "OPPO AppKey"; Required = $false;
       Hint = "open.oppomobile.com -> Push -> app. Needs AppKey + AppSecret (no AppID)." }
    @{ Key = "OPPO_APP_SECRET"; Label = "OPPO AppSecret"; Required = $false;
       Hint = "same page as OPPO AppKey" }
    @{ Key = "HUAWEI_APP_ID"; Label = "Huawei AppID"; Required = $false;
       Hint = "developer.huawei.com -> Push Kit. ALSO needs the signing SHA-256." }
    @{ Key = "HONOR_APP_ID"; Label = "Honor AppID"; Required = $false;
       Hint = "developer.honor.com -> Push. ALSO needs the signing SHA-256." }
    @{ Key = "MEIZU_APP_ID"; Label = "Meizu AppID"; Required = $false;
       Hint = "open.flyme.cn -> Push -> app. Needs AppID + AppKey." }
    @{ Key = "MEIZU_APP_KEY"; Label = "Meizu AppKey"; Required = $false;
       Hint = "same page as Meizu AppID" }
)

# Read existing values first so unrelated keys survive.
$existing = @{}
$order = @()
if (Test-Path $propsFile) {
    Get-Content $propsFile | ForEach-Object {
        $line = $_.Trim()
        if ($line.Length -gt 0 -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $i = $line.IndexOf("=")
            $k = $line.Substring(0, $i).Trim()
            $v = $line.Substring($i + 1)
            if (-not $existing.ContainsKey($k)) { $order += $k }
            $existing[$k] = $v
        }
    }
    Write-Host "Loaded $($existing.Count) existing entries." -ForegroundColor DarkGray
    Write-Host ""
}

Write-Host "Press Enter to skip (keeps any existing value)." -ForegroundColor DarkGray
Write-Host "Every prompt says where the value comes from." -ForegroundColor DarkGray
Write-Host ""

$index = 0
foreach ($f in $fields) {
    $index += 1
    $current = ""
    if ($existing.ContainsKey($f.Key)) { $current = $existing[$f.Key] }

    # Where to get it: printed above the prompt so it is readable while typing.
    Write-Host ("  [" + $index + "/" + $fields.Count + "] " + $f.Hint) -ForegroundColor DarkCyan

    $mark = ""
    if ($f.Required) { $mark = " [REQUIRED]" }
    $state = ""
    if ($current.Length -gt 0) {
        # Show only the length, never the value.
        $state = " (already set, " + $current.Length + " chars - Enter keeps it)"
    }

    $prompt = "      " + $f.Label + $mark + $state
    $value = Read-Host $prompt

    if ($value -and $value.Trim().Length -gt 0) {
        $existing[$f.Key] = $value.Trim()
        if ($order -notcontains $f.Key) { $order += $f.Key }
    } elseif (-not $existing.ContainsKey($f.Key)) {
        $existing[$f.Key] = ""
        if ($order -notcontains $f.Key) { $order += $f.Key }
    }
    Write-Host ""
}

# Required check
$missing = @()
foreach ($f in $fields) {
    if ($f.Required -and -not $existing[$f.Key]) { $missing += $f.Label }
}
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host ("Missing required: " + ($missing -join ", ")) -ForegroundColor Yellow
    Write-Host "Getui AppID / AppKey are needed to send anything." -ForegroundColor Yellow
    Write-Host "Create an app at https://dev.getui.com first." -ForegroundColor Yellow
    Write-Host "Values saved; re-run this script after you get them." -ForegroundColor DarkGray
}

# Write back, preserving comments and unrelated keys.
if (-not (Test-Path $gradleDir)) {
    New-Item -ItemType Directory -Path $gradleDir -Force | Out-Null
}

$kept = @()
if (Test-Path $propsFile) {
    $kept = Get-Content $propsFile | Where-Object {
        $t = $_.Trim()
        $drop = $false
        if ($t.Length -gt 0 -and -not $t.StartsWith("#") -and $t.Contains("=")) {
            $k = $t.Substring(0, $t.IndexOf("=")).Trim()
            if ($existing.ContainsKey($k)) { $drop = $true }
        }
        -not $drop
    }
}

$out = @()
$out += $kept
$out += ""
$out += "# --- push parameters (written by setup-push-params.ps1) ---"
foreach ($k in $order) {
    if ($existing[$k]) { $out += ($k + "=" + $existing[$k]) }
}

# Write as UTF-8. Values are normally plain ASCII (IDs and keys),
# so encoding does not matter for the content itself.
$out | Set-Content -Path $propsFile -Encoding UTF8

Write-Host ""
Write-Host "=== Written ===" -ForegroundColor Green
foreach ($k in $order) {
    if ($existing[$k]) {
        # Show only the length. These are credentials; never echo them.
        Write-Host ("  {0,-20} set ({1} chars)" -f $k, $existing[$k].Length)
    }
}

# ---------- brand coverage ----------
#
# Which phone brands now have an offline (vendor) push channel.
# The point of filling these in: without a vendor channel the app can
# only rely on Getui's own online connection, which dies when the app
# is force-stopped or the system freezes it in deep sleep.
#
# Nuts/Sony/Hisense are not listed: they go through Getui UPS and need
# no per-brand IDs.
Write-Host ""
Write-Host "=== Brand coverage ===" -ForegroundColor Cyan
Write-Host ""

$brands = @(
    @{ Name = "vivo";   Keys = @("VIVO_APP_ID", "VIVO_APP_KEY") },
    @{ Name = "Xiaomi"; Keys = @("XIAOMI_APP_ID", "XIAOMI_APP_KEY") },
    @{ Name = "OPPO";   Keys = @("OPPO_APP_KEY", "OPPO_APP_SECRET") },
    @{ Name = "Huawei"; Keys = @("HUAWEI_APP_ID") },
    @{ Name = "Honor";  Keys = @("HONOR_APP_ID") },
    @{ Name = "Meizu";  Keys = @("MEIZU_APP_ID", "MEIZU_APP_KEY") }
)

$ready = 0
foreach ($b in $brands) {
    $have = 0
    foreach ($k in $b.Keys) { if ($existing[$k]) { $have += 1 } }
    $pad = $b.Name.PadRight(8)
    if ($have -eq $b.Keys.Count) {
        Write-Host ("  " + $pad + " ready") -ForegroundColor Green
        $ready += 1
    } elseif ($have -eq 0) {
        Write-Host ("  " + $pad + " not configured")
    } else {
        $lack = @()
        foreach ($k in $b.Keys) { if (-not $existing[$k]) { $lack += $k } }
        Write-Host ("  " + $pad + " half done, still needs: " + ($lack -join ", ")) -ForegroundColor Yellow
    }
}
Write-Host ""
Write-Host ("  " + $ready + " of " + $brands.Count + " brands have an offline channel.") -ForegroundColor Cyan
Write-Host "  Nuts / Sony / Hisense need nothing: they use Getui UPS."
Write-Host ""
Write-Host "  Huawei and Honor also require the signing SHA-256 in their console."
Write-Host "  Run make-release-keystore.ps1 to print it."
Write-Host ""
Write-Host "Next: tell me the parameters are filled in, and I will verify and build." -ForegroundColor Cyan
Write-Host "Or run:  node check-getui-setup.js" -ForegroundColor Cyan
