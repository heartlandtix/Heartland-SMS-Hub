@echo off
setlocal enabledelayedexpansion

REM %~dp0 is this script's own folder, whatever that happens to be on
REM this particular machine - makes this work no matter which account
REM name or drive it's copied to.
cd /d "%~dp0"

set "WWAN_RETRY_COUNT=0"
set "MAX_WWAN_RETRIES=10"
set "LOG_FILE=C:\HeartlandData\logs\wwan-restart.log"

:loop
echo Starting Heartland SMS Reader...
echo.
x64\Release\HeartlandSmsReader.exe --no-browser
set "EXITCODE=%errorlevel%"

if "%EXITCODE%"=="42" (
    echo.
    echo The program's own health check found it had gone stale and asked
    echo to be restarted. Restarting automatically in 3 seconds...
    echo.
    set "WWAN_RETRY_COUNT=0"
    timeout /t 3 /nobreak >nul
    goto loop
)

REM ANY exit code other than 0 (a normal, intentional quit) or 42
REM (already handled above) is treated as worth an attempt at the
REM lightweight WWAN service recovery fix first, since it's fast and
REM doesn't take the machine offline. Up to 10 attempts are allowed.
REM
REM If even 10 lightweight attempts genuinely aren't enough - proven
REM to happen in the field (Mark, Dave, the dev PC all hit this same
REM crash and exhausted every lightweight retry) - we escalate to a
REM full PC restart as the final fallback. A full restart has a 100%
REM track record of clearing this exact issue every time it's been
REM needed. This means the system never just gives up and sits
REM broken waiting for someone to notice.
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
        REM Give Windows extra time to actually re-register the modem
        REM as an available interface after the service comes back up.
        timeout /t 25 /nobreak >nul
        goto loop
    ) else (
        echo.
        echo The lightweight fix didn't work after %MAX_WWAN_RETRIES% tries.
        echo Restarting this whole PC as a last resort - this has reliably
        echo cleared this issue every time it's been needed.
        echo.
        echo %date% %time% - Lightweight WWAN fix failed after %MAX_WWAN_RETRIES% attempts. Restarting the whole PC. >> "%LOG_FILE%"
        shutdown /r /t 30 /c "Heartland: recovering from a stuck modem connection"
        exit /b 0
    )
)

echo.
echo Heartland SMS Reader exited with code %EXITCODE%.
echo This was not an automatic-restart request, so it will not restart on
echo its own. Press any key to close this window, or run this file again
echo to try starting it once more.
pause >nul
