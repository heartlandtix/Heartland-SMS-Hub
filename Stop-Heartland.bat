@echo off
echo Stopping Heartland SMS Hub...

REM Stop the actual programs first (specific, unambiguous names).
taskkill /F /IM HeartlandSmsReader.exe >nul 2>nul
taskkill /F /IM node.exe >nul 2>nul

REM Stop the two wrapper command windows - but ONLY the ones actually
REM running our own scripts, not any other unrelated cmd.exe window
REM you might have open (like a terminal you're using for something
REM else entirely). This checks each cmd.exe's actual command line,
REM not just its name.
powershell -NoProfile -Command ^
    "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" |" ^
    "Where-Object { $_.CommandLine -like '*Run-Reader-Loop.bat*' -or $_.CommandLine -like '*node.exe*index.js*' } |" ^
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo Done.
timeout /t 2 /nobreak >nul
