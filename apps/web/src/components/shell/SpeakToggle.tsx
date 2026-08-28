"use client";

// Chip del header: lee o no las respuestas en voz alta. Mismo contrato visual
// que GestureChip — un estado que cambia lo que sale por los parlantes no debe
// ser invisible. Click → alterna; la preferencia sobrevive recargas.
//
// La voz es la del sistema (Web Speech API), la misma que usa `say` en la
// terminal. Provisional hasta que ElevenLabs esté configurado.

import { useAutoSpeak } from "@/hooks/useSpeech";

export function SpeakToggle() {
  const { enabled, supported, toggle } = useAutoSpeak();

  // Sin Web Speech API no hay nada que ofrecer (mismo criterio que el dictado).
  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      title={
        enabled
          ? "Dejar de leer las respuestas en voz alta"
          : "Leer siempre las respuestas en voz alta (voz del sistema)"
      }
      className={`flex items-center gap-1.5 rounded-sm border px-2 py-1 text-2xs tracking-label uppercase ${
        enabled
          ? "border-violet/60 bg-violet/10 text-violet-hot"
          : "border-line bg-transparent text-text-faint hover:text-text-dim"
      }`}
    >
      <span aria-hidden="true">{enabled ? "🔊" : "🔇"}</span>
      <span>Leer {enabled ? "on" : "off"}</span>
    </button>
  );
}
