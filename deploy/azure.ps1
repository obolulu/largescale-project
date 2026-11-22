<#
.SYNOPSIS
  Deploys the billing stack to Azure: PostgreSQL Flexible Server, a container
  registry, and three Container Apps (internal API, public Kong gateway, public
  MCP server). Every step can be re-run; existing resources are reused.

.DESCRIPTION
  Steps, in order (run one with -Step, or -Step all):
    infra   resource group, providers, registry, PostgreSQL, Container Apps environment
    images  build the three images and push them to the registry
    apps    create or update the three Container Apps
    seed    open the database firewall for this machine, migrate, load the demo data
    test    run gateway/test against the cloud gateway
    status  print URLs and health
  Cost control:
    stop    stop the PostgreSQL server (billing for compute stops; storage continues)
    start   start it again

  Generated secrets (JWT secret, database password) and resource names are kept in
  deploy/.azure.local.json, which is gitignored. Never commit it.

  Needs: Azure CLI (`az login` done), Docker Desktop running (or -CloudBuild),
  Node.js for the seed and test steps.

.EXAMPLE
  .\deploy\azure.ps1 -Step infra
  .\deploy\azure.ps1 -Step images
  .\deploy\azure.ps1 -Step apps
  .\deploy\azure.ps1 -Step seed
  .\deploy\azure.ps1 -Step test
#>
[CmdletBinding()]
param(
  [ValidateSet('infra', 'images', 'apps', 'seed', 'test', 'status', 'all', 'stop', 'start')]
  [string]$Step = 'status',
  # Azure for Students only allows a few regions; francecentral is one of them.
  [string]$Location = 'francecentral',
  [string]$ResourceGroup = 'rg-billing-se4458',
  # PostgreSQL can be put elsewhere when its SKU has no capacity in $Location
  # for this subscription (SkuNotAvailable). Empty = $Location.
  [string]$PgLocation = '',
  # Availability zone for PostgreSQL (1, 2 or 3). Empty = let Azure pick.
  [string]$PgZone = '',
  # Build images in Azure (ACR Tasks) instead of with local Docker.
  [switch]$CloudBuild,
  # seed: wipe the billing tables first.
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$StateFile = Join-Path $PSScriptRoot '.azure.local.json'

# winget installs the CLI here; a terminal opened before the install doesn't have it on PATH.
$azDir = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin'
if (-not (Get-Command az -ErrorAction SilentlyContinue) -and (Test-Path $azDir)) { $env:Path += ";$azDir" }

function Write-Stage([string]$Text) { Write-Host "`n=== $Text" -ForegroundColor Cyan }

# Runs az and stops on failure. The error names only the command, never the
# arguments, because some of them are secrets.
function Invoke-AzCli {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args[0]) $($args[1]) $($args[2]) failed (exit $LASTEXITCODE)" }
}

function Get-AzValue {
  $out = & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args[0]) $($args[1]) $($args[2]) failed (exit $LASTEXITCODE)" }
  if ($null -eq $out) { return '' }
  return ($out | Out-String).Trim()
}

function Test-AzResource([string]$Type, [string]$Name) {
  # No parentheses in the query: az.cmd goes through cmd.exe, which chokes on them.
  $found = Get-AzValue resource list -g $ResourceGroup --resource-type $Type --name $Name --query '[].name' -o tsv
  return [bool]$found
}

function New-RandomString([int]$Length, [string]$Alphabet) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] $Length
  $rng.GetBytes($bytes)
  $chars = foreach ($b in $bytes) { $Alphabet[$b % $Alphabet.Length] }
  return -join $chars
}

function Get-State {
  if (Test-Path $StateFile) {
    return Get-Content $StateFile -Raw | ConvertFrom-Json
  }
  $lower = 'abcdefghijklmnopqrstuvwxyz0123456789'
  $mixed = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  # Alphanumeric only, so no value needs quoting on the way through az.cmd.
  # The fixed prefix guarantees the upper/lower/digit mix Azure requires.
  $state = [pscustomobject]@{
    suffix     = New-RandomString 6 $lower
    dbPassword = 'Pg1' + (New-RandomString 29 $mixed)
    jwtSecret  = New-RandomString 48 $mixed
  }
  $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
  Write-Host "Created $StateFile (secrets; gitignored)."
  return $state
}

$State = Get-State

# Regions are chosen on the first infra run and remembered, so later steps
# don't need -Location again. Passing -Location / -PgLocation overrides.
function Get-StateValue([string]$Name) {
  $p = $State.PSObject.Properties[$Name]
  if ($p) { return [string]$p.Value }
  return ''
}
function Set-StateValue([string]$Name, [string]$Value) {
  $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  $State | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}
