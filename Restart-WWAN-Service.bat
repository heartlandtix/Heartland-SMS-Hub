@echo off
set "LOG_FILE=C:\HeartlandData\logs\wwan-restart.log"
set "SOURCE_FILE=C:\HeartlandData\wwan-restart-source.txt"
if not exist "C:\HeartlandData\logs" mkdir "C:\HeartlandData\logs"

set "TRIGGER_SOURCE=Unknown"
if exist "%SOURCE_FILE%" (
    set /p TRIGGER_SOURCE=<"%SOURCE_FILE%"
)

echo %date% %time% - Restarting WWAN AutoConfig service... (triggered by: %TRIGGER_SOURCE%) >> "%LOG_FILE%"

net stop WwanSvc >nul 2>nul
timeout /t 2 /nobreak >nul
net start WwanSvc >nul 2>nul

echo %date% %time% - WWAN AutoConfig service restart attempted. (triggered by: %TRIGGER_SOURCE%) >> "%LOG_FILE%"
