/**
 * "Chat vinculado al reloj": UN puntero, no una tabla de N filas — Samu es el
 * único usuario, así que no hace falta emparejar dispositivos ni manejar más
 * de un vínculo a la vez. La web (o el iPhone) marca "esto es lo que sigue el
 * reloj ahora" con `vincular()`; el reloj pregunta `activo()` para saber a
 * qué turno de `/chat/turns/:id/stream` engancharse — el MISMO contrato que ya
 * usa el dashboard y la app de iPhone (agent/chat-turns.ts), no uno nuevo.
 *
 * Persiste en Supabase (tabla `watch_link`, fila única — ver migración 029)
 * además de vivir en memoria: antes SOLO vivía en memoria del proceso y un
 * reinicio del agente (deploy, crash) lo borraba en silencio sin que Samu lo
 * pidiera — el reloj se quedaba "vinculado a nada" hasta volver a tocar
 * "conectar" en la web. Ahora sobrevive a reinicios; sigue venciendo solo a
 * las 2h para no arrastrar un chat abandonado para siempre. Si Supabase no
 * está configurado, cae de vuelta al comportamiento anterior (solo memoria).
 *
 * Por qué no vive en relojTurnos/watch/turnos.ts: eso es el registro de los
 * turnos que EL RELOJ arranca por su cuenta (canal rápido, `/watch/ask`).
 * Esto es al revés — el reloj se cuelga de un turno que arrancó OTRO cliente.
 */
import { supabase } from "../supabase.js";

interface Vinculo {
  turnId: string;
  title: string;
  linkedAt: number;
}

let actual: Vinculo | null = null;
/** Se pone en true tras el primer intento de cargar desde Supabase, para no
 * repetir la carga en cada llamada a `activo()`. */
let cargado = false;

/** Vida del vínculo: pasado esto se considera obsoleto (chat abandonado, el
 * reloj nunca llegó a pedirlo). No hace falta borrarlo activo — vencer solo. */
const VIDA_MS = 2 * 60 * 60_000; // 2h: de sobra para "me acuerdo de vincularlo en el rato"

interface WatchLinkRow {
  turn_id: string | null;
  title: string | null;
  linked_at: string | null;
}

async function cargarDeSupabase(): Promise<void> {
  cargado = true;
  if (!supabase) return;
  const { data, error } = await supabase
    .from("watch_link")
    .select("turn_id, title, linked_at")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    console.error("[reloj] vínculo, carga:", error.message);
    return;
  }
  const row = data as WatchLinkRow | null;
  if (!row?.turn_id || !row.linked_at) return;
  const linkedAt = new Date(row.linked_at).getTime();
  if (Date.now() - linkedAt > VIDA_MS) return; // ya venció, no restaurar
  actual = { turnId: row.turn_id, title: row.title ?? "", linkedAt };
}

/** Best-effort: si Supabase falla, el vínculo sigue vivo en memoria igual. */
function guardarEnSupabase(v: Vinculo | null): void {
  if (!supabase) return;
  void supabase
    .from("watch_link")
    .upsert({
      id: true,
      turn_id: v?.turnId ?? null,
      title: v?.title ?? null,
      linked_at: v ? new Date(v.linkedAt).toISOString() : null,
    })
    .then(({ error }) => {
      if (error) console.error("[reloj] vínculo, guardado:", error.message);
    });
}

export function vincular(turnId: string, title: string): void {
  actual = { turnId, title: title.slice(0, 120), linkedAt: Date.now() };
  guardarEnSupabase(actual);
}

export function desvincular(): void {
  actual = null;
  guardarEnSupabase(null);
}

/** El vínculo vigente, o null si no hay o venció. */
export function activo(): Vinculo | null {
  if (!cargado && !actual) {
    // Carga perezosa y síncrona-en-los-hechos: la primera consulta tras un
    // reinicio dispara la carga pero devuelve null esa vez (no hay forma de
    // esperar aquí sin volver async toda la API existente); las siguientes
    // consultas —el reloj reintenta cada pocos segundos hasta enganchar— ya
    // la ven resuelta. Aceptable: peor caso, un reintento más del reloj.
    void cargarDeSupabase();
  }
  if (!actual) return null;
  if (Date.now() - actual.linkedAt > VIDA_MS) {
    actual = null;
    guardarEnSupabase(null);
    return null;
  }
  return actual;
}
