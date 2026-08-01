@echo off
echo Testing Heartland SMS Hub health endpoint...
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://localhost:8080/health -TimeoutSec 5).Content } catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"
echo.
pause
