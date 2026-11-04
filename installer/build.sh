#!/usr/bin/env bash
# Gera releases/Instalar-Consultorio-V<versão>.exe a partir do código em ../app e ../scripts.
# Requer Go. Uso: installer/build.sh
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../app/version.json)
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
command -v rsrc >/dev/null || go install github.com/akavel/rsrc@latest
RSRC="$(command -v rsrc || echo "$(go env GOPATH)/bin/rsrc")"
# Consultorio.exe (alvo do atalho)
( cd ../launcher && "$RSRC" -arch amd64 -ico ../app/public/consultorio.ico -manifest app.manifest -o rsrc_windows_amd64.syso \
  && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H=windowsgui" -o "$STAGE/Consultorio.exe" . )
cp -r ../app ../scripts ../README.md "$STAGE"/
# pacote de atualização (zip) e pacote embutido no instalador: mesmo conteúdo
rm -f payload.zip "../releases/consultorio-update-v$VERSION.zip"
(cd "$STAGE" && zip -qr "$OLDPWD/payload.zip" app scripts README.md Consultorio.exe)
cp payload.zip "../releases/consultorio-update-v$VERSION.zip"
"$RSRC" -arch amd64 -ico ../app/public/consultorio.ico -manifest app.manifest -o rsrc_windows_amd64.syso
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H=windowsgui -X main.version=$VERSION" -o "../releases/Instalar-Consultorio-V$VERSION.exe" .
echo "Gerado: releases/Instalar-Consultorio-V$VERSION.exe e releases/consultorio-update-v$VERSION.zip"
