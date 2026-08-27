@echo off
echo Stopping Heartland SMS Hub...

REM Stop the wrapping loops FIRST, not the programs themselves. The
REM reader's loop is specifically designed to immediately relaunch its
REM program the instant it dies - killing the program before the loop
REM meant this often needed running multiple times to actually win the
REM race, since the loop would just start a fresh copy right back up
REM again before we got around to killing it too. Killing the loop
REM first means there's nothing left alive to react when we then kill
REM the actual programs a moment later.
powershell -NoProfile -Command ^
    "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" |" ^
    "Where-Object { $_.CommandLine -like '*Run-Reader-Loop.bat*' -or $_.CommandLine -like '*node.exe*index.js*' } |" ^
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

REM Now stop the actual programs, with nothing left to restart them.
taskkill /F /IM HeartlandSmsReader.exe >nul 2>nul
taskkill /F /IM node.exe >nul 2>nul

echo Done.
timeout /t 2 /nobreak >nul
