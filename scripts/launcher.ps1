$ErrorActionPreference = 'Stop'
$InstallRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppDir = Join-Path $InstallRoot 'app'
$DataDir = Join-Path $InstallRoot 'data'
$RuntimeDir = Join-Path $InstallRoot 'runtime'
$NodeExe = Join-Path $RuntimeDir 'node.exe'
$Repo = 'LuisBredaSTI/consultorio-psicologia'
$VersionFile = Join-Path $AppDir 'version.json'

function Read-Version {
  if (Test-Path $VersionFile) { return (Get-Content $VersionFile -Raw | ConvertFrom-Json).version }
  return '0.0.0'
}
function Version-Parts($v) { return ($v.TrimStart('v') -split '.') | ForEach-Object {[int]$_} }
function Is-Newer($a,$b) {
  $pa=Version-Parts $a; $pb=Version-Parts $b
  for($i=0;$i -lt 3;$i++){ $x=if($i -lt $pa.Count){$pa[$i]}else{0}; $y=if($i -lt $pb.Count){$pb[$i]}else{0}; if($x -gt $y){return $true}; if($x -lt $y){return $false} }
  return $false
}
function Ensure-Node {
  if(Test-Path $NodeExe){ return }
  New-Item -ItemType Directory -Force $RuntimeDir | Out-Null
  $zip=Join-Path $env:TEMP 'consultorio-node.zip'
  $url='https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  $tmp=Join-Path $env:TEMP ('consultorio-node-'+[guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $folder=Get-ChildItem $tmp -Directory | Select-Object -First 1
  Copy-Item (Join-Path $folder.FullName '*') $RuntimeDir -Recurse -Force
  Remove-Item $tmp,$zip -Recurse -Force -ErrorAction SilentlyContinue
}
function Update-App {
  try {
    $current=Read-Version
    $remoteVersion = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/$Repo/main/app/version.json" -Headers @{ 'User-Agent'='ConsultorioUpdater' }
    $latest = $remoteVersion.version
    if(-not (Is-Newer $latest $current)){ return }
    $backupDir=Join-Path $DataDir 'backups'
    New-Item -ItemType Directory -Force $backupDir | Out-Null
    $db=Join-Path $DataDir 'consultorio.db'
    if(Test-Path $db){ Copy-Item $db (Join-Path $backupDir ('consultorio-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.db')) -Force }
    $zip=Join-Path $env:TEMP ('consultorio-update-'+[guid]::NewGuid().ToString('N')+'.zip')
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$Repo/main/releases/consultorio-update.zip" -OutFile $zip -UseBasicParsing
    $tmp=Join-Path $env:TEMP ('consultorio-update-'+[guid]::NewGuid().ToString('N'))
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $source=$tmp
    if(Test-Path (Join-Path $tmp 'app')){$source=Join-Path $tmp 'app'}
    Copy-Item (Join-Path $source '*') $AppDir -Recurse -Force
    Remove-Item $tmp,$zip -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    # Atualização automática nunca deve impedir o programa de abrir.
  }
}
Ensure-Node
Update-App
$env:CONSULTORIO_DATA_DIR=$DataDir
Start-Process -FilePath $NodeExe -ArgumentList @((Join-Path $AppDir 'server.js')) -WorkingDirectory $AppDir
Start-Sleep -Seconds 2
Start-Process 'http://localhost:3000'
