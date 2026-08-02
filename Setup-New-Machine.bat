@echo off
setlocal

REM This script sets up Heartland SMS Hub on a new machine. Run it once,
REM from wherever this whole folder has been copied to - it figures out
REM its own location automatically, so the folder can live anywhere.

set "PROJECT_DIR=%~dp0"

echo ============================================================
echo  Heartland SMS Hub - New Machine Setup
echo ============================================================
echo.
echo This folder: %PROJECT_DIR%
echo.

REM --- 1. Create the local database folder ---
if not exist "C:\HeartlandData" (
    echo Creating C:\HeartlandData ...
    mkdir "C:\HeartlandData"
)
if not exist "C:\HeartlandData\logs" (
    mkdir "C:\HeartlandData\logs"
)

REM --- 2. Install the Visual C++ Redistributable, which the compiled ---
REM ---    program needs to run at all. Safe to run even if it's      ---
REM ---    already installed - it just detects that and exits quickly.
echo.
echo Installing Visual C++ Redistributable ^(needs internet, ~15-25MB^)...
powershell -NoProfile -Command ^
    "$ProgressPreference = 'SilentlyContinue';" ^
    "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile ""$env:TEMP\vc_redist.x64.exe"""
"%TEMP%\vc_redist.x64.exe" /install /quiet /norestart

REM --- 3. Install Node packages, only if not already bundled ---
if not exist "%PROJECT_DIR%server\node_modules" (
    echo.
    echo node_modules not found - running npm install ^(needs internet^)...
    pushd "%PROJECT_DIR%server"
    if exist "%PROJECT_DIR%node-runtime\npm.cmd" (
        call "%PROJECT_DIR%node-runtime\npm.cmd" install
    ) else (
        call npm install
    )
    popd
) else (
    echo.
    echo node_modules already present - skipping npm install.
)

REM --- 4. Create the Startup folder shortcut, so this runs automatically ---
echo.
echo Setting up auto-start...
powershell -NoProfile -Command ^
    "$ws = New-Object -ComObject WScript.Shell;" ^
    "$sc = $ws.CreateShortcut([System.Environment]::GetFolderPath('Startup') + '\Heartland SMS Hub.lnk');" ^
    "$sc.TargetPath = '%PROJECT_DIR%Start-Heartland-Hidden.vbs';" ^
    "$sc.WorkingDirectory = '%PROJECT_DIR%';" ^
    "$sc.Save()"

REM --- 5. Set up auto-login for THIS machine's account ---
echo.
echo ============================================================
echo  Auto-login setup
echo ============================================================
echo This machine's own Windows account name and password are needed
echo so this PC can boot straight to the desktop with no one present
echo to type anything in, after a restart or power loss.
echo.
echo NOTE: what you type below will be visible on screen as you type it.
echo.
set "WINUSER=Owner"
set /p WINUSER=Windows account username on THIS machine [Owner]:
set /p WINPASS=Windows account password on THIS machine:

reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 1 /f >nul
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultUserName /t REG_SZ /d "%WINUSER%" /f >nul
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword /t REG_SZ /d "%WINPASS%" /f >nul
reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoLogonSID /f >nul 2>nul

echo.
echo ============================================================
echo  Setup complete.
echo ============================================================
echo.
echo Restart this PC now to test: it should boot straight to the
echo desktop with no prompts, and Heartland SMS Hub should start
echo automatically and invisibly in the background.
echo.
echo To confirm it's running after restart, open a browser and go to:
echo   http://127.0.0.1:8080/
echo.
pause
