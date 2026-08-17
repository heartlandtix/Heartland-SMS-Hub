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

REM --- 3. Schedule two daily restarts, as a safety net in case the ---
REM ---    sleep settings above don't fully prevent the problem on  ---
REM ---    every machine - a restart reliably fixes it, and this    ---
REM ---    program auto-starts again on its own after any restart.  ---
echo.
echo Scheduling daily restarts ^(midnight and 7 AM^)...
schtasks /delete /tn "Heartland Restart - Midnight" /f >nul 2>nul
schtasks /delete /tn "Heartland Restart - 7AM" /f >nul 2>nul

schtasks /create /tn "Heartland Restart - Midnight" ^
    /tr "shutdown /r /t 60 /c \"Heartland scheduled restart\"" ^
    /sc daily /st 00:00 /rl highest /f

schtasks /create /tn "Heartland Restart - 7AM" ^
    /tr "shutdown /r /t 60 /c \"Heartland scheduled restart\"" ^
    /sc daily /st 07:00 /rl highest /f

REM --- 3b. Check for internet connectivity 5 minutes after every ---
REM      login, and auto-restart (up to 3 times) if none is found. ---
echo.
echo Setting up automatic internet connectivity check...
schtasks /delete /tn "Heartland Connectivity Check" /f >nul 2>nul
schtasks /create /tn "Heartland Connectivity Check" ^
    /tr "\"%PROJECT_DIR%Check-Internet-Connectivity.bat\"" ^
    /sc onlogon /delay 0005:00 /rl highest /f

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
echo This PC will restart automatically at 12:00 AM and 7:00 AM every
echo day, in addition to booting straight to the desktop with no
echo prompts after any restart or power loss. It will also check for
echo internet connectivity 5 minutes after every login and
echo auto-restart (up to 3 times) if none is found.
echo.
echo Restart this PC now to test: it should boot straight to the
echo desktop, and Heartland SMS Hub should start automatically and
echo invisibly in the background.
echo.
echo To confirm it's running after restart, open a browser and go to:
echo   http://127.0.0.1:8080/
echo.
pause
