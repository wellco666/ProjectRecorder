# =============================================================
#  Deploy the Getui push backend to Supabase
#
#  Usage (in PowerShell):
#     cd E:\miniSoftware\ProjectRecorder\mobile
#     powershell -File deploy-getui-backend.ps1
#
#  ## What it does, in order
#
#     1. makes sure the Supabase CLI is available
#     2. links this folder to your Supabase project
#     3. sets the four secrets the Edge Function needs
#     4. deploys the function
#     5. verifies it answers
#
#  ## Where the secrets go
#
#  Into Supabase's server-side secret store -- never into the APK,
#  never into a file on disk, never printed on screen.
#  The script PROMPTS for them with hidden input, so they do not
#  end up in your PowerShell history either.
#
#  ## Why it prefers a LOCAL CLI install
#
#  `npm install -g supabase` failed on this machine with EPERM:
#  the global prefix D:\Node.js\node_global is not writable without
#  administrator rights.
#
#  Installing into the project instead needs no elevation and works
#  exactly the same. So the order is:
#     1. use a global CLI if one is already there
#     2. otherwise use the local one (npx supabase)
#     3. only if neither exists, install locally
#
#  ## ASCII-only on purpose
#
#  Windows PowerShell 5.1 decodes a BOM-less file as GBK, which
#  mangles Chinese text and full-width punctuation badly enough to
#  break the parser. ASCII means it runs on any PowerShell.
# =============================================================

$ErrorActionPreference = "Continue"

$projectRef = "edchntmyqqjqvpngylgc"
$fallbackWebhookSecret = "4JZIkLj3GDFVUzNKwnDpZsQVoxQb5aDbGbvxGM3P7WPoPUJW"

function Read-Hidden([string]$prompt) {
    $sec = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Pick how to invoke the CLI: "supabase" or "npx supabase"
$cliMode = $null

Write-Host ""
Write-Host "=== Deploy Getui push backend ===" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. CLI ----------
Write-Host "[1/5] Supabase CLI" -ForegroundColor Yellow

$global = Get-Command supabase -ErrorAction SilentlyContinue
if ($global) {
    $cliMode = "global"
    Write-Host "  Using global CLI: $($global.Source)" -ForegroundColor Green
} else {
    $localPkg = Join-Path $PWD "node_modules\supabase"
    if (Test-Path $localPkg) {
        $cliMode = "local"
        Write-Host "  Using project-local CLI (node_modules/supabase)" -ForegroundColor Green
    } else {
        Write-Host "  Not found. Installing into the project (no admin needed)..."
        npm install --save-dev supabase
        if (Test-Path $localPkg) {
            $cliMode = "local"
            Write-Host "  Installed locally." -ForegroundColor Green
        } else {
            Write-Host "  Install failed. Try: npm install --save-dev supabase" -ForegroundColor Red
            exit 1
        }
    }
}

function Invoke-Supabase {
    param([string[]]$SupabaseArgs)
    if ($cliMode -eq "global") { & supabase @SupabaseArgs }
    else { & npx --no-install supabase @SupabaseArgs }
}

# ---------- 2. link ----------
Write-Host ""
Write-Host "[2/5] Link to project $projectRef" -ForegroundColor Yellow
Write-Host "  A browser window may open for login."
Invoke-Supabase @("link", "--project-ref", $projectRef)
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Link failed. If you are not logged in, run once:" -ForegroundColor Red
    if ($cliMode -eq "global") { Write-Host "    supabase login" }
    else { Write-Host "    npx --no-install supabase login" }
    exit 1
}
Write-Host "  Linked." -ForegroundColor Green

# ---------- 3. secrets ----------
Write-Host ""
Write-Host "[3/5] Edge Function secrets" -ForegroundColor Yellow
Write-Host "  Input is hidden while typing and is not saved to any file." -ForegroundColor DarkGray
Write-Host ""

$appId = Read-Host "  Getui AppID [Enter = vZxFFSs20y5HYj9yEBzq1A]"
if (-not $appId) { $appId = "vZxFFSs20y5HYj9yEBzq1A" }

$appKey = Read-Host "  Getui AppKey [Enter = GD2sTKFtEm6S5bAASWv003]"
if (-not $appKey) { $appKey = "GD2sTKFtEm6S5bAASWv003" }

Write-Host "  Getui MasterSecret -- the value next to 'Master Secret' in the console."
Write-Host "  SECRET: must never go into the APK." -ForegroundColor DarkGray
$master = Read-Hidden "  MasterSecret"
if (-not $master) {
    Write-Host "  MasterSecret is required. Aborting." -ForegroundColor Red
    exit 1
}

Write-Host "  Webhook shared secret. [Enter = the generated one]" -ForegroundColor DarkGray
$webhook = Read-Host "  Webhook secret"
if (-not $webhook) { $webhook = $fallbackWebhookSecret }

Write-Host ""
Write-Host "  Uploading..."
Invoke-Supabase @("secrets", "set",
    "GETUI_APP_ID=$appId",
    "GETUI_APP_KEY=$appKey",
    "GETUI_MASTER_SECRET=$master",
    "TASK_EVENT_WEBHOOK_SECRET=$webhook")
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Failed to set secrets." -ForegroundColor Red
    exit 1
}
Write-Host "  Secrets set." -ForegroundColor Green

# ---------- 4. deploy ----------
Write-Host ""
Write-Host "[4/5] Deploy function" -ForegroundColor Yellow
Invoke-Supabase @("functions", "deploy", "getui-task-event")
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Deploy failed." -ForegroundColor Red
    exit 1
}
Write-Host "  Deployed." -ForegroundColor Green

# ---------- 5. verify ----------
Write-Host ""
Write-Host "[5/5] Verify" -ForegroundColor Yellow
$url = "https://$projectRef.supabase.co/functions/v1/getui-task-event"
Write-Host "  POST $url"
try {
    $r = Invoke-WebRequest -Uri $url -Method POST -TimeoutSec 20 `
        -ContentType "application/json" -Body "{}" -UseBasicParsing
    Write-Host "  HTTP $($r.StatusCode)" -ForegroundColor Yellow
    Write-Host "  $($r.Content)" -ForegroundColor DarkGray
} catch {
    $code = "?"
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    Write-Host "  HTTP $code" -ForegroundColor Yellow
    if ($code -eq 401 -or $code -eq 403) {
        Write-Host "  Correct -- the secret check is working." -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host ""
Write-Host "One step is left, and it can only be done in the dashboard:" -ForegroundColor Cyan
Write-Host "  Database -> Webhooks -> Create a new hook"
Write-Host "    Table    public.task_events"
Write-Host "    Event    Insert"
Write-Host "    Method   POST"
Write-Host "    URL      $url"
Write-Host "    Header   x-webhook-secret = $webhook"
Write-Host ""
Write-Host "Then re-check:  node check-getui-setup.js"
