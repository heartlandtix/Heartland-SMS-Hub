@echo off
setlocal
set "PROJECT_DIR=%~dp0"

echo ============================================================
echo  Setting up automatic internet connectivity check
echo ============================================================
echo.
echo 5 minutes after every login, this PC will check for real
echo internet connectivity. If none is found, it will automatically
echo restart (up to 3 times in a row) until connectivity returns.
echo.

schtasks /delete /tn "Heartland Connectivity Check" /f >nul 2>nul

schtasks /create /tn "Heartland Connectivity Check" ^
    /tr "\"%PROJECT_DIR%Check-Internet-Connectivity.bat\"" ^
    /sc onlogon /delay 0005:00 /rl highest /f

echo.
echo ============================================================
echo  Done.
echo ============================================================
echo.
pause
