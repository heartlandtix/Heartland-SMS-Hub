@echo off
set "LOG_FILE=C:\HeartlandData\logs\restart-schedule.log"
if not exist "C:\HeartlandData\logs" mkdir "C:\HeartlandData\logs"

echo %date% %time% - Scheduled restart triggered. >> "%LOG_FILE%"

shutdown /r /t 60 /c "Heartland scheduled restart"
