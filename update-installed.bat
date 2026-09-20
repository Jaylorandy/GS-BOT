@echo off
chcp 65001 >nul
echo ============================================
echo  GS Bot 修复更新脚本
echo  修复 OCR JSON 解析错误 (自包含版)
echo ============================================
echo.

:: Check for admin privileges
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo 需要管理员权限，正在请求提升...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Run the PowerShell update script
powershell -ExecutionPolicy Bypass -File "%~dp0update-installed.ps1"

echo.
pause
