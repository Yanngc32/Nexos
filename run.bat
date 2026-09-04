@echo off
rem Sobe o Nexo. O app liga o motor sozinho, sem janela.
rem   run.bat          -> abre o app (esta janela fica so com o log)
rem   run.bat daemon   -> so o motor, em primeiro plano
rem Para abrir sem console nenhum, gere o atalho: make-shortcut.ps1 -Desktop
setlocal
cd /d "%~dp0"
title Nexo

where node >nul 2>nul
if errorlevel 1 (
  echo [nexo] Node.js nao esta no PATH.
  exit /b 1
)

if not exist "apps\daemon\node_modules\tsx" goto install
if not exist "apps\desktop\node_modules\electron" goto install
goto deps_ok

:install
echo [nexo] instalando dependencias...
where pnpm >nul 2>nul
if errorlevel 1 (
  call corepack pnpm install
) else (
  call pnpm install
)
if errorlevel 1 (
  echo [nexo] falha no install. Rode manualmente: corepack pnpm install
  exit /b 1
)

:deps_ok
if /i "%~1"=="daemon" (
  node "apps\daemon\scripts\nexo.mjs" up
  exit /b %errorlevel%
)

pushd "apps\desktop"
call "node_modules\.bin\electron.CMD" .
set "RC=%errorlevel%"
popd
exit /b %RC%
