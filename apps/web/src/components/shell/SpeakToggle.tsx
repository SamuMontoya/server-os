"use client";

// Control de lectura en voz alta en el TopBar: el switch del design system
// (mismo que "activo/inactivo" del resto de la app) + selector de voz.
//
// El selector existe porque la calidad depende del navegador: Safari expone
// las voces Siri (Paulina, Mónica suenan bien) y Chrome solo las legacy, con
// el mismo nombre y peor timbre. Sin poder elegir, no hay forma de arreglarlo
// desde el código.

import { useState } from "react";
import { Toggle } from "@/components/ui/Toggle";
import { useSpeechSettings, speakSample, stopSpeaking } from "@/hooks/useSpeech";
import { OWNER } from "@/lib/owner";

const MUESTRA = `Hola${OWNER ? ` ${OWNER}` : ""}, así sueno leyendo tus respuestas.`;

export function SpeakToggle() {
  const { enabled, supported, toggle, voices, current, setVoice, rate, setRate } =
    useSpeechSettings();
  const [open, setOpen] = useState(false);

  // Sin Web Speech API no hay nada que ofrecer (igual que el dictado).
  if (!supported) return null;

  return (
    <div className="relative flex items-center gap-2">
      <Toggle checked={enabled} onChange={toggle} label="Leer" size="sm" />

      {/* Los ajustes solo aparecen si está encendido: apagado son ruido. */}
      {enabled && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="Elegir la voz y la velocidad"
          className="max-w-32 truncate text-2xs tracking-label text-text-faint uppercase hover:text-text-dim"
        >
          {current?.name ?? "sin voz"} ▾
        </button>
      )}

      {open && enabled && (
        <div className="absolute top-8 left-0 z-50 w-64 rounded-sm border border-line bg-panel-2 p-3 elev-2">
          <p className="mb-2 text-2xs tracking-label text-text-faint uppercase">Voz</p>
          <div className="max-h-52 overflow-y-auto">
            {voices.length === 0 && (
              <p className="text-2xs text-text-dim">
                Este navegador no reporta voces en español.
              </p>
            )}
            {voices.map((v) => (
              <button
                key={v.voiceURI}
                type="button"
                onClick={() => {
                  setVoice(v.voiceURI);
                  // Se oye al elegirla: es la única forma de comparar.
                  speakSample(MUESTRA);
                }}
                className={`block w-full truncate px-1 py-1 text-left text-2xs ${
                  current?.voiceURI === v.voiceURI
                    ? "text-violet-hot"
                    : "text-text-dim hover:text-text"
                }`}
              >
                {current?.voiceURI === v.voiceURI ? "▸ " : "  "}
                {v.name} · {v.lang}
              </button>
            ))}
          </div>

          <p className="mt-3 mb-1 text-2xs tracking-label text-text-faint uppercase">
            Velocidad · {rate.toFixed(2)}×
          </p>
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="w-full accent-violet"
          />

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => speakSample(MUESTRA)}
              className="text-2xs tracking-label text-violet uppercase hover:text-violet-hot"
            >
              Probar
            </button>
            <button
              type="button"
              onClick={stopSpeaking}
              className="text-2xs tracking-label text-text-faint uppercase hover:text-text-dim"
            >
              Parar
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto text-2xs tracking-label text-text-faint uppercase hover:text-text-dim"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
