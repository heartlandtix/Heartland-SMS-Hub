@echo off
setlocal
set "PROJECT_DIR=%~dp0"

echo ============================================================
echo  Setting up Heartland SMS Hub as Scheduled Tasks
echo ============================================================
echo.

REM Remove any old Startup-folder shortcut from a previous approach,
REM so it doesn't ALSO launch things (which would cause duplicates).
set "STARTUP_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Heartland SMS Hub.lnk"
if exist "%STARTUP_SHORTCUT%" (
    echo Removing old Startup-folder shortcut...
    del "%STARTUP_SHORTCUT%"
)

REM Remove any existing tasks with these names first, so re-running
REM this script is always safe and doesn't create duplicates.
schtasks /delete /tn "Heartland SMS Reader" /f >nul 2>nul
schtasks /delete /tn "Heartland Node Server" /f >nul 2>nul

echo Creating scheduled task: Heartland SMS Reader...
schtasks /create /tn "Heartland SMS Reader" /tr "\"%PROJECT_DIR%Run-Reader-Loop.bat\"" /sc onlogon /rl highest /f

echo Creating scheduled task: Heartland Node Server...
schtasks /create /tn "Heartland Node Server" /tr "\"%PROJECT_DIR%Run-Node-Server.bat\"" /sc onlogon /rl highest /f

echo.
echo ============================================================
echo  Done. Restart this PC to test - there should be NO visible
echo  windows or taskbar icons at all once it finishes booting.
echo ============================================================
echo.
pause