if (-not $PSBoundParameters.ContainsKey('Location') -and (Get-StateValue 'location')) { $Location = Get-StateValue 'location' }
if (-not $PgLocation) { $PgLocation = Get-StateValue 'pgLocation' }
if (-not $PgLocation) { $PgLocation = $Location }

$Names = @{
  acr      = "acrbilling$($State.suffix)"
  # The region is part of the name: a failed create can keep a name reserved for a while.
  postgres = "pg-billing-$($State.suffix)-$PgLocation"
  env      = 'cae-billing'
  api      = 'billing-api'
  gateway  = 'billing-gateway'
  mcp      = 'billing-mcp'
}
$DbAdmin = 'billingadmin'
$DbName = 'billing'
$DbHost = "$($Names.postgres).postgres.database.azure.com"
$DatabaseUrl = "postgresql://${DbAdmin}:$($State.dbPassword)@${DbHost}:5432/${DbName}?sslmode=verify-full"
$Registry = "$($Names.acr).azurecr.io"

function Get-AppFqdn([string]$App) {
  return Get-AzValue containerapp show -g $ResourceGroup -n $App --query properties.configuration.ingress.fqdn -o tsv
}

function Step-Infra {
  Write-Stage "Subscription"
  Invoke-AzCli account show --query "{subscription:name, state:state}" -o table

  Write-Stage "Containerapp CLI extension"
  # Only install when missing: an in-place upgrade can end the calling process
  # when it runs without a console (seen with background runs).
  $ext = Get-AzValue extension list --query "[?name=='containerapp'].version" -o tsv
  if ($ext) { Write-Host "installed ($ext)" }
  else { Invoke-AzCli extension add --name containerapp --yes --only-show-errors }

  Write-Stage "Resource providers (one-time, can take a few minutes)"
  foreach ($p in 'Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.DBforPostgreSQL', 'Microsoft.OperationalInsights') {
    # Not $state: PowerShell names are case-insensitive and $State holds the secrets.
    $registration = Get-AzValue provider show -n $p --query registrationState -o tsv
    if ($registration -ne 'Registered') {
      Write-Host "Registering $p ..."
      Invoke-AzCli provider register -n $p --wait
    } else { Write-Host "$p registered" }
  }

  Write-Stage "Resource group $ResourceGroup"
  # A group's own region is only metadata; resources inside can live elsewhere.
  if ((Get-AzValue group exists -n $ResourceGroup) -eq 'true') { Write-Host 'exists' }
  else { Invoke-AzCli group create -n $ResourceGroup -l $Location -o none }

  Write-Stage "Container registry $($Names.acr) (Basic)"
  if (Test-AzResource 'Microsoft.ContainerRegistry/registries' $Names.acr) { Write-Host 'exists' }
  else { Invoke-AzCli acr create -g $ResourceGroup -n $Names.acr -l $Location --sku Basic -o none }

  $pgLoc = $PgLocation
  Set-StateValue 'location' $Location
  Set-StateValue 'pgLocation' $pgLoc
  Write-Stage "PostgreSQL Flexible Server $($Names.postgres) (Burstable B1ms, v16, $pgLoc; takes 5-10 minutes)"
  if (Test-AzResource 'Microsoft.DBforPostgreSQL/flexibleServers' $Names.postgres) { Write-Host 'exists' }
  else {
    # --public-access 0.0.0.0 allows connections from Azure services only (the Container Apps).
    # Your laptop is added later by the seed step, for its own IP only.
    $pgArgs = @('postgres', 'flexible-server', 'create', '-g', $ResourceGroup, '-n', $Names.postgres, '-l', $pgLoc,
      '--tier', 'Burstable', '--sku-name', 'Standard_B1ms', '--storage-size', '32', '--version', '16',
      '--admin-user', $DbAdmin, '--admin-password', $State.dbPassword,
      '--public-access', '0.0.0.0', '--yes', '-o', 'none')
    if ($PgZone) { $pgArgs += '--zone'; $pgArgs += $PgZone }
    Invoke-AzCli @pgArgs
  }

  Write-Stage "Database '$DbName'"
  $dbs = Get-AzValue postgres flexible-server db list -g $ResourceGroup --server-name $Names.postgres --query '[].name' -o tsv
  if (($dbs -split "`r?`n") -contains $DbName) { Write-Host 'exists' }
  else { Invoke-AzCli postgres flexible-server db create -g $ResourceGroup --server-name $Names.postgres --name $DbName -o none }

  Write-Stage "Container Apps environment $($Names.env)"
  if (Test-AzResource 'Microsoft.App/managedEnvironments' $Names.env) {
    $mode = Get-AzValue containerapp env show -g $ResourceGroup -n $Names.env --query properties.environmentMode -o tsv
    Write-Host "exists (mode: $mode)"
    if ($mode -eq 'Express') {
      throw "Environment $($Names.env) is in Express mode, which lacks internal ingress and registry identity. Delete it (az containerapp env delete -g $ResourceGroup -n $($Names.env) --yes) and re-run -Step infra."
    }
  } else {
    # Explicit mode: newer CLI versions can create an Express environment otherwise.
    # WorkloadProfiles with the built-in Consumption profile is still pay-per-use.
    $envArgs = @('containerapp', 'env', 'create', '-g', $ResourceGroup, '-n', $Names.env, '-l', $Location,
      '--environment-mode', 'WorkloadProfiles', '-o', 'none')
    # Reuse a Log Analytics workspace already in the group instead of generating another.
    $ws = Get-AzValue monitor log-analytics workspace list -g $ResourceGroup --query '[0].name' -o tsv
    if ($ws) {
      $wsId = Get-AzValue monitor log-analytics workspace show -g $ResourceGroup -n $ws --query customerId -o tsv
      $wsKey = Get-AzValue monitor log-analytics workspace get-shared-keys -g $ResourceGroup -n $ws --query primarySharedKey -o tsv
      $envArgs += @('--logs-destination', 'log-analytics', '--logs-workspace-id', $wsId, '--logs-workspace-key', $wsKey)
    }
    Invoke-AzCli @envArgs
  }
}

