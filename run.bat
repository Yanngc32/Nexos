@echo off
rem Sobe o Nexos. O app liga o motor sozinho, sem janela.
rem   run.bat          -> abre o app (esta janela fica so com o log)
rem   run.bat daemon   -> so o motor, em primeiro plano
rem   run.bat dev      -> modo de teste: motor e dados isolados do Nexos instalado
rem                       (~/.nexos-dev, porta 7433) e recarga automatica ao salvar
rem Para abrir sem console nenhum, gere o atalho: make-shortcut.ps1 -Desktop
setlocal
cd /d "%~dp0"
title Nexos

rem Se este .bat for aberto a partir de um terminal filho de outro app Electron
rem (ex.: terminal integrado de um editor baseado em Electron), essa variavel
rem vem herdada e faz o electron.exe rodar como Node puro em vez de abrir a
rem janela do app -- ele quebra ao importar "electron" e o console fica vazio,
rem sem log nenhum. Limpa antes de tudo pra nao herdar esse estado.
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>nul
if errorlevel 1 (
  echo [nexos] Node.js nao esta no PATH.
  exit /b 1
)

rem Checa o binario de verdade, nao so a pasta do pacote: pnpm cria
rem node_modules\electron mesmo quando bloqueia o script de postinstall que
rem baixa o electron.exe (approve-builds) -- a pasta existir nao quer dizer
rem que o app tem como abrir.
if not exist "apps\daemon\node_modules\tsx" goto install
if not exist "apps\desktop\node_modules\electron\dist\electron.exe" goto install

rem Esses dois checks acima so pegam "nunca instalou". Se o pnpm-lock.yaml
rem mudou desde o ultimo install (ex.: git pull trouxe dependencia nova),
rem os binarios continuam existindo e o script pulava o install sem checar
rem o lockfile -- compara um hash salvo pra pegar esse caso.
set "LOCK_MARKER=node_modules\.nexos-lock-hash"
set "LOCK_HASH="
for /f "usebackq delims=" %%H in (`certutil -hashfile pnpm-lock.yaml SHA256 2^>nul ^| findstr /v "hash CertUtil"`) do set "LOCK_HASH=%%H"
if not exist "%LOCK_MARKER%" goto install
set /p LOCK_SAVED=<"%LOCK_MARKER%"
if not "%LOCK_HASH%"=="%LOCK_SAVED%" goto install
goto deps_ok

:install
echo [nexos] instalando dependencias...
where pnpm >nul 2>nul
if errorlevel 1 (
  call corepack pnpm install
) else (
  call pnpm install
)
if errorlevel 1 (
  echo [nexos] falha no install. Rode manualmente: corepack pnpm install
  exit /b 1
)
if not exist "apps\desktop\node_modules\electron\dist\electron.exe" (
  echo [nexos] pnpm instalou os pacotes mas nao baixou o electron.exe.
  echo [nexos] o pnpm bloqueia script de postinstall por padrao. Rode:
  echo [nexos]   pnpm approve-builds
  echo [nexos] aprove "electron" e "esbuild", depois rode run.bat de novo.
  exit /b 1
)
for /f "usebackq delims=" %%H in (`certutil -hashfile pnpm-lock.yaml SHA256 2^>nul ^| findstr /v "hash CertUtil"`) do echo %%H > "node_modules\.nexos-lock-hash"

:deps_ok
if /i "%~1"=="daemon" (
  node "apps\daemon\scripts\nexo.mjs" up
  exit /b %errorlevel%
)

if /i "%~1"=="dev" set "NEXOS_DEV=1"

pushd "apps\desktop"
call "node_modules\.bin\electron.CMD" .
set "RC=%errorlevel%"
popd
exit /b %RC%
