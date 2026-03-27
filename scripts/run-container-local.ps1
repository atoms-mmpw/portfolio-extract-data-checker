# Docker Container Runner Script for Foyer Automation
# This script runs the Docker container with all necessary environment variables

$dotEnv = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
if (Test-Path $dotEnv) {
    Get-Content $dotEnv | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) { return }
        $i = $line.IndexOf('=')
        if ($i -lt 1) { return }
        $k = $line.Substring(0, $i).Trim()
        $v = $line.Substring($i + 1).Trim()
        if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($k, $v, 'Process')
    }
}

# Default values - use environment variables if set, otherwise use defaults
$GIT_EMAIL = if ($env:GIT_EMAIL) { $env:GIT_EMAIL } else { "adrian.sobotta@minchinmoore.com.au" }
$GIT_NAME = if ($env:GIT_NAME) { $env:GIT_NAME } else { "Adrian" }
$GIT_USERNAME = if ($env:GIT_USERNAME) { $env:GIT_USERNAME } else { "atoms-mmpw" }
$GIT_TOKEN = $env:GIT_TOKEN

Write-Host "[DOCKER] Starting Container..." -ForegroundColor Cyan
Write-Host "[GIT] Email: $GIT_EMAIL" -ForegroundColor Green
Write-Host "[GIT] Name: $GIT_NAME" -ForegroundColor Green
Write-Host "[GITHUB] Username: $GIT_USERNAME" -ForegroundColor Green
$tokenStatus = if ($GIT_TOKEN) { "[SET]" } else { "[NOT SET]" }
Write-Host "[GITHUB] Token: $tokenStatus" -ForegroundColor Green

# Run the container
docker run -d `
  --mount type=bind,source=c:/Users/AdrianSobotta/Development,target=/mnt/windows-development `
  --mount type=bind,source="C:/Users/AdrianSobotta/OneDrive - MINCHIN MOORE PRIVATE WEALTH PTY LTD/Information Technology - processes",target=/mnt/processes `
  --hostname portfolio-extract-data-checker `
  --name portfolio-extract-data-checker `
  -e GIT_EMAIL="$GIT_EMAIL" `
  -e GIT_NAME="$GIT_NAME" `
  -e GIT_USERNAME="$GIT_USERNAME" `
  -e GIT_TOKEN="$GIT_TOKEN" `
  mmpw/portfolio-extract-data-checker-image

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[SUCCESS] Container started successfully!" -ForegroundColor Green
    Write-Host "[INFO] To view logs: docker logs portfolio-extract-data-checker" -ForegroundColor Yellow
    Write-Host "[INFO] To access container: docker exec -it portfolio-extract-data-checker /bin/bash" -ForegroundColor Yellow
} else {
    Write-Host "`n[ERROR] Failed to start container" -ForegroundColor Red
    exit $LASTEXITCODE
}

