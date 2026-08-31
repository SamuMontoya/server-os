#!/usr/bin/env bash
# server-os · vigía de servicios
#
# ── POR QUÉ EXISTE ───────────────────────────────────────────────────────
# `Restart=always` NO cubre una parada explícita. Si algo manda un `stop`
# —un deploy que muere entre el stop y el start, una sesión depurando, un
# `restart` que no llega a la segunda mitad— systemd marca la unidad como
# detenida a propósito y la deja abajo indefinidamente.
#
# Pasó el 31-ago-2026: agente y dashboard llevaban horas `inactive (dead)`
# por SIGTERM, con `NRestarts=0` y sin nada en estado `failed`. Ningún
# mecanismo los iba a levantar. El único síntoma fue un "Load failed" en el
# móvil, que no apunta a la causa por ningún lado.
#
# Y el otro extremo tampoco está cubierto: agotar `StartLimitBurst` deja la
# unidad en `failed` IGNORANDO los `start` siguientes ("Start request
# repeated too quickly") hasta que alguien limpia el contador a mano.
#
# ── QUÉ HACE (cada minuto, por timer) ────────────────────────────────────
#   1. Unidad no activa                → reset-failed + start
#   2. Unidad activa pero sin responder → restart, sólo al SEGUNDO fallo
#
# El (2) exige dos fallos seguidos a propósito: son 2 núcleos a 1.6 GHz y un
# turno pesado puede dejar el health sin contestar un momento. Reiniciar al
# primer timeout mataría trabajo real a mitad.
#
# Mientras corre un deploy no toca nada: ahí los servicios están abajo a
# propósito, y arrancar el dashboard sin build terminado sólo gastaría
# StartLimitBurst para nada.

set -uo pipefail   # sin -e: que falle una unidad no debe saltarse la otra

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESTADO="$HOME/.hermes-os/watchdog"
mkdir -p "$ESTADO"

# Sale por stdout → al journal, con el SyslogIdentifier de la unidad.
log() { printf '%s\n' "  $*"; }

if systemctl --user is-active --quiet server-os-deploy.service; then
  log "deploy en curso — el vigía no toca nada"
  exit 0
fi

# Los puertos son los del .env, no constantes: el instalador los lee de ahí
# y este script tiene que coincidir o "no responde" sería un falso positivo.
leer_env() {  # leer_env CLAVE DEFECTO
  local v=""
  [[ -f "$ROOT/.env" ]] && v="$(sed -n "s/^$1=//p" "$ROOT/.env" 2>/dev/null | tail -1 | tr -d '"'"'"'\r ')"
  printf '%s' "${v:-$2}"
}

PUERTO_AGENTE="$(leer_env HERMES_PORT 8650)"
PUERTO_WEB="$(leer_env NEXT_PUBLIC_WEB_PORT 31415)"

revisar() {  # revisar UNIDAD URL
  local unidad="$1" url="$2"
  local marca="$ESTADO/${unidad}.fallos"
  local fallos

  if ! systemctl --user is-active --quiet "$unidad"; then
    log "$unidad está '$(systemctl --user is-active "$unidad" 2>/dev/null || echo desconocida)' — levantando"
    # reset-failed antes del start: sin esto, una unidad que agotó su
    # StartLimitBurst rechaza el arranque y el vigía giraría en vacío.
    systemctl --user reset-failed "$unidad" 2>/dev/null
    if systemctl --user start "$unidad"; then
      log "$unidad arrancada"
    else
      log "$unidad NO arrancó — revisar: journalctl --user -u $unidad -n 40"
    fi
    : > "$marca"
    return
  fi

  if curl -fsS -m 8 -o /dev/null "$url" 2>/dev/null; then
    [[ -s "$marca" ]] && log "$unidad volvió a responder"
    : > "$marca"
    return
  fi

  fallos="$(cat "$marca" 2>/dev/null || echo 0)"
  fallos=$(( ${fallos:-0} + 1 ))
  printf '%s' "$fallos" > "$marca"

  if (( fallos >= 2 )); then
    log "$unidad activa pero sin responder en $url ($fallos seguidos) — reiniciando"
    systemctl --user restart "$unidad" && : > "$marca"
  else
    log "$unidad no responde en $url (1er fallo; se decide en el próximo ciclo)"
  fi
}

revisar hermes-agent.service "http://127.0.0.1:$PUERTO_AGENTE/health"
revisar hermes-web.service   "http://127.0.0.1:$PUERTO_WEB/login"
