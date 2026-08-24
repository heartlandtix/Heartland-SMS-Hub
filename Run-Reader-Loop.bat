@echo off
setlocal enabledelayedexpansion

REM %~dp0 is this script's own folder, whatever that happens to be on
REM this particular machine - makes this work no matter which account
REM name or drive it's copied to.
cd /d "%~dp0"

set "WWAN_RETRY_COUNT=0"
set "MAX_WWAN_RETRIES=2"

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
REM WWAN service recovery fix. Every real-world failure code we've
REM seen so far (5, 7, and two different crash codes) has turned out
REM to trace back to the same underlying cause - the WWAN AutoConfig
REM service. Rather than chase each new exact code as it turns up in
REM the field, we just try the fix for any unexpected failure.
REM
REM Up to 2 attempts are allowed, not just 1 - seen in the field
REM (Dave, twice) where the first retry lands while the modem
REM interface is still mid-registration right after the WWAN service
REM restarts, crashing instead of succeeding; a second attempt after
REM a bit more settling time has reliably worked when this happens.
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
    )
)

echo.
echo Heartland SMS Reader exited with code %EXITCODE%.
echo This was not an automatic-restart request, so it will not restart on
echo its own. Press any key to close this window, or run this file again
echo to try starting it once more.
pause >nul
