param(
  [string]$BaseUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) {
    throw "ASSERTION FAILED: $Message"
  }
  Write-Host "PASS: $Message"
}

Get-Content (Join-Path $PSScriptRoot "..\.env.local") | ForEach-Object {
  if ($_ -match "^([^#=]+)=(.*)$") {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
  }
}

$supabaseUrl = $env:NEXT_PUBLIC_SUPABASE_URL
$anonKey = $env:NEXT_PUBLIC_SUPABASE_ANON_KEY
if (-not $supabaseUrl -or -not $anonKey) {
  throw "Missing Supabase test configuration"
}

$restHeaders = @{
  apikey = $anonKey
  Authorization = "Bearer $anonKey"
}
$jsonHeaders = @{
  "Content-Type" = "application/json"
}

$suffix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$eventId = "codex-release-test-$suffix"
$ownerId = "owner-$suffix"
$viewerId = "viewer-$suffix"
$strangerId = "stranger-$suffix"
$shareCode = $null

try {
  $createBody = @{
    id = $eventId
    name = "Codex release smoke test"
    days = @(@{ id = "test"; name = "test-day" })
    cppEventId = "cp32"
    clientId = $ownerId
  } | ConvertTo-Json -Depth 5
  $created = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/exhibits" -Headers $jsonHeaders -Body $createBody
  Assert-True ($created.id -eq $eventId) "owner can create a list"

  $ownerAccess = Invoke-RestMethod -Method Get -Uri "$supabaseUrl/rest/v1/event_access?select=event_id,role&event_id=eq.$eventId&client_id=eq.$ownerId" -Headers $restHeaders
  Assert-True ($ownerAccess.Count -eq 1 -and $ownerAccess[0].role -eq "owner") "created list is assigned to owner device"

  try {
    Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/share?eventId=$eventId&clientId=$strangerId" | Out-Null
    throw "stranger unexpectedly received a list code"
  } catch {
    $status = [int]$_.Exception.Response.StatusCode
    Assert-True ($status -eq 403) "unknown device cannot read list code"
  }

  $ownerCodeResult = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/share?eventId=$eventId&clientId=$ownerId"
  $shareCode = $ownerCodeResult.code
  Assert-True ($shareCode -match "^[A-HJ-NP-Z2-9]{4}$") "owner receives a valid four-character list code"

  $joinBody = @{ code = $shareCode; clientId = $viewerId } | ConvertTo-Json
  $joined = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/share" -Headers $jsonHeaders -Body $joinBody
  Assert-True ($joined.eventId -eq $eventId) "second device can join using the list code"

  $viewerAccess = Invoke-RestMethod -Method Get -Uri "$supabaseUrl/rest/v1/event_access?select=event_id,role&event_id=eq.$eventId&client_id=eq.$viewerId" -Headers $restHeaders
  Assert-True ($viewerAccess.Count -eq 1 -and $viewerAccess[0].role -eq "viewer") "joined device receives viewer access"

  $itemRows = @(
    @{
      event_id = $eventId
      booth_number = "T-A01"
      product_name = "batch-test-one"
      item_type = "paid"
      status = "pending"
      price = 10
      quantity = 1
      sort_order = 0
    },
    @{
      event_id = $eventId
      booth_number = "T-A02"
      product_name = "batch-test-two"
      item_type = "paid"
      status = "pending"
      price = 20
      quantity = 2
      sort_order = 1
    }
  )
  $insertHeaders = $restHeaders.Clone()
  $insertHeaders["Prefer"] = "return=representation"
  $inserted = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/wish_items" -Headers $insertHeaders -ContentType "application/json" -Body ($itemRows | ConvertTo-Json -Depth 5)
  Assert-True ($inserted.Count -eq 2) "Excel-style batch insert creates all rows in one request"

  $upsertRows = @($inserted | ForEach-Object {
    @{
      id = $_.id
      event_id = $eventId
      booth_number = $_.booth_number
      product_name = $_.product_name
      author = $_.author
      image_url = $_.image_url
      item_type = $_.item_type
      status = "purchased"
      priority = $_.priority
      note = "batch-save"
      price = ([decimal]$_.price + 1)
      quantity = $_.quantity
      purchase_limit = $_.purchase_limit
      sort_order = $_.sort_order
      cpp_item_id = $_.cpp_item_id
      hot_count = $_.hot_count
      description = $_.description
    }
  })
  $upsertHeaders = $restHeaders.Clone()
  $upsertHeaders["Prefer"] = "resolution=merge-duplicates,return=representation"
  $saved = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/wish_items?on_conflict=id" -Headers $upsertHeaders -ContentType "application/json" -Body ($upsertRows | ConvertTo-Json -Depth 5)
  Assert-True ($saved.Count -eq 2 -and ($saved | Where-Object { $_.status -ne "purchased" }).Count -eq 0) "edit drafts are saved as one batch upsert"

  $itemIds = @($inserted | ForEach-Object { $_.id })
  $idFilter = $itemIds -join ","
  Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/wish_items?event_id=eq.$eventId&id=in.($idFilter)" -Headers $restHeaders | Out-Null
  $remaining = Invoke-RestMethod -Method Get -Uri "$supabaseUrl/rest/v1/wish_items?select=id&event_id=eq.$eventId" -Headers $restHeaders
  Assert-True ($remaining.Count -eq 0) "batch delete removes all selected rows in one request"

  Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/event_access?event_id=eq.$eventId&client_id=eq.$viewerId" -Headers $restHeaders | Out-Null
  $ownerStillPresent = Invoke-RestMethod -Method Get -Uri "$supabaseUrl/rest/v1/event_access?select=role&event_id=eq.$eventId&client_id=eq.$ownerId" -Headers $restHeaders
  $eventStillPresent = Invoke-RestMethod -Method Get -Uri "$supabaseUrl/rest/v1/events?select=id&id=eq.$eventId" -Headers $restHeaders
  Assert-True ($ownerStillPresent.Count -eq 1 -and $eventStillPresent.Count -eq 1) "viewer removal does not delete owner access or source list"

  Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/event_access?event_id=eq.$eventId" -Headers $restHeaders | Out-Null
  Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/events?id=eq.$eventId" -Headers $restHeaders | Out-Null

  try {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/share" -Headers $jsonHeaders -Body $joinBody | Out-Null
    throw "deleted list code unexpectedly resolved"
  } catch {
    $status = [int]$_.Exception.Response.StatusCode
    Assert-True ($status -eq 404) "deleted owner list invalidates its list code"
  }

  Write-Host "SMOKE_TEST_OK event=$eventId"
} finally {
  try {
    Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/wish_items?event_id=eq.$eventId" -Headers $restHeaders | Out-Null
    Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/event_access?event_id=eq.$eventId" -Headers $restHeaders | Out-Null
    Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/events?id=eq.$eventId" -Headers $restHeaders | Out-Null
  } catch {
    Write-Warning "Cleanup needs attention for $eventId`: $($_.Exception.Message)"
  }
}
