#!/usr/bin/env bash
# server-os · actualización segura en el servidor
#
# Reemplaza al one-liner `git pull && pnpm install && pnpm build && restart`,
# que tiene un fallo grave en esta máquina: `next build` VACÍA `.next` al
# arrancar, así que un build que muere por OOM —lo normal con 3.2 GB si el
# swap no está puesto— deja el dashboard sin build y sin vuelta atrás. Y tras
# 5 reintentos systemd se rinde con "Start request repeated too quickly", que
# no menciona el build: parece un problema del servicio y no lo es.
#
# Aquí el build va a un directorio aparte y solo se intercambia si terminó
# bien. Si falla, el dashboard sigue sirviendo el build anterior.
#
# Uso:  ./scripts/deploy-linux.sh              → pull + build + intercambio
#       ./scripts/deploy-linux.sh --no-pull    → sin git pull (build local)
#       ./scripts/deploy-linux.sh --detach     → en segundo plano, a prueba de SSH
#       ./scripts/deploy-linux.sh --rollback   → volver al build anterior
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/apps/web"
LIVE="$WEB/.next"          # el que sirve `next start`
NEW="$WEB/.next-build"     # destino del build en curso
PREV="$WEB/.next-prev"     # el anterior, para --rollback

PULL=1
ROLLBACK=0
DETACH=0
case "${1:-}" in
  --no-pull)  PULL=0 ;;
  --rollback) ROLLBACK=1 ;;
  --detach)   DETACH=1 ;;
  "")         ;;
  *)          echo "opción desconocida: $1" >&2; exit 2 ;;
esac

