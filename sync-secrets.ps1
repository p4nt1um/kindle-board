# Sync credentials from Windows "User"-scope (or current process) environment variables
# into the ACL-protected local file.
#
# Why this exists:
#   Windows injects User-scope env vars only into processes started AFTER the variable was set.
#   A long-running Node service started earlier keeps its old env snapshot and never sees them.
#   The board server hot-reloads secrets.local.json by mtime, so no service restart is needed.
#
# Usage (PowerShell):  & .\sync-secrets.ps1
#         clear stale:  & .\sync-secrets.ps1 -Prune
# Then: the board picks up the change within 30s, or call http://127.0.0.1:8787/api/refresh
# from this PC to trigger an immediate refetch. Values are never printed.
#
# MERGE semantics (2026-11-11 fix): this used to rebuild the whole file and write '' for
# every env var that was missing, which silently wiped credentials that came from elsewhere
# (e.g. TENCENTCLOUD_SECRET_ID/KEY imported from ~/.tccli/default.credential). Now a key is
# only overwritten when its env var is actually set; existing values are preserved.
# -Prune restores the old "clear keys with no env var" behaviour when you really want it.

param([switch]$Prune)

$ErrorActionPreference = 'Stop'

$map = [ordered]@{
  caldavUser  = 'FEISHU_CALDAV_USERNAME'
  caldavPass  = 'FEISHU_CALDAV_PASSWORD'
  caldavUrl   = 'FEISHU_CALDAV_URL'
  deepseekKey = 'DEEPSEEK_API_KEY'
  kimiKey     = 'KIMI_API_KEY'
  glmKey      = 'GLM_API_KEY'
  baiduAk     = 'BAIDU_CLOUD_AK'
  baiduSk     = 'BAIDU_CLOUD_SK'
  tencentSecretId  = 'TENCENTCLOUD_SECRET_ID'
  tencentSecretKey = 'TENCENTCLOUD_SECRET_KEY'
  aliyunAk    = 'ALIYUN_ACCESS_KEY_ID'
  aliyunSk    = 'ALIYUN_ACCESS_KEY_SECRET'
}

$target = Join-Path $PSScriptRoot 'secrets.local.json'
$out = [ordered]@{}
$existingCount = 0

if (-not $Prune -and (Test-Path $target)) {
  try {
    $old = [System.IO.File]::ReadAllText($target) | ConvertFrom-Json
    foreach ($p in $old.PSObject.Properties) {
      if ($null -ne $p.Value -and [string]$p.Value -ne '') {
        $out[$p.Name] = [string]$p.Value
        $existingCount++
      }
    }
  } catch {
    Write-Output "WARNING: existing secrets.local.json is not valid JSON; starting from its env vars only."
  }
}

$applied = @()
foreach ($k in $map.Keys) {
  $v = [Environment]::GetEnvironmentVariable($map[$k], 'User')
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($map[$k], 'Process') }
  if ($v) {
    $out[$k] = [string]$v
    $applied += $k
  }
  # env 里没有 → 保留文件里已有的值；不写空串
}

$json = $out | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($target, $json, (New-Object System.Text.UTF8Encoding($false)))

# ACL: the file lives under the user's own profile, whose inherited DACL already limits
# access to the current user / Administrators / SYSTEM. That IS the protected location.
# DO NOT run `icacls /inheritance:r` here: it strips the very ACE that lets this user read
# the file, and a subsequent /grant then fails with "Access denied", locking everyone out.
# If you want a stricter DACL, do it manually and grant the explicit ACE BEFORE removing
# inheritance:  icacls file /grant "user:(F)"   then   icacls file /inheritance:r
try {
  $null = [System.IO.File]::ReadAllText($target)
  $acl = 'inherited from user profile (current user / Administrators / SYSTEM)'
} catch {
  $acl = 'WARNING: file not readable'
}

Write-Output ("Written: {0}" -f $target)
Write-Output ("Values kept from file: {0}   overwritten from env: {1}   total keys: {2}   ACL: {3}" -f `
  $existingCount, $applied.Count, $out.Count, $acl)
Write-Output ("  overwritten: {0}" -f $(if ($applied.Count) { $applied -join ', ' } else { '(none)' }))
Write-Output ("  mode: {0}" -f $(if ($Prune) { '-Prune (cleared keys with no env var)' } else { 'merge (existing credentials preserved)' }))
foreach ($k in $out.Keys) {
  Write-Output ("  {0}: {1}" -f $k, $(if ($out[$k]) { 'SET' } else { '-' }))
}
Write-Output 'Board hot-reloads within 30s, or GET /api/refresh from this PC for immediate refetch.'
