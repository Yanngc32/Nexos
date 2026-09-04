# Cria o atalho "Nexo.lnk" que abre o app sem console.
# Uso:  powershell -ExecutionPolicy Bypass -File make-shortcut.ps1 [-Desktop]
param([switch]$Desktop)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'apps\desktop\node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'

if (-not (Test-Path $exe)) {
  Write-Error "electron.exe nao encontrado. Rode antes: corepack pnpm install"
}

$targets = @(Join-Path $root 'Nexo.lnk')
if ($Desktop) { $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nexo.lnk' }

$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in $targets) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.Arguments = '"' + $appDir + '"'
  $s.WorkingDirectory = $appDir
  $s.IconLocation = "$exe,0"
  $s.Description = 'Nexo'
  $s.WindowStyle = 1
  $s.Save()
  Write-Output "criado: $lnk"
}
