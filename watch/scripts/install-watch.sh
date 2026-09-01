#!/usr/bin/env bash
# Instala OS en el Apple Watch, sin .ipa ni SideStore.
#
# DOS COSAS QUE COSTARON UNA TARDE CADA UNA
#
# 1) Hay que compilar apuntando al RELOJ, no al iPhone. Con un Apple ID
#    gratuito el perfil de firma lista los dispositivos uno por uno, y
#    compilar contra el iPhone genera un perfil que contiene SOLO el iPhone.
#    El reloj recibe la app, ve que no le corresponde y la rechaza con "no se
#    pudo verificar su integridad" — un mensaje que no apunta a la causa.
#
# 2) La app del reloj se instala desde la copia EMPOTRADA en la app del
#    iPhone, no desde un build aparte. Para watchOS una app de reloj pertenece
#    a la del iPhone; una instalada suelta queda huérfana y el sistema la
#    BORRA en la siguiente sincronización — se ve como "la app desaparece
#    sola a los minutos". Por eso aquí se instalan las dos, en orden.
#
# Requisitos, todos aprendidos a golpes:
#   · Modo de desarrollador activo EN EL RELOJ (Ajustes, al final del todo)
#   · reloj y Mac en la MISMA wifi (el túnel va por red, no por el cable)
#   · el reloj DESBLOQUEADO y despierto; si el iPhone está al lado tira por
#     Bluetooth y no se une al wifi — apagar su Bluetooth lo fuerza

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IPHONE="${HERMES_IPHONE_UDID:-00008110-0014158C36B8401E}"
RELOJ="${HERMES_WATCH_UDID:-00008310-001D0D323A00E01E}"

echo
echo "⌚ compilando contra el reloj (registra su UDID en el perfil)…"
xcodebuild -project Hermes.xcodeproj -scheme HermesWatch -configuration Debug \
  -destination "platform=watchOS,id=$RELOJ" \
  -derivedDataPath build/dw -allowProvisioningUpdates build \
  > build/watch-build.log 2>&1 \
  || { echo "  ✗ mira build/watch-build.log"; exit 1; }

echo "📱 compilando la app del iPhone (lleva el reloj dentro)…"
xcodebuild -project Hermes.xcodeproj -scheme Hermes -configuration Debug \
  -destination "generic/platform=iOS" -derivedDataPath build/dd \
  -allowProvisioningUpdates build > build/ios-build.log 2>&1 \
  || { echo "  ✗ mira build/ios-build.log"; exit 1; }

APP="build/dd/Build/Products/Debug-iphoneos/Hermes.app"

echo "📱 instalando en el iPhone…"
xcrun devicectl device install app --device "$IPHONE" "$APP" > /dev/null

echo "⌚ instalando en el reloj la copia empotrada…"
xcrun devicectl device install app --device "$RELOJ" "$APP/Watch/HermesWatch.app"

echo
echo "  ✓ listo — ábrela desde la Digital Crown"
echo
