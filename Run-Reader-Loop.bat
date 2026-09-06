@echo off
setlocal enabledelayedexpansion

REM %~dp0 is this script's own folder, whatever that happens to be on
REM this particular machine - makes this work no matter which account
REM name or drive it's copied to.
cd /d "%~dp0"

set "WWAN_RETRY_COUNT=0"
set "MAX_WWAN_RETRIES=10"

:loop
echo Starting Heartland SMS Reader...
echo.
x64\Release\HeartlandSmsReader.exe --no-browser
set "EXITCODE=%errorlevel%"

if "%EXITCODE%"=="42" (
    echo.
    echo The program's own health check found the modem connection had
    echo gone stale. Restarting the WWAN service before relaunching,
    echo since this check exists specifically to catch that condition -
    echo just relaunching the program alone doesn't reset the
    echo underlying Windows service that may actually be stuck.
    echo.
    schtasks /run /tn "Heartland Restart WWAN Service" >nul 2>nul
    set "WWAN_RETRY_COUNT=0"
    timeout /t 25 /nobreak >nul
    goto loop
)

REM ANY exit code other than 0 (a normal, intentional quit) or 42
REM (already handled above) is treated as worth an attempt at the
REM lightweight WWAN service recovery fix first, since it's fast and
REM doesn't take the machine offline. Up to 10 attempts are allowed.
if not "%EXITCODE%"=="0" (
    if !WWAN_RETRY_COUNT! LSS %MAX_WWAN_RETRIES% (
        set /a WWAN_RETRY_COUNT+=1
        echo.
        echo Even a fresh restart of this program could not reach the modem.
        echo This can happen when the Windows service that manages the
        echo modem gets stuck. Attempting to restart that service now
        echo ^(attempt !WWAN_RETRY_COUNT! of %MAX_WWAN_RETRIES%^)...
        echo.
        schtasks /run /tn "Heartland Restart WWAN Service" >nul 2>nul
        timeout /t 25 /nobreak >nul
        goto loop
    )
)

echo.
echo Heartland SMS Reader exited with code %EXITCODE%.
echo This was not an automatic-restart request, so it will not restart on
echo its own. Press any key to close this window, or run this file again
echo to try starting it once more.
pause >nul
