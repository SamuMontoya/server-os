#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build-web.sh · build resiliente del dashboard en una caja de 3.2 GB
#
# Por qué existe:
#   `pnpm build` (= `pnpm -r build`) recompilaba TODO el workspace aunque solo
#   se tocara un componente de apps/web, y lo hacía con hermes-agent (1.5 GB) y
#   hermes-web (900 MB) vivos. Con 3.2 GB de RAM eso se va a swap: el build se
#   queda "pensando" 10 minutos o muere sin explicación.
#
#   Este script: (1) compila solo lo que cambió, (2) libera RAM parando el web
#   mientras compila, (3) reintenta hasta 3 veces sin tirar la caché, (4) da
#   feedback cada pocos segundos para que no parezca colgado.
#
# Uso:
#   ./scripts/build-web.sh              → auto: detecta qué cambió
#   ./scripts/build-web.sh --all        → fuerza build de todo el workspace
#   ./scripts/build-web.sh --clean      → tira la caché y compila desde cero
#   ./scripts/build-web.sh --no-restart → compila pero no reinicia el servicio
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MAX_INTENTOS=${MAX_INTENTOS:-3}
# Un build sano tarda 2-5 min aquí. 15 min = algo se atascó en swap; mejor
# matarlo y reintentar que dejarlo colgado toda la tarde.
TIMEOUT_SEG=${TIMEOUT_SEG:-900}
HEARTBEAT_SEG=${HEARTBEAT_SEG:-15}
LOG_DIR="$ROOT/.build-logs"
mkdir -p "$LOG_DIR"

MODO="auto"
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --all) MODO="all" ;;
    --clean) MODO="clean" ;;
    --no-restart) RESTART=0 ;;
    *) echo "opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

# --- salida bonita ---------------------------------------------------------
if [[ -t 1 ]]; then C_OK=$'\e[32m'; C_ERR=$'\e[31m'; C_DIM=$'\e[2m'; C_B=$'\e[1m'; C_0=$'\e[0m'
else C_OK=""; C_ERR=""; C_DIM=""; C_B=""; C_0=""; fi
say()  { printf '%s▸%s %s\n' "$C_B" "$C_0" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_0" "$*" >&2; }
dim()  { printf '%s  %s%s\n' "$C_DIM" "$*" "$C_0"; }

hhmmss() { printf '%dm%02ds' $(( $1 / 60 )) $(( $1 % 60 )); }

PNPM_BIN="$(command -v pnpm || true)"
[[ -z "$PNPM_BIN" ]] && { err "no encuentro pnpm en el PATH"; exit 1; }

# --- 1. ¿qué hay que recompilar? -------------------------------------------
# Next no sabe compilar "solo el componente que cambié": su unidad mínima es la
# app entera. Lo que SÍ evitamos es recompilar paquetes del monorepo que nadie
# tocó — ahí está el ahorro real, más la caché de webpack en .next/cache.
detectar_scope() {
  local cambios
  cambios="$(git status --porcelain 2>/dev/null | awk '{print $NF}')"
  # Sin git o sin cambios detectables: no arriesgamos, build completo.
  [[ -z "$cambios" ]] && { echo "all"; return; }
  if grep -qE '^(apps/agent|packages/)' <<<"$cambios"; then
    echo "all"
  else
    echo "web"
  fi
}

case "$MODO" in
  all)   SCOPE="all" ;;
  clean) SCOPE="web" ;;
  auto)  SCOPE="$(detectar_scope)" ;;
esac

if [[ "$SCOPE" == "web" ]]; then
  BUILD_CMD=("$PNPM_BIN" --filter @hermes/web build)
  dim "solo cambió apps/web → compilo únicamente @hermes/web"
else
  BUILD_CMD=("$PNPM_BIN" -r build)
  dim "hay cambios en agent/packages → build completo del workspace"
fi

# --- 2. liberar RAM --------------------------------------------------------
# `next build` reescribe .next mientras `next start` lo está leyendo: además de
# competir por memoria, puede servir un manifest a medio escribir. Lo paramos y
# lo devolvemos al final pase lo que pase.
WEB_ESTABA_ACTIVO=0
if systemctl --user is-active --quiet hermes-web.service 2>/dev/null; then
  WEB_ESTABA_ACTIVO=1
fi

restaurar_servicio() {
  if [[ "$WEB_ESTABA_ACTIVO" == "1" ]] && ! systemctl --user is-active --quiet hermes-web.service; then
    say "levantando hermes-web…"
    systemctl --user start hermes-web.service && ok "hermes-web arriba"
  fi
}
trap restaurar_servicio EXIT INT TERM