$Tag = Get-Date -Format 'yyyyMMdd-HHmmss'
$Images = @(
  @{ name = 'billing-api'; dir = 'billing-api' },
  @{ name = 'billing-gateway'; dir = 'gateway' },
  @{ name = 'billing-mcp'; dir = 'mcp-server' }
)

function Step-Images {
  Write-Stage "Images, tag $Tag"
  if ($CloudBuild) {
    foreach ($img in $Images) {
      Invoke-AzCli acr build -r $Names.acr -t "$($img.name):$Tag" -t "$($img.name):latest" (Join-Path $RepoRoot $img.dir)
    }
  } else {
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker engine is not running. Start Docker Desktop, or re-run with -CloudBuild.' }
    Invoke-AzCli acr login -n $Names.acr
    foreach ($img in $Images) {
      $ref = "$Registry/$($img.name)"
      docker build --platform linux/amd64 -t "${ref}:$Tag" -t "${ref}:latest" (Join-Path $RepoRoot $img.dir)
      if ($LASTEXITCODE -ne 0) { throw "docker build $($img.name) failed" }
      docker push "${ref}:$Tag"; if ($LASTEXITCODE -ne 0) { throw "docker push $($img.name) failed" }
      docker push "${ref}:latest"; if ($LASTEXITCODE -ne 0) { throw "docker push $($img.name) failed" }
    }
  }
}

function Deploy-App {
  param([string]$App, [string]$Image, [string]$Ingress, [int]$Port, [string[]]$Secrets, [string[]]$EnvVars)
  $img = "$Registry/${Image}:latest"
  # Asked from Container Apps itself: the generic resource index lags after deletes.
  $existing = Get-AzValue containerapp list -g $ResourceGroup --query "[?name=='$App'].name" -o tsv
  if ($existing) {
    Write-Host "updating $App"
    if ($Secrets) { Invoke-AzCli containerapp secret set -g $ResourceGroup -n $App --secrets @Secrets -o none }
    # A new revision suffix forces a new revision, so `latest` is pulled again.
    $updateArgs = @('containerapp', 'update', '-g', $ResourceGroup, '-n', $App, '--image', $img,
      '--revision-suffix', ('r' + ($Tag -replace '-', '')), '-o', 'none')
    if ($EnvVars) { $updateArgs += '--set-env-vars'; $updateArgs += $EnvVars }
    Invoke-AzCli @updateArgs
  } else {
    Write-Host "creating $App"
    # Express environments don't support managed identity for registry pulls, so the
    # registry's admin credentials are used; Container Apps keeps them as an app secret.
    $createArgs = @('containerapp', 'create', '-g', $ResourceGroup, '-n', $App, '--environment', $Names.env,
      '--image', $img, '--registry-server', $Registry,
      '--registry-username', $script:RegistryUser, '--registry-password', $script:RegistryPassword,
      '--ingress', $Ingress, '--target-port', "$Port",
      '--min-replicas', '0', '--max-replicas', '1', '--cpu', '0.5', '--memory', '1.0Gi', '-o', 'none')
    if ($Secrets) { $createArgs += '--secrets'; $createArgs += $Secrets }
    if ($EnvVars) { $createArgs += '--env-vars'; $createArgs += $EnvVars }
    Invoke-AzCli @createArgs
  }
}

