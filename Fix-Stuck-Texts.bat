@echo off
echo ============================================================
echo  Restarting the modem's Windows service (WWAN AutoConfig)
echo ============================================================
echo.
echo This is the same fix that's been resolving stuck texts today.
echo No need to run this as administrator - it's already authorized.
echo.

if not exist "C:\HeartlandData" mkdir "C:\HeartlandData"
echo Manual (Fix-Stuck-Texts.bat) > "C:\HeartlandData\wwan-restart-source.txt"

schtasks /run /tn "Heartland Restart WWAN Service" >nul 2>nul

if %errorlevel%==0 (
    echo Triggered successfully.
) else (
    echo WARNING: Could not trigger the restart. This machine may not
    echo have the "Heartland Restart WWAN Service" task set up yet.
)

echo.
echo Give it about 30 seconds, then send a test text and check
echo Skylight/the web inbox to confirm it worked.
echo.
echo This window will close on its own in 5 seconds...
timeout /t 5 /nobreak >nul