if [[ "$WEB_ESTABA_ACTIVO" == "1" ]]; then
  say "parando hermes-web para liberar RAM durante el build…"
  systemctl --user stop hermes-web.service
fi

libre_mb() { awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo; }
dim "RAM disponible: $(libre_mb) MB"

# --- 3. build con reintentos ----------------------------------------------
# El heap se queda por debajo de la RAM libre a propósito: si Node se pasa,
# preferimos un fallo limpio de V8 (reintentable) a que el OOM killer del
# kernel se lleve por delante al agente.
export NODE_OPTIONS="--max-old-space-size=${HEAP_MB:-1400}"
export NEXT_TELEMETRY_DISABLED=1

intento_de_build() {
  local n="$1" log="$2"
  local inicio=$SECONDS

  # nice/ionice: si el build satura la caja, el agente sigue respondiendo.
  nice -n 10 "${BUILD_CMD[@]}" >"$log" 2>&1 &
  local pid=$!

  # Heartbeat: sin esto un build de 5 min en swap es indistinguible de uno
  # colgado, que es justo la queja original.
  local fase="arrancando"
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$HEARTBEAT_SEG"
    kill -0 "$pid" 2>/dev/null || break
    local t=$(( SECONDS - inicio ))
    local ultima
    ultima="$(grep -oE 'Creating an optimized production build|Compiled successfully|Linting|Checking validity of types|Collecting page data|Generating static pages|Finalizing page optimization' "$log" 2>/dev/null | tail -1)"
    [[ -n "$ultima" ]] && fase="$ultima"
    dim "[$(hhmmss $t)] $fase · RAM libre $(libre_mb) MB"
    if (( t > TIMEOUT_SEG )); then
      err "timeout tras $(hhmmss $t) — mato el build y reintento"
      kill -TERM "$pid" 2>/dev/null
      sleep 5
      kill -KILL "$pid" 2>/dev/null
      return 124
    fi
  done

  wait "$pid"
  local rc=$?
  dim "intento $n terminó en $(hhmmss $(( SECONDS - inicio ))) (código $rc)"
  return $rc
}

TS="$(date +%Y%m%d-%H%M%S)"
EXITO=0

for (( i=1; i<=MAX_INTENTOS; i++ )); do
  LOG="$LOG_DIR/build-$TS-intento$i.log"

  # La caché es lo que hace rápido el rebuild: NO se toca entre reintentos
  # normales. Solo en el último, y solo porque a esas alturas la sospecha
  # razonable es justamente una caché corrupta.
  if [[ "$MODO" == "clean" && $i -eq 1 ]] || [[ $i -eq $MAX_INTENTOS && $i -gt 1 ]]; then
    say "intento $i/$MAX_INTENTOS · limpiando caché (último recurso, será más lento)"
    rm -rf "$ROOT/apps/web/.next/cache"
  else
    say "intento $i/$MAX_INTENTOS · conservando .next/cache (build incremental)"
  fi

  if intento_de_build "$i" "$LOG"; then
    EXITO=1
    ok "build OK al intento $i"
    break
  fi

  err "intento $i falló. Últimas líneas:"
  tail -n 12 "$LOG" | sed 's/^/    /' >&2

  if (( i < MAX_INTENTOS )); then
    espera=$(( i * 10 ))
    say "reintentando en ${espera}s…"
    sleep "$espera"
  fi
done

if (( EXITO == 0 )); then
  err "el build falló tras $MAX_INTENTOS intentos · log: $LOG"
  restaurar_servicio
  exit 1
fi

# --- 4. reiniciar el dashboard --------------------------------------------
if (( RESTART == 1 )); then
  say "reiniciando hermes-web con el build nuevo…"
  systemctl --user restart hermes-web.service
  WEB_ESTABA_ACTIVO=0   # ya lo levantamos nosotros; el trap no debe repetirlo
  for _ in $(seq 1 20); do
    sleep 1
    if curl -sf -o /dev/null "http://localhost:${NEXT_PUBLIC_WEB_PORT:-31415}/"; then
      ok "dashboard respondiendo en :${NEXT_PUBLIC_WEB_PORT:-31415}"
      exit 0
    fi
  done
  err "el build quedó bien pero el dashboard no responde · journalctl --user -u hermes-web -n 50"
  exit 1
fi

ok "listo (sin reiniciar el servicio, --no-restart)"
