@echo off
chcp 65001 >nul
title GS Bot (开发测试模式)
echo ============================================
echo  GS Bot 开发测试模式
echo  直接从源码运行，无需打包
echo ============================================
echo.

cd /d "e:\GS Bot-app"

echo 正在启动 GS Bot...
echo 提示: 关闭此窗口将退出应用
echo.

npx electron . --gsbot-use-dist

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 应用异常退出，错误代码: %ERRORLEVEL%
    pause
)
