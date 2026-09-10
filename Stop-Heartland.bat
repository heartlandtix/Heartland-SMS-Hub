@echo off
echo Stopping Heartland SMS Hub...

set "ATTEMPTS=0"
set "MAX_ATTEMPTS=20"

:killloop
set /a ATTEMPTS+=1

REM Stop the wrapping loops FIRST - the reader's loop is specifically
REM designed to immediately relaunch its program the instant it dies,
REM so killing the loop before the program means there's nothing left
REM alive to react when we then kill the actual programs a moment
REM later. Matches on "node" broadly (not just "node.exe") so this
REM also catches the dev PC's bare "node index.js" command, not just
REM the bundled node-runtime path used on field machines.
powershell -NoProfile -Command ^
    "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" |" ^
    "Where-Object { $_.CommandLine -like '*Run-Reader-Loop.bat*' -or $_.CommandLine -like '*node*index.js*' } |" ^
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

REM Now stop the actual programs.
taskkill /F /IM HeartlandSmsReader.exe >nul 2>nul
taskkill /F /IM node.exe >nul 2>nul

REM Give Windows a moment, then check whether anything actually
REM survived this pass - if so, loop back and try again automatically
REM rather than requiring the file to be re-run by hand.
timeout /t 1 /nobreak >nul

set "STILL_RUNNING=0"

tasklist /FI "IMAGENAME eq HeartlandSmsReader.exe" 2>nul | find /I "HeartlandSmsReader.exe" >nul
if %errorlevel%==0 set "STILL_RUNNING=1"

tasklist /FI "IMAGENAME eq node.exe" 2>nul | find /I "node.exe" >nul
if %errorlevel%==0 set "STILL_RUNNING=1"

if "%STILL_RUNNING%"=="1" (
    if %ATTEMPTS% LSS %MAX_ATTEMPTS% (
        goto killloop
    )
)

echo.
if "%STILL_RUNNING%"=="1" (
    echo WARNING: Something is still running after %MAX_ATTEMPTS% attempts.
    echo You may need to close it manually via Task Manager.
) else (
    echo Done. ^(Took %ATTEMPTS% attempt^(s^) to fully stop.^)
)
timeout /t 2 /nobreak >nul
