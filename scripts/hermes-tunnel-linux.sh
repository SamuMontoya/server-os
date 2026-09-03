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
#
# BUG encontrado y corregido (2026-09-03): el match original era
# `[[ "$line" == *"trycloudflare.com"* ]]` a secas — y cloudflared TAMBIÉN
# loguea esa misma URL en cada línea de acceso normal (`dest=https://…
# trycloudflare.com/...`, una por cada request que pasa por el túnel). Con
# tráfico real llegando, eso republicaba la URL una y otra vez indefinidamente
# — inofensivo mientras la URL no cambiaba, PERO significaba que un cambio
# MANUAL de remote_config (para probar otro transporte, por ejemplo) se
# pisaba solo en cuanto llegaba la siguiente request. Ahora solo publica UNA
# vez por arranque del proceso (nunca vuelve a cambiar mientras viva), y solo
# ante la línea real del banner ("Your quick Tunnel has been created"), no
# ante cualquier mención suelta de la URL.
#
# SEGUNDO bug encontrado el mismo día: cloudflared puede quedarse COLGADO
# después del precheck de red, sin morir ni avanzar — visto en vivo, más de
# 15 minutos sin una sola línea nueva. `Restart=always` de la unidad no sirve
# para esto: el proceso sigue VIVO, solo no hace nada, y systemd no reinicia
# nada que no haya salido. Por eso el vigilante de abajo: si a los
# STARTUP_TIMEOUT_S segundos no se publicó ninguna URL, mata al proceso a
# mano — ESO sí dispara el `Restart=always` de la unidad, que reintenta
# desde cero (a veces basta para des-colgarlo).
STARTUP_TIMEOUT_S=90
published_flag="$(mktemp -u "/tmp/hermes-tunnel-published.XXXXXX")"
trap 'rm -f "$published_flag"' EXIT

published=0
"$CLOUDFLARED" tunnel --url "http://localhost:$AGENT_PORT" > >(
  while IFS= read -r line; do
    echo "$line"
    if [[ "$published" == "0" && "$line" == *"Your quick Tunnel has been created"* ]]; then
      published=1
    elif [[ "$published" == "1" && "$line" == *"trycloudflare.com"* ]]; then
      url="$(echo "$line" | grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com')"
      if [[ -n "$url" ]]; then
        publish_url "$url"
        published=2
        : > "$published_flag"
      fi
    fi
  done
) 2>&1 &
cf_pid=$!

(
  sleep "$STARTUP_TIMEOUT_S"
  if [[ ! -f "$published_flag" ]] && kill -0 "$cf_pid" 2>/dev/null; then
    echo "hermes-tunnel: sin URL publicada en ${STARTUP_TIMEOUT_S}s — cloudflared parece colgado, lo mato para que la unidad reintente"
    kill "$cf_pid" 2>/dev/null
  fi
) &
watcher_pid=$!

wait "$cf_pid" 2>/dev/null
kill "$watcher_pid" 2>/dev/null || true
