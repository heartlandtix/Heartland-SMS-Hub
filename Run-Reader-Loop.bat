@echo off
setlocal enabledelayedexpansion

REM %~dp0 is this script's own folder, whatever that happens to be on
REM this particular machine - makes this work no matter which account
REM name or drive it's copied to.
cd /d "%~dp0"

set "WWAN_RETRY_DONE=0"

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
    set "WWAN_RETRY_DONE=0"
    timeout /t 3 /nobreak >nul
    goto loop
)

REM Exit code 7 = "even a fresh restart couldn't reach the modem" (the
REM program's own clean error path). Exit code -1073741819 has also
REM been observed in the wild for the exact same underlying cause
REM (the WWAN AutoConfig service not running) - confirmed by
REM deliberately stopping that service and watching this exact code
REM appear. Treating both the same way, since they share the same
REM real-world cause and fix. Both sides of these comparisons are
REM quoted deliberately - IF can otherwise mishandle a value starting
REM with a minus sign.
set "TRY_WWAN_FIX="
if "%EXITCODE%"=="7" set "TRY_WWAN_FIX=1"
if "%EXITCODE%"=="-1073741819" set "TRY_WWAN_FIX=1"

if defined TRY_WWAN_FIX (
    if "!WWAN_RETRY_DONE!"=="0" (
        echo.
        echo Even a fresh restart of this program could not reach the modem.
        echo This can happen when the Windows service that manages the
        echo modem gets stuck. Attempting to restart that service now...
        echo.
        schtasks /run /tn "Heartland Restart WWAN Service" >nul 2>nul
        timeout /t 10 /nobreak >nul
        set "WWAN_RETRY_DONE=1"
        goto loop
    )
)

echo.
echo Heartland SMS Reader exited with code %EXITCODE%.
echo This was not an automatic-restart request, so it will not restart on
echo its own. Press any key to close this window, or run this file again
echo to try starting it once more.
pause >nul
