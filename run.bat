@echo off
rem Sobe o Nexo. O app liga o motor sozinho, sem janela.
rem   run.bat          -> abre o app (esta janela fica so com o log)
rem   run.bat daemon   -> so o motor, em primeiro plano
rem Para abrir sem console nenhum, gere o atalho: make-shortcut.ps1 -Desktop
setlocal
cd /d "%~dp0"
title Nexo

rem Se este .bat for aberto a partir de um terminal filho de outro app Electron
rem (ex.: terminal integrado de um editor baseado em Electron), essa variavel
rem vem herdada e faz o electron.exe rodar como Node puro em vez de abrir a
rem janela do app -- ele quebra ao importar "electron" e o console fica vazio,
rem sem log nenhum. Limpa antes de tudo pra nao herdar esse estado.
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>nul
if errorlevel 1 (
  echo [nexo] Node.js nao esta no PATH.
  exit /b 1
)

rem Checa o binario de verdade, nao so a pasta do pacote: pnpm cria
rem node_modules\electron mesmo quando bloqueia o script de postinstall que
rem baixa o electron.exe (approve-builds) -- a pasta existir nao quer dizer
rem que o app tem como abrir.
if not exist "apps\daemon\node_modules\tsx" goto install
if not exist "apps\desktop\node_modules\electron\dist\electron.exe" goto install
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
if not exist "apps\desktop\node_modules\electron\dist\electron.exe" (
  echo [nexo] pnpm instalou os pacotes mas nao baixou o electron.exe.
  echo [nexo] o pnpm bloqueia script de postinstall por padrao. Rode:
  echo [nexo]   pnpm approve-builds
  echo [nexo] aprove "electron" e "esbuild", depois rode run.bat de novo.
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
