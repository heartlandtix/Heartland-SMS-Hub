@echo off
setlocal
title Build Heartland SMS Reader

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"

if not exist "%VSWHERE%" (
    echo Microsoft C++ Build Tools were not found.
    echo.
    echo Install "Visual Studio 2022 Build Tools" with:
    echo   Desktop development with C++
    echo   Windows 10 or Windows 11 SDK
    echo.
    echo Then run this file again.
    pause
    exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -property installationPath`) do (
    set "VSROOT=%%i"
)

if not defined VSROOT (
    echo Visual Studio Build Tools installation was not found.
    pause
    exit /b 1
)

call "%VSROOT%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b 1

msbuild "%~dp0HeartlandSmsReader.vcxproj" /m /p:Configuration=Release /p:Platform=x64
if errorlevel 1 (
    echo.
    echo Build failed. Take a screenshot of the red error lines and upload it.
    pause
    exit /b 1
)

copy /y "%~dp0x64\Release\HeartlandSmsReader.exe" "%~dp0HeartlandSmsReader.exe" >nul

echo.
echo Build succeeded.
echo Double-click HeartlandSmsReader.exe to run the read-only test.
pause
