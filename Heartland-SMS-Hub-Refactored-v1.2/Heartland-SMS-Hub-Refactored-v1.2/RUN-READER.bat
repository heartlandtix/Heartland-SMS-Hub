@echo off
setlocal
title Heartland SMS Reader

if not exist "%~dp0HeartlandSmsReader.exe" (
    echo HeartlandSmsReader.exe has not been built yet.
    echo Run BUILD-READER.bat first.
    pause
    exit /b 1
)

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
      "Start-Process -FilePath '%~dp0HeartlandSmsReader.exe' -Verb RunAs"
    exit /b
)

"%~dp0HeartlandSmsReader.exe"
