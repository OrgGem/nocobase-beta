# ==============================================================================
# NocoBase Production HA Stack Redeployment & Upgrade Script
# ==============================================================================
# This script automates the database backup, stack tear-down, pulls the latest 
# images (based on .env variables), and redeploys the NocoBase HA stack.
# ==============================================================================

$ErrorActionPreference = "Stop"

# 1. Load and parse .env file
if (-not (Test-Path ".env")) {
    Write-Error "Error: .env file not found. Please create it first by copying .env.example."
}

Write-Host "--- Loading Environment Variables from .env ---" -ForegroundColor Cyan
$envVars = @{}
Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#")) {
        if ($line -match '^([^=]+)=(.*)$') {
            $key = $Matches[1].Trim()
            $val = $Matches[2].Trim()
            # Remove optional surrounding quotes
            if ($val -match '^"(.*)"$') { $val = $Matches[1] }
            elseif ($val -match "^'(.*)'$") { $val = $Matches[1] }
            $envVars[$key] = $val
        }
    }
}

$nocobaseVersion = $envVars["NOCOBASE_VERSION"]
if (-not $nocobaseVersion) {
    $nocobaseVersion = "2.1.30-full"
}

Write-Host "Target NocoBase Version: $nocobaseVersion" -ForegroundColor Green

# 2. Database Backup (pg_dump)
Write-Host "`n--- Backing up NocoBase Database ---" -ForegroundColor Cyan
$postgresUser = if ($envVars["DB_USER"]) { $envVars["DB_USER"] } else { "nocobase" }
$postgresDb = if ($envVars["DB_DATABASE"]) { $envVars["DB_DATABASE"] } else { "nocobase" }
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpFilename = "nocobase-backup-$timestamp.dump"

$postgresContainer = docker compose ps -q postgres
if ($postgresContainer) {
    Write-Host "PostgreSQL container is running. Executing pg_dump..." -ForegroundColor Yellow
    # Create directory for dump if not exists inside container, or just write to /tmp
    docker exec $postgresContainer sh -c "pg_dump -U $postgresUser -d $postgresDb -Fc -f /tmp/backup.dump"
    if ($LASTEXITCODE -eq 0) {
        docker cp "${postgresContainer}:/tmp/backup.dump" "./$dumpFilename"
        if (Test-Path "./$dumpFilename") {
            $size = (Get-Item "./$dumpFilename").Length
            Write-Host "Database backup successfully saved to: ./$dumpFilename ($($size / 1MB -as [int]) MB)" -ForegroundColor Green
        } else {
            Write-Warning "Failed to copy backup file from container to host."
        }
    } else {
        Write-Warning "pg_dump failed inside the container. Proceeding with caution..."
    }
} else {
    Write-Host "PostgreSQL container is not running. Skipping backup step." -ForegroundColor Yellow
}

# 3. Pull newest images
Write-Host "`n--- Pulling target images ---" -ForegroundColor Cyan
Write-Host "Pulling app-main image (version: $nocobaseVersion)..." -ForegroundColor Yellow
docker compose pull app-main
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Failed to pull new app-main image. Will attempt to run using local/stale cache."
}

# 4. Redeploy Stack (Down & Up)
Write-Host "`n--- Redeploying docker-compose stack ---" -ForegroundColor Cyan
Write-Host "Stopping and removing existing containers..." -ForegroundColor Yellow
docker compose down

Write-Host "Starting stack in detached mode..." -ForegroundColor Yellow
docker compose up -d

# 5. Wait for app-main and both backups to become healthy
$httpPort = if ($envVars["HTTP_PORT"]) { $envVars["HTTP_PORT"] } else { "80" }
$healthUrl = "http://localhost/api/app:getInfo"
if ($httpPort -ne "80") {
    $healthUrl = "http://localhost:$httpPort/api/app:getInfo"
}

# Also try port 13000 directly since app-main binds to 13000
$directUrl = "http://localhost:13000/api/app:getInfo"

Write-Host "`n--- Waiting for NocoBase to upgrade & become healthy ---" -ForegroundColor Cyan
Write-Host "Monitoring app logs. This might take up to 2-3 minutes as migrations run." -ForegroundColor Yellow

$retries = 30
$delay = 10
$isHealthy = $false

for ($i = 1; $i -le $retries; $i++) {
    Write-Host "Checking health ($i/$retries)..." -ForegroundColor DarkGray
    $apiHealthy = $false
    try {
        # First check the app-main port directly.
        $response = Invoke-RestMethod -Uri $directUrl -Method Get -TimeoutSec 5 -ErrorAction Stop
        if ($response -and $response.data -and $response.data.version) {
            $apiHealthy = $true
        }
    } catch {
        # Fallback to check HTTP port through nginx
        try {
            $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5 -ErrorAction Stop
            if ($response -and $response.data -and $response.data.version) {
                $apiHealthy = $true
            }
        } catch {
            # Not ready yet
        }
    }

    $allAppsHealthy = $true
    foreach ($service in @("app-main", "app-backup-1", "app-backup-2")) {
        $containerId = docker compose ps -q $service
        if (-not $containerId) {
            $allAppsHealthy = $false
            continue
        }
        $health = docker inspect $containerId --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}"
        if ($health -ne "healthy") {
            $allAppsHealthy = $false
        }
    }

    if ($apiHealthy -and $allAppsHealthy) {
        $isHealthy = $true
        break
    }

    # Print the migration leader's latest logs to show progress.
    docker compose logs --tail=5 app-main
    Start-Sleep -Seconds $delay
}

if ($isHealthy) {
    $actualVersion = $response.data.version
    Write-Host "`n==================================================" -ForegroundColor Green
    Write-Host "SUCCESS: NocoBase HA stack redeployed successfully!" -ForegroundColor Green
    Write-Host "Running NocoBase Version: $actualVersion" -ForegroundColor Green
    Write-Host "Access NocoBase at: http://localhost:$httpPort/" -ForegroundColor Green
    Write-Host "==================================================" -ForegroundColor Green
} else {
    Write-Error "Timeout waiting for NocoBase to become healthy. Please check logs: 'docker compose logs app-main app-backup-1 app-backup-2'"
}
