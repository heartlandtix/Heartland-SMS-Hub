@echo off
setlocal enabledelayedexpansion

set "DATA_DIR=C:\HeartlandData"
set "COUNT_FILE=%DATA_DIR%\connectivity-restart-count.txt"
set "LOG_FILE=%DATA_DIR%\logs\connectivity.log"
set "MAX_RETRIES=3"

if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"

REM Try two well-known, reliable addresses - only fails if BOTH are
REM unreachable, so a single flaky server doesn't cause a false alarm.
ping -n 1 -w 3000 8.8.8.8 >nul 2>nul
if %errorlevel%==0 goto :connected

ping -n 1 -w 3000 1.1.1.1 >nul 2>nul
if %errorlevel%==0 goto :connected

REM --- No internet detected ---
set "RETRY_COUNT=0"
if exist "%COUNT_FILE%" set /p RETRY_COUNT=<"%COUNT_FILE%"
if "%RETRY_COUNT%"=="" set "RETRY_COUNT=0"

if %RETRY_COUNT% GEQ %MAX_RETRIES% (
    echo %date% %time% - No internet after %MAX_RETRIES% automatic restarts. Giving up until next normal restart. >> "%LOG_FILE%"
    exit /b 1
)

set /a RETRY_COUNT+=1
echo %RETRY_COUNT% > "%COUNT_FILE%"
echo %date% %time% - No internet detected. Restarting (attempt %RETRY_COUNT% of %MAX_RETRIES%)... >> "%LOG_FILE%"
shutdown /r /t 30 /c "No internet connectivity detected - restarting automatically"
exit /b 0

:connected
echo 0 > "%COUNT_FILE%"
echo %date% %time% - Internet connectivity confirmed. >> "%LOG_FILE%"
exit /b 0
