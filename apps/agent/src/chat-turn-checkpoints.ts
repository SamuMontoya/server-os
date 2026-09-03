/**
 * Checkpoint de turnos de chat en vuelo + reconciliación al arrancar.
 *
 * Ver el comentario de la migración 026_chat_turn_checkpoints.sql para el
 * problema completo: el motor de turnos (agent/chat-turns.ts) vive solo en
 * memoria, así que un reinicio del agente a mitad de una respuesta perdía
 * el texto ya generado sin dejar rastro. Este módulo es el lado de
 * persistencia — `chat-turns.ts` lo invoca vía sus `deps` inyectables
 * (`checkpoint`/`clearCheckpoint`), igual que ya hace con `persist`.
 */
import { supabase } from "./supabase.js";
import { appendTurn } from "./conversations.js";
import type { ChatTurn } from "./agent/chat-turns.js";

interface CheckpointRow {
  id: string;
  session_key: string;
  project: string;
  prompt: string;
  text: string;
  sdk_session_id: string | null;
  attempts: number;
  updated_at: string;
}

/** Best-effort: un checkpoint que falla no debe tumbar el turno. */
export function checkpointTurn(turn: ChatTurn, machineName: string): void {
  if (!supabase) return;
  void supabase
    .from("chat_turn_checkpoints")
    .upsert({
      id: turn.id,
      session_key: turn.sessionKey,
      project: turn.project,
      prompt: turn.prompt,
      text: turn.text,
      sdk_session_id: turn.sdkSessionId ?? null,
      attempts: turn.attempts,
      machine: machineName,
      updated_at: new Date().toISOString(),
    })
    .then(({ error }) => {
      if (error) console.error("[chat-checkpoint] upsert:", error.message);
    });
}

export function clearCheckpoint(id: string): void {
  if (!supabase) return;
  void supabase
    .from("chat_turn_checkpoints")
    .delete()
    .eq("id", id)
    .then(({ error }) => {
      if (error) console.error("[chat-checkpoint] delete:", error.message);
    });
}

/**
 * Al arrancar: cualquier fila que quedó en esta tabla es un turno que
 * estaba `running` cuando el proceso ANTERIOR murió (deploy, OOM) — porque
 * `clearCheckpoint` solo corre cuando un turno cierra normalmente. Se
 * persiste lo que se alcanzó a escribir como respuesta parcial (con una nota
 * explícita de que se interrumpió, para que el hilo no mienta diciendo que
 * esa fue la respuesta completa) y se limpia la fila.
 *
 * Mismo patrón que `reconcileRunningTasks()` en tasks/store.ts para el
 * tracker — este es el equivalente para el chat, que nunca lo tuvo.
 */
export async function reconcileChatTurns(): Promise<number> {
  if (!supabase) return 0;
  const { data, error } = await supabase.from("chat_turn_checkpoints").select("*");
  if (error) {
    console.error("[chat-checkpoint] reconcile select:", error.message);
    return 0;
  }
  const rows = (data ?? []) as CheckpointRow[];
  if (!rows.length) return 0;

  for (const row of rows) {
    const texto = row.text.trim();
    if (texto) {
      const nota =
        `${row.text}\n\n⚠ _Se interrumpió aquí: el agente se reinició a mitad de esta respuesta._`;
      await appendTurn(row.project, row.prompt, nota, row.session_key).catch((err) =>
        console.error("[chat-checkpoint] reconcile appendTurn:", err),
      );
    }
    // Aunque no haya texto (murió antes de escribir nada), la sesión del SDK
    // ya se conocía si el checkpoint llegó a esa etapa — vale la pena que el
    // próximo mensaje del tab retome esa conversación en vez de abrir una
    // nueva, aunque esta respuesta puntual se haya perdido del todo.
    if (row.sdk_session_id) {
      const { saveSdkSession } = await import("./agent/session.js");
      await saveSdkSession(row.session_key, row.sdk_session_id, "text").catch(() => {});
    }
  }

  const ids = rows.map((r) => r.id);
  await supabase.from("chat_turn_checkpoints").delete().in("id", ids);
  return rows.length;
}
