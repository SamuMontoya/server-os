#!/usr/bin/env bash
# Instala la app directamente en el Apple Watch, sin .ipa ni SideStore.
#
# LA CLAVE, que costó una tarde encontrar: hay que compilar apuntando al
# RELOJ, no al iPhone. Con un Apple ID gratuito el perfil de firma lista los
# dispositivos uno por uno, y compilar contra el iPhone genera un perfil que
# contiene SOLO el iPhone. El reloj recibe la app, ve que no le corresponde y
# la rechaza con "no se pudo verificar su integridad" — un mensaje que no
# apunta a la causa por ningún lado.
#
# Compilar con -destination platform=watchOS obliga a Xcode a registrar el
# UDID del reloj y a regenerar el perfil con los dos dentro.
#
# Requisitos, todos aprendidos a golpes:
#   · Modo de desarrollador activo EN EL RELOJ (Ajustes, al final del todo)
#   · reloj y Mac en la MISMA wifi (el túnel va por red, no por el cable)
#   · el reloj despierto; si el iPhone está al lado tira por Bluetooth y no
#     se une al wifi — apagar el Bluetooth del iPhone lo fuerza

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RELOJ="${HERMES_WATCH_UDID:-00008310-001D0D323A00E01E}"

echo
echo "⌚ instalando en el reloj…"
xcodebuild -project Hermes.xcodeproj -scheme HermesWatch -configuration Debug \
  -destination "platform=watchOS,id=$RELOJ" \
  -derivedDataPath build/dw -allowProvisioningUpdates build \
  > build/watch-build.log 2>&1 \
  || { echo "  ✗ falló la compilación — mira build/watch-build.log"; exit 1; }

APP="$(find build/dw/Build/Products -name "HermesWatch.app" -maxdepth 3 | head -1)"
xcrun devicectl device install app --device "$RELOJ" "$APP"
echo
echo "  ✓ listo — ábrela desde la Digital Crown"
echo
