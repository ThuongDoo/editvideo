@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Ban dong goi co san runtime\node.exe; ban dev dung Node.js da cai tren may.
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"

if not exist node_modules (
  where npm >nul 2>nul || (
    echo Khong tim thay Node.js. Hay cai Node.js tu https://nodejs.org roi chay lai.
    pause
    exit /b 1
  )
  echo Dang cai dat lan dau...
  call npm install
)

"%NODE%" server.js
pause
