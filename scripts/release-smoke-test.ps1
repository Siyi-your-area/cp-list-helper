param(
  [string]$BaseUrl = "http://localhost:3000",
  [switch]$ConfirmIsolatedTestDatabase
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmIsolatedTestDatabase) {
  throw "This script writes and deletes test data. Re-run only against an isolated Supabase project with -ConfirmIsolatedTestDatabase."
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
  Write-Host "PASS: $Message"
}

function New-AnonymousIdentity {
  $headers = @{ apikey = $script:anonKey; "Content-Type" = "application/json" }
  $session = Invoke-RestMethod -Method Post -Uri "$script:supabaseUrl/auth/v1/signup" -Headers $headers -Body "{}"
  if (-not $session.access_token -or -not $session.user.id) { throw "Anonymous Auth is not enabled" }
  return @{
    UserId = $session.user.id
    ApiHeaders = @{ Authorization = "Bearer $($session.access_token)"; "Content-Type" = "application/json" }
    RestHeaders = @{ apikey = $script:anonKey; Authorization = "Bearer $($session.access_token)"; Prefer = "return=representation" }
  }
}

Get-Content (Join-Path $PSScriptRoot "..\.env.local") | ForEach-Object {
  if ($_ -match "^([^#=]+)=(.*)$") { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
}

$supabaseUrl = $env:NEXT_PUBLIC_SUPABASE_URL
$anonKey = $env:NEXT_PUBLIC_SUPABASE_ANON_KEY
if (-not $supabaseUrl -or -not $anonKey) { throw "Missing isolated Supabase test configuration" }

$owner = New-AnonymousIdentity
$editor = New-AnonymousIdentity
$stranger = New-AnonymousIdentity
$suffix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$eventId = "codex-security-test-$suffix"
$shareCode = $null

try {
  $createBody = @{
    id = $eventId
    name = "Codex security smoke test"
    days = @(@{ id = "test"; name = "test-day" })
    cppEventId = "cp32"
  } | ConvertTo-Json -Depth 5
  $created = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/exhibits" -Headers $owner.ApiHeaders -Body $createBody
  Assert-True ($created.id -eq $eventId -and $created.accessRole -eq "owner") "authenticated owner can atomically create a list"

  try {
    Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/share?eventId=$eventId" -Headers $stranger.ApiHeaders | Out-Null
    throw "stranger unexpectedly received a list code"
  } catch {
    Assert-True ([int]$_.Exception.Response.StatusCode -eq 403) "stranger cannot read list code"
  }

  $ownerCode = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/share?eventId=$eventId" -Headers $owner.ApiHeaders
  $shareCode = $ownerCode.code
  Assert-True ($shareCode -match "^[A-HJ-NP-Z2-9]{4}$") "owner receives a four-character code"

  $joinBody = @{ code = $shareCode } | ConvertTo-Json
  $joined = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/share" -Headers $editor.ApiHeaders -Body $joinBody
  Assert-True ($joined.eventId -eq $eventId) "second anonymous account joins as editor"

  $editorMembership = Invoke-RestMethod -Method Get -Uri "$supabaseUrl/rest/v1/list_members?select=event_id,role&event_id=eq.$eventId" -Headers $editor.RestHeaders
  Assert-True ($editorMembership.Count -eq 1 -and $editorMembership[0].role -eq "editor") "list_members RLS exposes only the caller membership"

  $item = @{
    event_id = $eventId; booth_number = "T-A01"; product_name = "cas-test"
    item_type = "paid"; status = "pending"; quantity = 1; sort_order = 0
  } | ConvertTo-Json
  $inserted = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/wish_items" -Headers $editor.RestHeaders -ContentType "application/json" -Body $item
  Assert-True ($inserted.Count -eq 1 -and $inserted[0].version -eq 1) "editor can insert wish item"

  $casBody = @{
    p_event_id = $eventId
    p_item_id = $inserted[0].id
    p_expected_version = 1
    p_patch = @{ status = "purchased"; note = "cas-save" }
  } | ConvertTo-Json -Depth 5
  $saved = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/save_wish_item_cas" -Headers $owner.RestHeaders -ContentType "application/json" -Body $casBody
  Assert-True ($saved.status -eq "purchased" -and $saved.version -eq 2) "owner CAS save increments version"

  try {
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/save_wish_item_cas" -Headers $editor.RestHeaders -ContentType "application/json" -Body $casBody | Out-Null
    throw "stale CAS unexpectedly succeeded"
  } catch {
    Assert-True ([int]$_.Exception.Response.StatusCode -ge 400) "stale CAS is rejected"
  }

  Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/exhibits/$eventId" -Headers $editor.ApiHeaders | Out-Null
  $ownerMembership = Invoke-RestMethod -Method Get -Uri "$supabaseUrl/rest/v1/list_members?select=role&event_id=eq.$eventId" -Headers $owner.RestHeaders
  Assert-True ($ownerMembership.Count -eq 1 -and $ownerMembership[0].role -eq "owner") "editor leave does not delete source list"

  $rejoined = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/share" -Headers $editor.ApiHeaders -Body $joinBody
  Assert-True ($rejoined.eventId -eq $eventId) "editor can idempotently rejoin"

  Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/exhibits/$eventId" -Headers $owner.ApiHeaders | Out-Null
  try {
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/share" -Headers $stranger.ApiHeaders -Body $joinBody | Out-Null
    throw "deleted code unexpectedly resolved"
  } catch {
    Assert-True ([int]$_.Exception.Response.StatusCode -eq 400) "owner deletion invalidates old code with uniform failure"
  }
  Write-Host "SMOKE_TEST_OK event=$eventId"
} finally {
  try { Invoke-RestMethod -Method Delete -Uri "$BaseUrl/api/exhibits/$eventId" -Headers $owner.ApiHeaders | Out-Null } catch {
    Write-Warning "Cleanup may need attention for $eventId`: $($_.Exception.Message)"
  }
}
