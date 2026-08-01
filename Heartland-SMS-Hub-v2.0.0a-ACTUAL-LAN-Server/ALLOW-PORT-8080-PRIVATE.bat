@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Right-click this file and choose Run as administrator.
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="Heartland SMS Hub TCP 8080" >nul 2>&1
netsh advfirewall firewall add rule name="Heartland SMS Hub TCP 8080" dir=in action=allow protocol=TCP localport=8080 profile=private

echo.
echo Private-network firewall rule created for TCP port 8080.
echo Public networks were not enabled.
pause
