$ErrorActionPreference='Stop'
$InstallRoot=Join-Path $env:LOCALAPPDATA 'ConsultorioPsicologia'
New-Item -ItemType Directory -Force $InstallRoot | Out-Null
$here=Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg=Split-Path -Parent $here
# Encerra o servidor desta instalação para poder substituir os arquivos
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallRoot) } | Stop-Process -Force
Copy-Item (Join-Path $pkg 'app') $InstallRoot -Recurse -Force
if(Test-Path (Join-Path $pkg 'data')) { New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'data') | Out-Null; Copy-Item (Join-Path $pkg 'data\*') (Join-Path $InstallRoot 'data') -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'scripts') | Out-Null
Copy-Item (Join-Path $pkg 'scripts\launcher.ps1') (Join-Path $InstallRoot 'scripts\launcher.ps1') -Force
$bat=Join-Path $InstallRoot 'INICIAR.bat'
Set-Content $bat -Value @('@echo off','start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\launcher.ps1"') -Encoding ASCII
$ico=Join-Path $InstallRoot 'consultorio.ico'
Copy-Item (Join-Path $pkg 'app\public\consultorio.ico') $ico -Force
$desktop=[Environment]::GetFolderPath('Desktop')
$ws=New-Object -ComObject WScript.Shell
$sc=$ws.CreateShortcut((Join-Path $desktop 'Consultório Psicologia.lnk'))
$sc.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$sc.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $InstallRoot 'scripts\launcher.ps1')+'"'
$sc.WorkingDirectory=$InstallRoot
$sc.IconLocation=$ico
$sc.WindowStyle=7
$sc.Description='Consultório de Psicologia'
$sc.Save()
Write-Host "Instalado em $InstallRoot"
Write-Host 'Atalho criado na Área de Trabalho.'
