@echo off
set "LOG_FILE=C:\HeartlandData\logs\wwan-restart.log"
set "SOURCE_FILE=C:\HeartlandData\wwan-restart-source.txt"
if not exist "C:\HeartlandData\logs" mkdir "C:\HeartlandData\logs"

set "TRIGGER_SOURCE=Unknown"
if exist "%SOURCE_FILE%" (
    set /p TRIGGER_SOURCE=<"%SOURCE_FILE%"
)

REM Also capture the ACTUAL parent process directly, regardless of
REM whether the source-file marker worked - this gives definitive
REM proof of what's really calling this script, since the marker has
REM been showing "Unknown" far more often than expected and we need
REM real evidence rather than more guessing.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command ^
    "$me = Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" |" ^
    "Where-Object { $_.CommandLine -like '*Restart-WWAN-Service.bat*' } |" ^
    "Select-Object -First 1;" ^
    "if ($me) {" ^
    "  $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $me.ParentProcessId);" ^
    "  if ($parent) { Write-Output ($parent.Name + ' | ' + $parent.CommandLine) }" ^
    "  else { Write-Output 'Parent process not found (already exited)' }" ^
    "} else { Write-Output 'Could not identify own process' }"`) do set "PARENT_INFO=%%P"

echo %date% %time% - Restarting WWAN AutoConfig service... (triggered by: %TRIGGER_SOURCE%) [actual parent: %PARENT_INFO%] >> "%LOG_FILE%"

net stop WwanSvc >nul 2>nul
timeout /t 2 /nobreak >nul
net start WwanSvc >nul 2>nul

echo %date% %time% - WWAN AutoConfig service restart attempted. (triggered by: %TRIGGER_SOURCE%) >> "%LOG_FILE%"
