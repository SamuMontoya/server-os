#!/usr/bin/env bash
# hermes-tunnel-linux.sh — Expone el agente a internet con un quick tunnel de
# cloudflared y publica la URL vigente en Supabase (remote_config), donde el
# portal (apps/web, deployado en Vercel) la lee para saber a qué agente hablar.
#
# Por qué esto y no Tailscale Funnel: Funnel exponía el agente públicamente,
# pero las funciones serverless de Vercel fallaban al conectarse (ENOTFOUND /
# ECONNRESET intermitentes — confirmado en los logs de runtime de Vercel), muy
# probablemente por cómo Tailscale trata tráfico entrante desde rangos de IP
# de proveedores cloud conocidos. cloudflared es la ruta estándar para
# exponer un servicio de casa al público y no tiene ese problema.
#
# Por qué "quick tunnel" y no uno con dominio propio: un quick tunnel no
# exige cuenta de Cloudflare ni login (arranca en segundos), pero la URL
# ROTA en cada reinicio del proceso — por eso NO se hornea en
# NEXT_PUBLIC_HERMES_URL del portal. En su lugar se publica en
# `remote_config` (tabla ya existente, RLS: cualquier usuario autenticado
# puede leerla) y el portal la resuelve en tiempo de ejecución al cargar,
# con el env var como respaldo si por lo que sea no puede leerla. Ver
# `apps/web/src/lib/hermes.ts` (cliente) y las rutas /api/claude-limits y
# /api/claude-usage (servidor) para el lado que lee esto.
#
# Si algún día se quiere una URL fija: `cloudflared tunnel login` (pide
# cuenta + dominio en Cloudflare) y un tunnel con nombre en vez de uno quick
# — ahí SÍ se podría hornear la URL en Vercel sin este mecanismo.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

env_get() {
  grep -E "^[[:space:]]*$1=" "$ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs 2>/dev/null || true
}

AGENT_PORT="$(env_get HERMES_PORT)"; AGENT_PORT="${AGENT_PORT:-8650}"
SUPA_URL="$(env_get NEXT_PUBLIC_SUPABASE_URL)"
SUPA_SECRET="$(env_get SUPABASE_SERVICE_ROLE_KEY)"

if [[ -z "$SUPA_URL" || -z "$SUPA_SECRET" ]]; then
  echo "hermes-tunnel: faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env" >&2
  exit 1
fi

CLOUDFLARED="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
if [[ ! -x "$CLOUDFLARED" ]]; then
  echo "hermes-tunnel: cloudflared no está instalado en $CLOUDFLARED" >&2
  exit 1
fi

publish_url() {
  local url="$1"
  curl -sf -X POST "$SUPA_URL/rest/v1/remote_config" \
    -H "apikey: $SUPA_SECRET" \
    -H "Authorization: Bearer $SUPA_SECRET" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates" \
    -d "{\"key\":\"agent_public_url\",\"value\":\"$url\"}" \
    > /dev/null
  echo "hermes-tunnel: publicado $url"
}

echo "hermes-tunnel: arrancando quick tunnel → localhost:$AGENT_PORT"

# NOTA (2026-09-03): el quick tunnel (sin cuenta, *.trycloudflare.com) bufere
# las respuestas SSE del chat COMPLETAS hasta que la conexión está por
# cerrarse — confirmado con curl directo al túnel, con varias combinaciones
# (--protocol http2, un comentario SSE de 8KB para forzar el primer flush,
# las dos juntas): un turno real de ~5-10s con 6-7 eventos separados llegaba
# ENTERO en una ventana de 60-140ms al final en TODOS los casos. La conexión
# directa (Tailscale, sin Cloudflare de por medio) sí fluye evento a evento
# en tiempo real con el mismo código — así que no es un bug del motor de
# turnos ni del cliente, es el túnel gratuito. El chat sigue funcionando
# (la respuesta completa igual llega), pero sin el efecto de "streaming en
# vivo": se ve el orbe de "pensando" y de golpe aparece todo. Arreglo real
# pendiente: un named tunnel (`cloudflared tunnel login`, pide cuenta +
# dominio de Cloudflare) en vez de un quick tunnel — fuera de alcance sin
# que Samuel decida la cuenta/dominio.
#
# cloudflared imprime la URL asignada en stderr como parte de una tabla ASCII
# ("|  https://algo.trycloudflare.com  |"); se lee línea a línea y se publica
# apenas aparece, sin esperar a que el proceso termine (corre indefinidamente).
"$CLOUDFLARED" tunnel --url "http://localhost:$AGENT_PORT" 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ "$line" == *"trycloudflare.com"* ]]; then
    url="$(echo "$line" | grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com')"
    [[ -n "$url" ]] && publish_url "$url"
  fi
done
