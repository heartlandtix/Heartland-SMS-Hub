@echo off
echo Starting Heartland SMS Hub...
echo.

REM --- Start the C++ SMS reader in its own window ---
REM Runs through Run-Reader-Loop.bat, which automatically restarts the
REM program if its own health check ever finds it's gone stale.
cd /d "%~dp0"
start "Heartland SMS Reader" cmd /k "Run-Reader-Loop.bat"

echo Waiting for the SMS reader to start up...
timeout /t 5 /nobreak >nul

REM --- Start the Node server in its own window ---
cd /d "%~dp0server"
start "Heartland Node Server" cmd /k "node index.js"

echo Waiting for the Node server to start up...
timeout /t 3 /nobreak >nul

REM --- Open the web inbox in your default browser ---
start "" "http://127.0.0.1:8080/"

echo.
echo All set. Two windows should now be open (SMS Reader and Node Server) -
echo leave both of them open. This launcher window can be closed.
echo.
pause
