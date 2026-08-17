@echo off
setlocal
set "PROJECT_DIR=%~dp0"

echo ============================================================
echo  Registering WWAN service restart as a pre-authorized task
echo ============================================================
echo.
echo This lets the SMS Reader program trigger a restart of the
echo modem's Windows service on its own if it gets stuck, without
echo needing administrator rights every time - only this one-time
echo setup step needs to be run as administrator.
echo.

schtasks /delete /tn "Heartland Restart WWAN Service" /f >nul 2>nul

schtasks /create /tn "Heartland Restart WWAN Service" ^
    /tr "\"%PROJECT_DIR%Restart-WWAN-Service.bat\"" ^
    /sc once /st 00:00 /sd 01/01/2099 /rl highest /f

echo.
echo ============================================================
echo  Done.
echo ============================================================
echo.
pause
