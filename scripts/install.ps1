$ErrorActionPreference='Stop'
$InstallRoot=Join-Path $env:LOCALAPPDATA 'ConsultorioPsicologia'
New-Item -ItemType Directory -Force $InstallRoot | Out-Null
$here=Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg=Split-Path -Parent $here
Copy-Item (Join-Path $pkg 'app') $InstallRoot -Recurse -Force
if(Test-Path (Join-Path $pkg 'data')) { New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'data') | Out-Null; Copy-Item (Join-Path $pkg 'data\*') (Join-Path $InstallRoot 'data') -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'scripts') | Out-Null
Copy-Item (Join-Path $pkg 'scripts\launcher.ps1') (Join-Path $InstallRoot 'scripts\launcher.ps1') -Force
$bat=Join-Path $InstallRoot 'INICIAR.bat'
Set-Content $bat '@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts/launcher.ps1"' -Encoding ASCII
$desktop=[Environment]::GetFolderPath('Desktop')
$ws=New-Object -ComObject WScript.Shell
$sc=$ws.CreateShortcut((Join-Path $desktop 'Consultório Psicologia.lnk'))
$sc.TargetPath=$bat; $sc.WorkingDirectory=$InstallRoot; $sc.Description='Consultório de Psicologia'; $sc.Save()
Write-Host "Instalado em $InstallRoot"
Write-Host 'Atalho criado na Área de Trabalho.'
