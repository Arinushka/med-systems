param(
  [string]$SshKey = "$env:USERPROFILE\.ssh\yc_med_systems",
  [string]$RemoteHost = "ubuntu@158.160.78.4",
  [string]$RemoteAppDir = "~/med-systems"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $SshKey)) {
  throw "SSH key not found: $SshKey"
}

function Invoke-Npm([string]$Dir, [string]$Script) {
  Push-Location $Dir
  try {
    if (Test-Path ".\node_modules\.bin\npm.cmd") {
      & ".\node_modules\.bin\npm.cmd" run $Script
    } else {
      npm run $Script
    }
    if ($LASTEXITCODE -ne 0) { throw "npm run $Script failed in $Dir" }
  } finally {
    Pop-Location
  }
}

Write-Host "Building backend..."
Invoke-Npm (Join-Path $Root "backend") "build"

Write-Host "Building frontend..."
Invoke-Npm (Join-Path $Root "frontend-react") "build"

$archive = Join-Path $env:TEMP "med-systems-deploy.tgz"
if (Test-Path $archive) { Remove-Item $archive -Force }

Write-Host "Creating archive (preserving remote backend/data and backend/.env)..."
Push-Location $Root
try {
  tar -czf $archive `
    --exclude=node_modules `
    --exclude=backend/node_modules `
    --exclude=frontend-react/node_modules `
    --exclude=backend/data `
    --exclude=backend/.env `
    --exclude=.git `
  backend frontend-react scripts
} finally {
  Pop-Location
}

Write-Host "Uploading archive..."
scp -i $SshKey -o StrictHostKeyChecking=accept-new $archive "${RemoteHost}:~/med-systems-deploy.tgz"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

$remoteScript = @"
set -euo pipefail
APP_DIR=$RemoteAppDir
mkdir -p "\$APP_DIR/backend" "\$APP_DIR/frontend-react"

if [ -d "\$APP_DIR/backend/data" ]; then
  rm -rf /tmp/med-systems-data-backup
  cp -a "\$APP_DIR/backend/data" /tmp/med-systems-data-backup
fi
if [ -f "\$APP_DIR/backend/.env" ]; then
  cp "\$APP_DIR/backend/.env" /tmp/med-systems-env-backup
fi

tar -xzf ~/med-systems-deploy.tgz -C "\$APP_DIR"

if [ -d /tmp/med-systems-data-backup ]; then
  rm -rf "\$APP_DIR/backend/data"
  mv /tmp/med-systems-data-backup "\$APP_DIR/backend/data"
fi
if [ -f /tmp/med-systems-env-backup ]; then
  mv /tmp/med-systems-env-backup "\$APP_DIR/backend/.env"
fi

cd "\$APP_DIR/backend"
npm ci
npm run build

cd "\$APP_DIR/frontend-react"
npm ci
npm run build

if systemctl is-active --quiet med-systems 2>/dev/null; then
  sudo systemctl restart med-systems
elif systemctl is-active --quiet med-systems-backend 2>/dev/null; then
  sudo systemctl restart med-systems-backend
elif command -v pm2 >/dev/null 2>&1; then
  pm2 restart med-systems-backend || pm2 restart backend || pm2 restart all
else
  pkill -f 'node.*dist/index.js' || true
  cd "\$APP_DIR/backend"
  nohup npm run start > ~/med-systems-backend.log 2>&1 &
fi

rm -f ~/med-systems-deploy.tgz
echo "Deploy complete. Data dir preserved at \$APP_DIR/backend/data"
"@

Write-Host "Running remote deploy..."
ssh -i $SshKey -o StrictHostKeyChecking=accept-new $RemoteHost $remoteScript
if ($LASTEXITCODE -ne 0) { throw "remote deploy failed" }

Write-Host "Done."
