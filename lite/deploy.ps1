param(
    [switch]$SkipCheck,
    [switch]$SkipTest
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "==> Node syntax check" -ForegroundColor Cyan
if ($SkipCheck) {
    Write-Host "    (skipped)"
} else {
    node --check .\filebeam-worker.js
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed" }
    Write-Host "    OK"
}

Write-Host "==> Test harness" -ForegroundColor Cyan
if ($SkipTest) {
    Write-Host "    (skipped)"
} else {
    node .\test\fb_merged_test.mjs
    if ($LASTEXITCODE -ne 0) { throw "Harness failed" }
}

Write-Host "==> Deploy" -ForegroundColor Cyan
if (Get-Command wrangler -ErrorAction SilentlyContinue) {
    wrangler deploy
} else {
    npx wrangler deploy
}
if ($LASTEXITCODE -ne 0) { throw "Deploy failed" }
Write-Host "==> Done: deployed" -ForegroundColor Green