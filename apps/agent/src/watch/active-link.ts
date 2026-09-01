/**
 * "Chat vinculado al reloj": UN puntero en memoria, no una tabla — Samu es el
 * único usuario, así que no hace falta emparejar dispositivos ni manejar más
 * de un vínculo a la vez. La web (o el iPhone) marca "esto es lo que sigue el
 * reloj ahora" con `vincular()`; el reloj pregunta `activo()` para saber a
 * qué turno de `/chat/turns/:id/stream` engancharse — el MISMO contrato que ya
 * usa el dashboard y la app de iPhone (agent/chat-turns.ts), no uno nuevo.
 *
 * Por qué no vive en relojTurnos/watch/turnos.ts: eso es el registro de los
 * turnos que EL RELOJ arranca por su cuenta (canal rápido, `/watch/ask`).
 * Esto es al revés — el reloj se cuelga de un turno que arrancó OTRO cliente.
 */

interface Vinculo {
  turnId: string;
  title: string;
  linkedAt: number;
}

let actual: Vinculo | null = null;

/** Vida del vínculo: pasado esto se considera obsoleto (chat abandonado, el
 * reloj nunca llegó a pedirlo). No hace falta borrarlo activo — vencer solo. */
const VIDA_MS = 2 * 60 * 60_000; // 2h: de sobra para "me acuerdo de vincularlo en el rato"

export function vincular(turnId: string, title: string): void {
  actual = { turnId, title: title.slice(0, 120), linkedAt: Date.now() };
}

export function desvincular(): void {
  actual = null;
}

/** El vínculo vigente, o null si no hay o venció. */
export function activo(): Vinculo | null {
  if (!actual) return null;
  if (Date.now() - actual.linkedAt > VIDA_MS) {
    actual = null;
    return null;
  }
  return actual;
}
