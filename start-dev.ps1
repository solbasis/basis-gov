$Host.UI.RawUI.WindowTitle = "BASIS GOV Dev App"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "  BASIS GOV - Developer App" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"
Write-Host "  Killing any process on port 5173..." -ForegroundColor Yellow

try { npx kill-port 5173 2>$null } catch {}
Start-Sleep -Seconds 1

Write-Host "  Starting dev server at http://localhost:5173" -ForegroundColor Green
Write-Host "  ----------------------------------------"
Write-Host ""

npm run dev:devnet

Write-Host ""
Write-Host "  Server stopped. Press any key to exit." -ForegroundColor Red
Read-Host "Press Enter to close"
