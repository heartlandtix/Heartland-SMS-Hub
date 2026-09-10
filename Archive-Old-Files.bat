@echo off
setlocal
set "PROJECT_DIR=%~dp0"
set "ARCHIVE=%PROJECT_DIR%Old-ChatGPT-Files"

echo ============================================================
echo  Archiving old, unused files
echo ============================================================
echo.
echo Moving known leftover files/folders into:
echo   %ARCHIVE%
echo.
echo Nothing is being deleted - just moved out of the way so it can
echo never accidentally get swept into a future deployment.
echo.

if not exist "%ARCHIVE%" mkdir "%ARCHIVE%"

if exist "%PROJECT_DIR%Heartland-SMS-Hub-Refactored-v1.2" move "%PROJECT_DIR%Heartland-SMS-Hub-Refactored-v1.2" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%Heartland-SMS-Hub-Refactored-v1.2.zip" move "%PROJECT_DIR%Heartland-SMS-Hub-Refactored-v1.2.zip" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%Heartland-SMS-Hub-v2.0.0a-ACTUAL-LAN-Server" move "%PROJECT_DIR%Heartland-SMS-Hub-v2.0.0a-ACTUAL-LAN-Server" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%Heartland-SMS-Hub-v2.0.0a-REAL-LAN-Web-Inbox" move "%PROJECT_DIR%Heartland-SMS-Hub-v2.0.0a-REAL-LAN-Web-Inbox" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%Heartlan.A60A9E18" move "%PROJECT_DIR%Heartlan.A60A9E18" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%BUILD-READER.bat" move "%PROJECT_DIR%BUILD-READER.bat" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%RUN-READER.bat" move "%PROJECT_DIR%RUN-READER.bat" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%Run-Node-Server.bat" move "%PROJECT_DIR%Run-Node-Server.bat" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%Install-Scheduled-Tasks.bat" move "%PROJECT_DIR%Install-Scheduled-Tasks.bat" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%SmsService.cpp" move "%PROJECT_DIR%SmsService.cpp" "%ARCHIVE%\" >nul
if exist "%PROJECT_DIR%SmsService.h" move "%PROJECT_DIR%SmsService.h" "%ARCHIVE%\" >nul

echo.
echo ============================================================
echo  Done. Check %ARCHIVE%
echo  to confirm everything moved correctly.
echo ============================================================
echo.
pause