say()  { printf "  %s\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "Esto es para el servidor Linux."

# ── Desconexión de SSH ────────────────────────────────────────────────
# El build tarda varios minutos en esta máquina. Lanzado a pelo por SSH, un
# corte de la conexión le manda SIGHUP y lo mata a mitad — con `.next` ya
# vaciado. --detach lo lanza como servicio transitorio de systemd: sigue vivo
# aunque se caiga la sesión, y los logs quedan en el journal.
if [[ "$DETACH" == "1" ]]; then
  # PATH explícito: un servicio transitorio NO hereda el entorno del shell, y
  # node/pnpm viven en ~/.nvm — sin esto el deploy arranca y muere en "pnpm no
  # está en el PATH". Es el mismo gotcha que las unidades de scripts/systemd/.
  systemd-run --user --unit=server-os-deploy --collect \
    --description="server-os · deploy" \
    --setenv=PATH="$PATH" \
    --property=WorkingDirectory="$ROOT" \
    "$ROOT/scripts/deploy-linux.sh"
  echo
  ok "deploy corriendo en segundo plano (sobrevive a la desconexión)"
  say "  seguir:  journalctl --user -u server-os-deploy -f"
  echo
  exit 0
fi

# Aviso cuando se corre a pelo por SSH sin multiplexor: no aborta, solo
# recuerda que existe --detach.
if [[ -n "${SSH_CONNECTION:-}" && -z "${TMUX:-}" && -z "${STY:-}" && "$ROLLBACK" == "0" ]]; then
  err "sesión SSH sin tmux: si se corta la conexión, el build muere a mitad"
  say "  usa:  ./scripts/deploy-linux.sh --detach"
  echo
fi

PNPM_BIN="$(command -v pnpm || true)"; [[ -n "$PNPM_BIN" ]] || die "pnpm no está en el PATH"

# El servicio queda en 'failed' tras agotar StartLimitBurst y a partir de ahí
# IGNORA cualquier `start` hasta que se limpie el contador. Sin esto, el
# deploy puede terminar correcto y el dashboard seguir caído.
unstick() { systemctl --user reset-failed hermes-web 2>/dev/null || true; }

# ── Rollback ──────────────────────────────────────────────────────────
if [[ "$ROLLBACK" == "1" ]]; then
  [[ -f "$PREV/BUILD_ID" ]] || die "no hay build anterior en $PREV"
  say "volviendo al build anterior…"
  systemctl --user stop hermes-web || true
  rm -rf "$NEW"
  if [[ -d "$LIVE" ]]; then mv "$LIVE" "$NEW"; fi
  mv "$PREV" "$LIVE"
  if [[ -d "$NEW" ]]; then mv "$NEW" "$PREV"; fi
  unstick
  systemctl --user start hermes-web
  ok "dashboard sirviendo el build anterior"
  exit 0
fi

echo
echo "⚙  server-os — deploy"
echo

# ── Memoria ───────────────────────────────────────────────────────────
# No aborta: con el build atómico un OOM ya no rompe nada. Pero avisa, porque
# sin swap el build se va a morir tras varios minutos y conviene saberlo antes.
MEM_MB="$(free -m | awk '/^Mem:/{print $2}')"
SWAP_MB="$(free -m | awk '/^Swap:/{print $2}')"
say "RAM ${MEM_MB}MB · swap ${SWAP_MB}MB"
if [[ "$MEM_MB" -lt 6000 && "$SWAP_MB" -lt 4000 ]]; then
  err "swap insuficiente para 'next build' — es la causa más común de deploy fallido aquí"
  say "  revisa que el swapfile siga activo:  swapon --show"
  say "  si no aparece, no sobrevivió al reinicio: falta su línea en /etc/fstab"
  say "  el dashboard actual NO se toca si el build falla, así que puedes seguir"
fi

# `.next` de tres generaciones a la vez: si el disco está justo, mejor saberlo
# antes que a mitad del build.
AVAIL_MB="$(df -Pm "$WEB" | awk 'NR==2{print $4}')"
if [[ "$AVAIL_MB" -lt 2000 ]]; then
  err "solo ${AVAIL_MB}MB libres en el disco — el build necesita margen"
fi

# ── Código y dependencias ─────────────────────────────────────────────
if [[ "$PULL" == "1" ]]; then
  # Un árbol sucio hace fallar el pull con un error de git que no dice qué
  # hacer. En el servidor solo el `.env` es local (y está gitignorado), así que
  # cualquier otra cosa modificada aquí es una sorpresa que conviene nombrar.
  DIRTY="$(git -C "$ROOT" status --porcelain --untracked-files=no)"
  if [[ -n "$DIRTY" ]]; then
    err "hay cambios locales sin commitear en el servidor:"
    printf '%s\n' "$DIRTY" | sed 's/^/      /'
    say "  para descartarlos:  git -C $ROOT checkout -- ."
    say "  o para saltarte el pull:  ./scripts/deploy-linux.sh --no-pull"
    die "deploy abortado antes de tocar nada"
  fi
  # `git pull` a secas exige upstream, y el servidor puede estar en una rama de
  # trabajo que no lo tiene: el error de git ahí no dice nada útil. Se resuelve
  # el remoto explícitamente y, si la rama es local-only, se avisa y se sigue
  # SIN pull en vez de abortar el deploy (el build sigue siendo válido).
  BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  if UPSTREAM="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    say "git pull ($UPSTREAM → $BRANCH)…"
    git -C "$ROOT" pull --ff-only
  else
    err "la rama '$BRANCH' no sigue a ninguna remota: no hay de dónde traer"
    say "  para traer main sin dejar esta rama:  git merge origin/main"
    say "  se compila lo que hay en el disco"
  fi
fi
say "instalando dependencias…"
(cd "$ROOT" && "$PNPM_BIN" install --frozen-lockfile)

# ── Build ─────────────────────────────────────────────────────────────
# El agente primero: es rápido y si rompe, no vale la pena gastar los minutos
# del build de la web.
say "compilando el agente…"
(cd "$ROOT" && "$PNPM_BIN" --filter @hermes/agent build)
ok "agente compilado"

say "compilando el dashboard en $NEW (el actual sigue sirviendo)…"
rm -rf "$NEW"
# Techo de heap explícito: por defecto V8 lo calcula sobre la RAM total,
# intenta crecer más de lo que hay y el kernel lo mata antes de terminar.
if ! (cd "$ROOT" && HERMES_WEB_DIST_DIR=".next-build" \
      NODE_OPTIONS="--max-old-space-size=1536" "$PNPM_BIN" --filter @hermes/web build); then
  rm -rf "$NEW"
  err "el build del dashboard falló — NADA se ha tocado"
  say "  el dashboard sigue con el build anterior: systemctl --user status hermes-web"
  die "deploy abortado"
fi
[[ -f "$NEW/BUILD_ID" ]] || { rm -rf "$NEW"; die "el build terminó sin BUILD_ID — salida inservible"; }
ok "build listo"

# ── Intercambio ───────────────────────────────────────────────────────
# `next start` lee los chunks del disco a demanda: mover `.next` en caliente
# rompe las peticiones en vuelo. Se para, se intercambia y se arranca: unos
# segundos de caída en vez de toda la duración del build.
say "intercambiando el build…"
systemctl --user stop hermes-web hermes-agent || true
rm -rf "$PREV"
if [[ -d "$LIVE" ]]; then mv "$LIVE" "$PREV"; fi
mv "$NEW" "$LIVE"
unstick
systemctl --user start hermes-agent hermes-web
ok "servicios arrancados"

# ── Verificación ──────────────────────────────────────────────────────
# Un deploy que no comprueba no es un deploy: el fallo de ayer se vio horas
# después, al abrir el dashboard.
PORT="$(grep -E '^HERMES_PORT=' "$ROOT/.env" | cut -d= -f2- || echo 8650)"
WEB_PORT="$(grep -E '^NEXT_PUBLIC_WEB_PORT=' "$ROOT/.env" | cut -d= -f2- || echo 31415)"
: "${PORT:=8650}" "${WEB_PORT:=31415}"

FAIL=0
for i in $(seq 1 10); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok "agente respondiendo en :$PORT"
    break
  fi
  if [[ "$i" == 10 ]]; then
    err "el agente no responde en :$PORT — journalctl --user -u hermes-agent -n 50"
    FAIL=1
  fi
  sleep 3
done

for i in $(seq 1 10); do
  if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${WEB_PORT}/"; then
    ok "dashboard respondiendo en :$WEB_PORT"
    break
  fi
  if [[ "$i" == 10 ]]; then
    err "el dashboard no responde en :$WEB_PORT"
    say "  logs:     journalctl --user -u hermes-web -n 50"
    say "  volver:   ./scripts/deploy-linux.sh --rollback"
    FAIL=1
  fi
  sleep 3
done

echo
exit "$FAIL"
