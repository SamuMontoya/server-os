#!/usr/bin/env bash
# server-os · instalación en Linux (systemd --user)
#
# El `./hermes install` del repo original escribe plists de launchd y solo
# sirve en macOS. Esto es su equivalente: unidades de usuario, arranque al
# encender la máquina (linger) y logs a journald.
#
# Uso:  ./scripts/install-linux.sh            → build + instalar + arrancar
#       ./scripts/install-linux.sh --no-build → solo instalar unidades
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNITS="$HOME/.config/systemd/user"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

say()  { printf "  %s\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "Esto es para Linux. En macOS usa ./hermes install."

echo
echo "⚙  server-os — instalación en Linux"
echo

# ── Requisitos ────────────────────────────────────────────────────────
# Las rutas se resuelven ABSOLUTAS: systemd arranca con un PATH mínimo y no
# encuentra nada instalado en ~/.local/bin o ~/.nvm.
NODE_BIN="$(command -v node || true)"; [[ -n "$NODE_BIN" ]] || die "node no está en el PATH"
PNPM_BIN="$(command -v pnpm || true)"; [[ -n "$PNPM_BIN" ]] || die "pnpm no está en el PATH (corepack enable && corepack prepare pnpm@10.20.0 --activate)"
CLAUDE_BIN="$(command -v claude || true)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "node $NODE_MAJOR es muy viejo; se necesita 22+"
ok "node $("$NODE_BIN" -v) · pnpm $("$PNPM_BIN" -v)"

if [[ -z "$CLAUDE_BIN" ]]; then
  err "el CLI 'claude' no está instalado — el agente no podrá pensar"
  say "  instálalo con: curl -fsSL https://claude.ai/install.sh | bash"
else
  ok "claude $("$CLAUDE_BIN" --version 2>/dev/null | head -1)"
  # El login es POR MÁQUINA. Sin él el agente arranca pero cada turno falla.
  if ! "$CLAUDE_BIN" auth status 2>/dev/null | grep -q '"loggedIn": true'; then
    err "sin sesión de Claude en esta máquina"
    say "  corre:  claude auth login --claudeai   (te da un código para pegar)"
  else
    ok "sesión de Claude activa"
  fi
fi

[[ -f "$ROOT/.env" ]] || die "falta $ROOT/.env"
grep -qE '^MACHINE_NAME=.+' "$ROOT/.env" || die "MACHINE_NAME vacío en .env (debe ser único entre tus máquinas)"
ok "MACHINE_NAME=$(grep -E '^MACHINE_NAME=' "$ROOT/.env" | cut -d= -f2-)"

# ── Build ─────────────────────────────────────────────────────────────
if [[ "$BUILD" == "1" ]]; then
  # `next build` es lo único que pide memoria de verdad aquí. Con 3-4 GB de
  # RAM se queda corto y muere con un OOM que parece un error de compilación.
  MEM_MB="$(free -m | awk '/^Mem:/{print $2}')"
  SWAP_MB="$(free -m | awk '/^Swap:/{print $2}')"
  say "RAM ${MEM_MB}MB · swap ${SWAP_MB}MB"
  if [[ "$MEM_MB" -lt 6000 && "$SWAP_MB" -lt 4000 ]]; then
    err "poca memoria para 'next build'"
    say "  opciones: ampliar el swap, o compilar en otra máquina y copiar .next/"
    say "  para saltar el build:  ./scripts/install-linux.sh --no-build"
    die "abortado antes de intentar un build que probablemente falle"
  fi
  say "instalando dependencias…"
  (cd "$ROOT" && "$PNPM_BIN" install --frozen-lockfile)
  say "compilando (puede tardar bastante en esta máquina)…"
  # Techo de heap explícito: por defecto V8 lo calcula sobre la RAM total e
  # intenta crecer más de lo que hay, y el kernel lo mata antes de terminar.
  (cd "$ROOT" && NODE_OPTIONS="--max-old-space-size=1536" "$PNPM_BIN" build)
  ok "build listo"
fi

# ── Unidades ──────────────────────────────────────────────────────────
# PATH mínimo pero suficiente: los directorios REALES de node y claude.
UNIT_PATH="$(dirname "$NODE_BIN"):$(dirname "$PNPM_BIN")"
[[ -n "$CLAUDE_BIN" ]] && UNIT_PATH="$UNIT_PATH:$(dirname "$CLAUDE_BIN")"
UNIT_PATH="$UNIT_PATH:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$UNITS"
for svc in hermes-agent hermes-web hermes-watchdog; do
  sed -e "s|__ROOT__|$ROOT|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__PATH__|$UNIT_PATH|g" \
      -e "s|__PNPM__|$PNPM_BIN|g" \
      "$ROOT/scripts/systemd/$svc.service" > "$UNITS/$svc.service"
  ok "$UNITS/$svc.service"
done

# El vigía es lo único que trae timer aparte: el .service es un oneshot y
# quien insiste cada minuto es el .timer.
sed -e "s|__ROOT__|$ROOT|g" \
    "$ROOT/scripts/systemd/hermes-watchdog.timer" > "$UNITS/hermes-watchdog.timer"
ok "$UNITS/hermes-watchdog.timer"
chmod +x "$ROOT/scripts/hermes-watchdog.sh"

systemctl --user daemon-reload

# Sin linger, los servicios de usuario mueren al cerrar la sesión SSH y no
# vuelven en el arranque — justo lo contrario de un cerebro siempre encendido.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  say "habilitando linger (arranque sin sesión iniciada)…"
  sudo loginctl enable-linger "$USER" || err "no se pudo; córrelo a mano: sudo loginctl enable-linger $USER"
fi

systemctl --user enable --now hermes-agent.service
systemctl --user enable --now hermes-web.service
# Se habilita el TIMER, no el servicio: habilitar un oneshot no lo agenda.
systemctl --user enable --now hermes-watchdog.timer

echo
sleep 3
PORT="$(grep -E '^HERMES_PORT=' "$ROOT/.env" | cut -d= -f2- || echo 8650)"
if curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  ok "agente respondiendo en :$PORT"
else
  err "el agente no responde todavía — revisa: journalctl --user -u hermes-agent -n 50"
fi

echo
say "logs:      journalctl --user -u hermes-agent -f"
say "reiniciar: systemctl --user restart hermes-agent"
say "parar:     systemctl --user stop hermes-agent hermes-web"
echo
