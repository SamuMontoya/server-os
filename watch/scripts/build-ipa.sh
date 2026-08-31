#!/usr/bin/env bash
# Produce el .ipa SIN FIRMAR que SideStore instala en el iPhone.
#
# Sin firmar es lo correcto aquí: SideStore firma en el propio teléfono con
# tu Apple ID, y esa firma es la que se renueva sola cada 7 días. Firmar en
# la Mac exigiría un equipo de desarrollo y SideStore la reemplazaría igual.
#
# `xcodebuild -exportArchive` NO sirve para esto: siempre quiere firmar. El
# .ipa se arma a mano, que es lo que ese comando hace por dentro — un zip con
# el .app dentro de una carpeta Payload/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
cd "$ROOT"

say() { printf "  %s\n" "$*"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$*"; }
die() { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; exit 1; }

echo
echo "⌚ Hermes — .ipa para SideStore"
echo

command -v xcodebuild >/dev/null || die "falta xcodebuild"
# Con solo las Command Line Tools, xcodebuild existe pero no compila apps.
xcodebuild -version >/dev/null 2>&1 || die "Xcode no está activo. Instálalo y corre:
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
ok "$(xcodebuild -version | head -1)"

command -v xcodegen >/dev/null || die "falta xcodegen (brew install xcodegen)"
xcodegen generate --quiet
ok "proyecto regenerado desde project.yml"

rm -rf "$BUILD"
mkdir -p "$BUILD"

say "compilando (esto tarda la primera vez)…"
xcodebuild archive \
  -project Hermes.xcodeproj \
  -scheme Hermes \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$BUILD/Hermes.xcarchive" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  > "$BUILD/xcodebuild.log" 2>&1 \
  || die "falló la compilación — mira $BUILD/xcodebuild.log"
ok "compilado"

APP="$BUILD/Hermes.xcarchive/Products/Applications/Hermes.app"
[[ -d "$APP" ]] || die "no apareció Hermes.app en el archive"

# LA comprobación que importa: si el reloj no quedó dentro, el .ipa se
# instala igual en el iPhone y el reloj nunca ofrece nada — un fallo mudo.
[[ -d "$APP/Watch/HermesWatch.app" ]] \
  || die "el .app NO lleva la app del reloj dentro (revisa la fase de empotrado)"
ok "la app del reloj va dentro del bundle"

rm -rf "$BUILD/Payload"
mkdir -p "$BUILD/Payload"
cp -R "$APP" "$BUILD/Payload/"
( cd "$BUILD" && zip -qry Hermes.ipa Payload )
rm -rf "$BUILD/Payload"

ok "$BUILD/Hermes.ipa ($(du -h "$BUILD/Hermes.ipa" | cut -f1))"
echo
say "dentro del .ipa:"
unzip -l "$BUILD/Hermes.ipa" | grep -E "\.app/$" | awk '{print "     " $4}'
echo
say "siguiente: pásalo al iPhone (AirDrop) y ábrelo con SideStore"
echo
