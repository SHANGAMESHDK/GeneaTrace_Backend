# Copies the backend's configuration from backend/.env into the Azure App Service settings and
# switches the app to Node 22 running Next.js. Run it yourself (it handles your secrets):
#
#   powershell -ExecutionPolicy Bypass -File deploy\azure-app-settings.ps1
#
# LEDGER_SECRET must stay identical to the one that signed the existing Supabase chain,
# otherwise every existing block and passport fails verification.
param(
  [string]$App = "geneatrace-api",
  [string]$ResourceGroup = "geneatrace-rg",
  [string]$FrontendUrl = "https://geneatrace.vercel.app"
)
$ErrorActionPreference = "Stop"
$envFile = Join-Path $PSScriptRoot "..\backend\.env"
if (-not (Test-Path $envFile)) { throw "backend/.env not found" }

$vals = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $vals[$Matches[1]] = $Matches[2].Trim() }
}
foreach ($k in "DATABASE_URL", "LEDGER_SECRET", "ADMIN_API_KEY", "ADMIN_PASSWORD") {
  if (-not $vals[$k]) { throw "$k is empty in backend/.env" }
}
if ($vals["ADMIN_API_KEY"] -eq "gt_admin_dev_key") {
  Write-Host "ADMIN_API_KEY is still the public default. Put a long random value in backend/.env first." -ForegroundColor Yellow
  exit 1
}

Write-Host "Switching $App to Node 22 (Next.js start command)..."
az webapp config set -g $ResourceGroup -n $App --linux-fx-version "NODE|22-lts" --startup-file "npm start" --output none

Write-Host "Writing app settings (values are not printed)..."
$settings = @(
  "DATABASE_URL=$($vals['DATABASE_URL'])",
  "LEDGER_SECRET=$($vals['LEDGER_SECRET'])",
  "ADMIN_API_KEY=$($vals['ADMIN_API_KEY'])",
  "ADMIN_PASSWORD=$($vals['ADMIN_PASSWORD'])",
  "DEMO_MODE=true",
  "POW_DIFFICULTY=3",
  "PUBLIC_APP_URL=$FrontendUrl",
  "CORS_ORIGINS=$FrontendUrl,http://localhost:5173",
  "WEBSITES_PORT=8080",
  "SCM_DO_BUILD_DURING_DEPLOYMENT=false",
  "NEXT_TELEMETRY_DISABLED=1"
)
# Ethereum anchoring: sent only for a public network (a localhost chain is unreachable from Azure).
$rpc = $vals['ETH_RPC_URL']
if ($rpc -and $rpc -notmatch 'localhost|127\.0\.0\.1') {
  foreach ($k in "ETH_PRIVATE_KEY", "ETH_CONTRACT_ADDRESS", "ETH_CHAIN_ID") {
    if (-not $vals[$k]) { throw "$k is empty in backend/.env (run the Sepolia deploy first)" }
  }
  $settings += "ETH_RPC_URL=$rpc", "ETH_PRIVATE_KEY=$($vals['ETH_PRIVATE_KEY'])", "ETH_CONTRACT_ADDRESS=$($vals['ETH_CONTRACT_ADDRESS'])", "ETH_CHAIN_ID=$($vals['ETH_CHAIN_ID'])", "ETH_EXPLORER_URL=https://sepolia.etherscan.io"
  Write-Host "Ethereum anchoring: ON (chain $($vals['ETH_CHAIN_ID']), contract $($vals['ETH_CONTRACT_ADDRESS']))"
} else {
  Write-Host "Ethereum anchoring: off (no public-network ETH_RPC_URL in backend/.env)"
}
az webapp config appsettings set -g $ResourceGroup -n $App --settings $settings --output none
az webapp restart -g $ResourceGroup -n $App --output none
Write-Host "Done. Next push to GeneaTrace_Backend main deploys the Next.js backend." -ForegroundColor Green
