"use client";

/**
 * Pie del composer del Laboratorio: tres datos sueltos y muy separados, sin
 * cajas ni iconos — consumo · modelo · reloj de reinicio.
 *
 *   35%              Opus              2h 15'
 *
 * Cada uno viene de una fuente distinta y por eso el componente NO espera a
 * que estén los tres: si el usage falla, el modelo sigue vivo. Lo que todavía
 * no se sabe se deja en blanco (el modelo) o con un guion (los datos del plan,
 * que sí deberían existir siempre), nunca escondiendo la fila entera: la
 * barra reserva su alto por CSS y no salta al llegar el primer dato.
 *
 *   · consumo y reinicio → /api/claude-limits (ventana de 5 h del plan, la
 *     misma que muestra `/usage` en el CLI). Se refresca al montar, en cada
 *     interacción (prop `refreshKey`), al volver a la pestaña y cada minuto:
 *     el endpoint de Anthropic rate-limita duro pero la lib del servidor
 *     cachea 60 s, así que pedir de más sale gratis (lo sirve de memoria).
 *   · modelo → lo dice el turno en vivo (evento `model` del stream); cambia
 *     cuando el router escala haiku→sonnet→opus a mitad de la respuesta.
 *
 * REGLA DE ORO DEL PIE: una vez que un dato se supo, NO se vuelve a "—".
 * Antes cualquier tropiezo (token recién rotado, 429 del endpoint, la
 * pestaña dormida en iOS) devolvía `available:false`, el componente lo
 * pintaba como guiones y parecía que el consumo "no se muestra". Ahora el
 * último dato bueno se queda en pantalla y solo lo reemplaza otro dato bueno.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeLimits, LimitWindow } from "@/lib/claude-limits";

/** Cada cuánto se re-pide el usage. La lib del server cachea 60 s igual. */
const POLL_MS = 60_000;
/** Cada cuánto se re-pinta el reloj (el reinicio se acerca sin nuevos fetch). */
const TICK_MS = 15_000;

/**
 * "2h 15'" — h minúscula para las horas, comilla simple para los minutos.
 * Bajo la hora se cae a solo minutos ("45'"), que es cuando el número
 * empieza a importar de verdad.
 */
function formatReset(resetsAt: string | null | undefined, now: number): string {
  if (!resetsAt) return "—";
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "0'";
  // Se redondea hacia arriba: mientras quede un segundo de ese minuto, el
  // minuto todavía "falta". Con floor, un reinicio a 30 s ya diría 0'.
  const mins = Math.ceil(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}'` : `${m}'`;
}

/** Alias del router ("opus") → como se escribe de cara ("Opus"). */
const MODEL_LABELS: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
};

function formatModel(model: string | null | undefined): string {
  // Sin modelo → cadena vacía, NO un guion. Entre turnos no hay ningún modelo
  // "corriendo", y una rayita en el centro se lee como un dato roto en vez de
  // como ausencia. El hueco no se cierra: `.lab-status` reserva su alto por
  // CSS (min-height), así que la fila no salta cuando el modelo aparece.
  if (!model) return "";
  const key = model.toLowerCase();
  if (MODEL_LABELS[key]) return MODEL_LABELS[key];
  // Un id completo tipo "claude-opus-5" o un alias nuevo: se busca la familia
  // conocida dentro y si no, se muestra tal cual en vez de mentir con "—".
  for (const [alias, label] of Object.entries(MODEL_LABELS)) {
    if (key.includes(alias)) return label;
  }
  return model;
}

export function LabStatusBar({
  model,
  refreshKey = 0,
}: {
  model?: string | null;
  /**
   * Cambia en cada interacción del chat (enviar, terminar el turno). Cada
   * cambio dispara un refetch: el consumo que se lee bajo el input es el de
   * DESPUÉS de lo que se acaba de gastar, no el de hace un minuto.
   */
  refreshKey?: number;
}) {
  // Solo se guarda lo BUENO. Un fallo no borra la pantalla (ver regla de oro).
  const [session, setSession] = useState<LimitWindow | null>(null);
  const [now, setNow] = useState<number | null>(null);
  /** Evita ráfagas: varios eventos seguidos comparten un fetch por segundo. */
  const lastFetchRef = useRef(0);

  // El reloj arranca en null y se llena ya en el cliente: pintar la cuenta
  // atrás durante el SSR daría un valor distinto al de la hidratación
  // (advertencia de React) y encima nacería desfasado.
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (opts?: { force?: boolean }) => {
    const t = Date.now();
    if (!opts?.force && t - lastFetchRef.current < 1000) return;
    lastFetchRef.current = t;
    try {
      const res = await fetch("/api/claude-limits", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as ClaudeLimits;
      // `available:false` (token rotando, 429, sin red) NO pisa el último dato
      // bueno: se ignora y la fila sigue mostrando lo último que se supo.
      if (aliveRef.current && data.available && data.session) setSession(data.session);
    } catch {
      // Sin red o el agente caído: se conserva el último dato bueno.
    }
  }, []);

  // Al montar + cada minuto. El primer fetch va `force` para que abrir la
  // pantalla SIEMPRE pinte el dato cuanto antes.
  useEffect(() => {
    void load({ force: true });
    const id = setInterval(() => void load({ force: true }), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Cada interacción del chat (ver `refreshKey`).
  useEffect(() => {
    if (refreshKey > 0) void load();
  }, [refreshKey, load]);

  // Volver a la app: en iOS la pestaña dormida congela los intervalos, así que
  // al reaparecer el dato podría llevar horas parado. Se re-pide al instante.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        void load();
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [load]);

  const percent =
    session && Number.isFinite(session.utilization)
      ? `${Math.round(session.utilization)}%`
      : "—";
  const reset = now === null ? "—" : formatReset(session?.resetsAt, now);

  return (
    <div
      className="lab-status"
      role="status"
      aria-label="Estado de la sesión de Claude"
    >
      <span title="Consumo de la ventana de 5 h del plan">{percent}</span>
      <span title="Modelo respondiendo ahora">{formatModel(model)}</span>
      <span title="Tiempo hasta que se reinicien los límites">{reset}</span>
    </div>
  );
}
