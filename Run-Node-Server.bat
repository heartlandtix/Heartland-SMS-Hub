@echo off
REM %~dp0 is this script's own folder - works no matter which account
REM name or drive this is copied to.
cd /d "%~dp0server"

if exist "%~dp0node-runtime\node.exe" (
    "%~dp0node-runtime\node.exe" index.js >> "C:\HeartlandData\logs\node.log" 2>&1
) else (
    node index.js >> "C:\HeartlandData\logs\node.log" 2>&1
)
