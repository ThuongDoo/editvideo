@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Dang tao file zip...
rem Bypass chi ap dung cho lan chay nay, khong doi cai dat cua may.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-zip.ps1"
echo.
echo Xong. File zip nam trong thu muc dist.
pause
