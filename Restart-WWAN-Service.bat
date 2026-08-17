@echo off
set "LOG_FILE=C:\HeartlandData\logs\wwan-restart.log"
if not exist "C:\HeartlandData\logs" mkdir "C:\HeartlandData\logs"

echo %date% %time% - Restarting WWAN AutoConfig service... >> "%LOG_FILE%"

net stop WwanSvc >nul 2>nul
timeout /t 2 /nobreak >nul
net start WwanSvc >nul 2>nul

echo %date% %time% - WWAN AutoConfig service restart attempted. >> "%LOG_FILE%"
