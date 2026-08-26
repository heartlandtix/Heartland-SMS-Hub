@echo off
setlocal

REM This script sets up Heartland SMS Hub on a new machine. Run it once,
REM from wherever this whole folder has been copied to - it figures out
REM its own location automatically, so the folder can live anywhere.

REM --- 0. Confirm this is actually running as Administrator ---
REM Several steps below (registry, Defender exclusions, scheduled
REM tasks) silently fail with no visible error if this script isn't
REM elevated - this check stops that from happening unnoticed.
net session >nul 2>nul
if not "%errorlevel%"=="0" (
    echo ============================================================
    echo  ERROR: This script is NOT running as Administrator.
    echo ============================================================
    echo.
    echo Several setup steps will silently fail without this - close
    echo this window, then right-click Setup-New-Machine.bat and
    echo choose "Run as administrator" instead.
    echo.
    pause
    exit /b 1
)

set "PROJECT_DIR=%~dp0"

echo ============================================================
echo  Heartland SMS Hub - New Machine Setup
echo ============================================================
echo.
echo Running as Administrator: confirmed.
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

REM --- 2. Keep this PC awake at all times ---
REM Sleep/USB suspend was found to silently kill message reception
REM overnight, even though everything looked fine the evening before -
REM this PC must never sleep.
echo.
echo Disabling sleep and USB suspend...
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /hibernate off
powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
powercfg /setdcvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0

REM On laptops, keep running normally even with the lid closed
REM (desktops without a lid simply ignore this harmlessly). Keep
REM laptops plugged in at all times when doing this.
powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setdcvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0

powercfg /setactive SCHEME_CURRENT

REM --- Scheduled restarts removed. The WWAN auto-recovery fix (10
REM     lightweight attempts, then a full PC restart if that's
REM     genuinely not enough) has proven to reliably self-heal the
REM     modem connection on its own. Scheduled restarts also carried
REM     a real, separate risk on some machines - occasionally causing
REM     a connectivity loss of their own after restarting - so they're
REM     no longer part of setup at all.
schtasks /delete /tn "Heartland Restart - Midnight" /f >nul 2>nul
schtasks /delete /tn "Heartland Restart - 7AM" /f >nul 2>nul
if exist "C:\HeartlandData\restart-policy.txt" del "C:\HeartlandData\restart-policy.txt" >nul 2>nul

REM --- 3b. Check for internet connectivity 5 minutes after every ---
REM      login, and auto-restart (up to 3 times) if none is found. ---
echo.
echo Setting up automatic internet connectivity check...
schtasks /delete /tn "Heartland Connectivity Check" /f >nul 2>nul
schtasks /create /tn "Heartland Connectivity Check" ^
    /tr "\"%PROJECT_DIR%Check-Internet-Connectivity.bat\"" ^
    /sc onlogon /delay 0005:00 /rl highest /f
if errorlevel 1 echo WARNING: Could not create the connectivity check task - see above.

REM --- 4. Exclude our folders from Windows Defender ---
REM Defender can flag this program as a false-positive "trojan" and
REM delete or repeatedly kill it. Excluding these folders prevents
REM that on any machine that isn't centrally IT-managed. A Process
REM exclusion is also added, since folder exclusions alone weren't
REM always enough (discovered on a field machine).
echo.
echo Adding Windows Defender exclusions...
powershell -NoProfile -Command ^
    "Add-MpPreference -ExclusionPath '%PROJECT_DIR%';" ^
    "Add-MpPreference -ExclusionPath 'C:\HeartlandData';" ^
    "Add-MpPreference -ExclusionPath ([System.Environment]::GetFolderPath('UserProfile') + '\Downloads');" ^
    "Add-MpPreference -ExclusionProcess 'HeartlandSmsReader.exe'"
if errorlevel 1 echo WARNING: Could not add Defender exclusions - see above.

REM --- 5. Install the Visual C++ Redistributable, which the compiled ---
REM ---    program needs to run at all. Safe to run even if it's      ---
REM ---    already installed - it just detects that and exits quickly.
echo.
echo Installing Visual C++ Redistributable ^(needs internet, ~15-25MB^)...
powershell -NoProfile -Command ^
    "$ProgressPreference = 'SilentlyContinue';" ^
    "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile ""$env:TEMP\vc_redist.x64.exe"""
"%TEMP%\vc_redist.x64.exe" /install /quiet /norestart

REM --- 6. Install Node packages, only if not already bundled ---
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

REM --- 7. Create the Startup folder shortcut, so this runs automatically ---
REM This approach is confirmed working correctly (genuinely zero
REM visible windows) on real deployed machines.
echo.
echo Setting up auto-start...

REM Clean up Scheduled Tasks from an earlier version of this setup,
REM if they exist, so they don't ALSO launch things (duplicates).
schtasks /delete /tn "Heartland SMS Reader" /f >nul 2>nul
schtasks /delete /tn "Heartland Node Server" /f >nul 2>nul

powershell -NoProfile -Command ^
    "$ws = New-Object -ComObject WScript.Shell;" ^
    "$sc = $ws.CreateShortcut([System.Environment]::GetFolderPath('Startup') + '\Heartland SMS Hub.lnk');" ^
    "$sc.TargetPath = '%PROJECT_DIR%Start-Heartland-Hidden.vbs';" ^
    "$sc.WorkingDirectory = '%PROJECT_DIR%';" ^
    "$sc.Save()"

REM --- 7b. Register the WWAN service auto-restart as a pre-authorized ---
REM ---     task, so the program can trigger it later without needing  ---
REM ---     admin rights each time it's needed. ---
echo.
echo Registering WWAN service auto-recovery...
schtasks /delete /tn "Heartland Restart WWAN Service" /f >nul 2>nul
schtasks /create /tn "Heartland Restart WWAN Service" ^
    /tr "\"%PROJECT_DIR%Restart-WWAN-Service.bat\"" ^
    /sc once /st 00:00 /sd 01/01/2099 /rl highest /f
if errorlevel 1 (
    echo WARNING: Could not register WWAN auto-recovery - see above.
) else (
    echo WWAN auto-recovery registered successfully.
)

REM --- 8. Set up auto-login for THIS machine's account ---
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
echo This PC will boot straight to the desktop with no prompts after
echo any restart or power loss. It will also check for internet
echo connectivity 5 minutes after every login and auto-restart (up to
echo 3 times) if none is found, and will automatically recover from a
echo stuck modem connection on its own.
echo.
echo If any WARNING lines appeared above, re-run this script as
echo Administrator to fix them before considering setup complete.
echo.
echo Restart this PC now to test: it should boot straight to the
echo desktop, and Heartland SMS Hub should start automatically and
echo invisibly in the background.
echo.
echo To confirm it's running after restart, open a browser and go to:
echo   http://127.0.0.1:8080/
echo.
pause
