@echo off
net session >nul 2>&1
if not %errorlevel%==0 (
  echo.
  echo This must be run as Administrator.
  echo Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Removing any older Heartland SMS Hub port rule...
netsh advfirewall firewall delete rule name="Heartland SMS Hub - Private TCP 8080" >nul 2>&1

echo Adding PRIVATE-network access for TCP port 8080...
netsh advfirewall firewall add rule name="Heartland SMS Hub - Private TCP 8080" dir=in action=allow protocol=TCP localport=8080 profile=private

echo.
echo Firewall rule complete.
pause