function Step-Apps {
  Write-Stage "Registry pull credentials"
  if ((Get-AzValue acr show -n $Names.acr --query adminUserEnabled -o tsv) -ne 'true') {
    Invoke-AzCli acr update -n $Names.acr --admin-enabled true -o none
  }
  $script:RegistryUser = Get-AzValue acr credential show -n $Names.acr --query username -o tsv
  $script:RegistryPassword = Get-AzValue acr credential show -n $Names.acr --query 'passwords[0].value' -o tsv
  Write-Host "using admin user $($script:RegistryUser)"

  Write-Stage "billing-api (internal ingress: reachable only inside the environment)"
  Deploy-App -App $Names.api -Image 'billing-api' -Ingress internal -Port 8000 `
    -Secrets @("jwt-secret=$($State.jwtSecret)", "database-url=$DatabaseUrl") `
    -EnvVars @('JWT_SECRET=secretref:jwt-secret', 'DATABASE_URL=secretref:database-url')
  $apiFqdn = Get-AppFqdn $Names.api

  Write-Stage "billing-gateway (public) -> https://$apiFqdn"
  Deploy-App -App $Names.gateway -Image 'billing-gateway' -Ingress external -Port 8080 `
    -Secrets @("jwt-secret=$($State.jwtSecret)") `
    -EnvVars @("BILLING_API_UPSTREAM=https://$apiFqdn", 'JWT_SECRET=secretref:jwt-secret')

  Write-Stage "billing-mcp (public)"
  Deploy-App -App $Names.mcp -Image 'billing-mcp' -Ingress external -Port 8001

  Step-Status
}

function Step-Seed {
  Write-Stage "Firewall rule for this machine"
  $ip = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 15).ToString().Trim()
  Invoke-AzCli postgres flexible-server firewall-rule create -g $ResourceGroup --server-name $Names.postgres `
    --name 'seed-from-laptop' --start-ip-address $ip --end-ip-address $ip -o none
  Write-Host "allowed $ip (remove later: az postgres flexible-server firewall-rule delete -g $ResourceGroup --server-name $($Names.postgres) --name seed-from-laptop --yes)"

  Write-Stage "Migrate and seed"
  $old = $env:DATABASE_URL
  $env:DATABASE_URL = $DatabaseUrl
  Push-Location (Join-Path $RepoRoot 'billing-api')
  try {
    npm run migrate; if ($LASTEXITCODE -ne 0) { throw 'migrate failed' }
    if ($Reset) { npm run seed -- --reset } else { npm run seed }
    if ($LASTEXITCODE -ne 0) { throw 'seed failed (already seeded? re-run with -Reset to wipe and reseed)' }
  } finally {
    Pop-Location
    $env:DATABASE_URL = $old
  }
}

function Step-Test {
  $gw = Get-AppFqdn $Names.gateway
  Write-Stage "Gateway tests against https://$gw"
  $oldUrl = $env:GATEWAY_URL; $oldSecret = $env:JWT_SECRET
  $env:GATEWAY_URL = "https://$gw"; $env:JWT_SECRET = $State.jwtSecret
  Push-Location (Join-Path $RepoRoot 'gateway')
  try {
    npm test; if ($LASTEXITCODE -ne 0) { throw 'gateway tests failed' }
  } finally {
    Pop-Location
    $env:GATEWAY_URL = $oldUrl; $env:JWT_SECRET = $oldSecret
  }
}

function Step-Status {
  Write-Stage "Status"
  $gw = Get-AppFqdn $Names.gateway
  $mcp = Get-AppFqdn $Names.mcp
  Write-Host "Gateway:    https://$gw   (BILLING_API_URL)"
  Write-Host "Swagger:    https://$gw/docs"
  Write-Host "MCP server: https://$mcp/mcp   (MCP_SERVER_URL)"
  Write-Host "Database:   $DbHost ($(Get-AzValue postgres flexible-server show -g $ResourceGroup -n $Names.postgres --query state -o tsv))"
  # Apps scale to zero, so the first request can take a few seconds.
  foreach ($url in "https://$gw/api/v1/health", "https://$mcp/health") {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 90
      Write-Host "$url -> $($r.StatusCode)"
    } catch { Write-Host "$url -> $($_.Exception.Message)" -ForegroundColor Yellow }
  }
}

switch ($Step) {
  'infra' { Step-Infra }
  'images' { Step-Images }
  'apps' { Step-Apps }
  'seed' { Step-Seed }
  'test' { Step-Test }
  'status' { Step-Status }
  'all' { Step-Infra; Step-Images; Step-Apps; Step-Seed; Step-Test }
  'stop' { Invoke-AzCli postgres flexible-server stop -g $ResourceGroup -n $Names.postgres }
  'start' { Invoke-AzCli postgres flexible-server start -g $ResourceGroup -n $Names.postgres }
}
