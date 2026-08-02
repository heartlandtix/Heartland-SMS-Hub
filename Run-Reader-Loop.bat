@echo off
REM %~dp0 is this script's own folder, whatever that happens to be on
REM this particular machine - makes this work no matter which account
REM name or drive it's copied to.
cd /d "%~dp0"

:loop
echo Starting Heartland SMS Reader...
echo.
x64\Release\HeartlandSmsReader.exe --no-browser
set EXITCODE=%errorlevel%

if %EXITCODE%==42 (
    echo.
    echo The program's own health check found it had gone stale and asked
    echo to be restarted. Restarting automatically in 3 seconds...
    echo.
    timeout /t 3 /nobreak >nul
    goto loop
)

echo.
echo Heartland SMS Reader exited with code %EXITCODE%.
echo This was not an automatic-restart request, so it will not restart on
echo its own. Press any key to close this window, or run this file again
echo to try starting it once more.
pause >nul
