$ErrorActionPreference='Stop'
$InstallRoot=Join-Path $env:LOCALAPPDATA 'ConsultorioPsicologia'
New-Item -ItemType Directory -Force $InstallRoot | Out-Null
$here=Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg=Split-Path -Parent $here
# Encerra o servidor desta instalação para poder substituir os arquivos
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallRoot) } | Stop-Process -Force
Get-Process Consultorio -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallRoot) } | Stop-Process -Force
Copy-Item (Join-Path $pkg 'app') $InstallRoot -Recurse -Force
if(Test-Path (Join-Path $pkg 'data')) { New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'data') | Out-Null; Copy-Item (Join-Path $pkg 'data\*') (Join-Path $InstallRoot 'data') -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'scripts') | Out-Null
Copy-Item (Join-Path $pkg 'scripts\launcher.ps1') (Join-Path $InstallRoot 'scripts\launcher.ps1') -Force
$bat=Join-Path $InstallRoot 'INICIAR.bat'
Set-Content $bat -Value @('@echo off','start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\launcher.ps1"') -Encoding ASCII
$ico=Join-Path $InstallRoot 'consultorio.ico'
Copy-Item (Join-Path $pkg 'app\public\consultorio.ico') $ico -Force
# Consultorio.exe: alvo do atalho (evita que o atalho chame o PowerShell, o que alguns antivírus removem)
$exe=Join-Path $InstallRoot 'Consultorio.exe'
if(Test-Path (Join-Path $pkg 'Consultorio.exe')){ Copy-Item (Join-Path $pkg 'Consultorio.exe') $exe -Force }
function New-AppShortcut($folder){
  New-Item -ItemType Directory -Force $folder | Out-Null
  $ws=New-Object -ComObject WScript.Shell
  $sc=$ws.CreateShortcut((Join-Path $folder 'Consultório Psicologia.lnk'))
  if(Test-Path $exe){
    $sc.TargetPath=$exe
  } else {
    $sc.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sc.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $InstallRoot 'scripts\launcher.ps1')+'"'
  }
  $sc.WorkingDirectory=$InstallRoot
  $sc.IconLocation=$ico
  $sc.WindowStyle=7
  $sc.Description='Consultório de Psicologia'
  $sc.Save()
}
New-AppShortcut ([Environment]::GetFolderPath('Desktop'))
New-AppShortcut ([Environment]::GetFolderPath('Programs'))   # cópia no Menu Iniciar, caso o da Área de Trabalho seja removido
Write-Host "Instalado em $InstallRoot"
Write-Host 'Atalhos criados na Área de Trabalho e no Menu Iniciar.'
