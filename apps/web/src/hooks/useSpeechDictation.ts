"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dictado por voz (voz → texto) con la Web Speech API del navegador.
 * Gratis, on-device, sin dependencias — como el micrófono del input de
 * Claude/ChatGPT. Distinto del panel de voz en tiempo real (ElevenLabs).
 *
 * Soporte real: Chrome/Edge/Safari. Si no existe, `supported` es false y
 * el consumidor oculta el botón.
 *
 * ── Tres bugs que esta versión arregla (auditoría 2026-08-31) ──────────
 *
 * 1. EL DICTADO MORÍA AL RATO Y EL BOTÓN QUEDABA MUERTO.
 *    Chrome cierra la sesión de reconocimiento por su cuenta (~60 s, o antes
 *    si hay un silencio) AUNQUE `continuous = true`: dispara `onend` y se
 *    acabó. La versión vieja solo hacía `setListening(false)`, así que el
 *    dictado se apagaba solo a mitad de una frase. Y al volver a pulsar el
 *    botón, `rec.start()` lanzaba `InvalidStateError` porque la instancia
 *    anterior no había terminado de morir — con un `catch {}` vacío que se
 *    comía el error en silencio y dejaba `listening` en false para siempre.
 *    Ahora hay una intención explícita (`wantRef`): mientras el usuario NO
 *    haya pulsado stop, `onend` REARRANCA una instancia nueva. El texto ya
 *    dictado vive en `finalRef`, fuera de la instancia, así que el reinicio
 *    es invisible: se sigue dictando la misma frase.
 *
 * 2. LA PESTAÑA SE PONÍA EN BLANCO EN DICTADOS LARGOS.
 *    `onresult` recorría `e.results` DESDE CERO en cada evento y
 *    reconcatenaba todo el transcript. Con `interimResults` eso son varios
 *    eventos por segundo, cada uno reconstruyendo una cadena cada vez más
 *    larga: coste cuadrático, más un `setState` + un reflow sincrónico del
 *    textarea por evento. En un dictado largo la pestaña se quedaba sin aire
 *    y moría (pantalla blanca). Ahora se procesa solo el tramo nuevo
 *    (`e.resultIndex` en adelante) y los tramos ya definitivos se acumulan
 *    UNA vez en `finalRef` — coste lineal. Además el aviso al consumidor va
 *    coalescido a un `requestAnimationFrame`, así que por muchos eventos que
 *    llegue Chrome nunca hay más de un render por frame.
 *
 * 3. NO SE SABÍA POR QUÉ SE HABÍA PARADO.
 *    Se distinguen los errores recuperables (`no-speech`, `network`,
 *    `aborted`: rearranca) de los fatales (`not-allowed`,
 *    `service-not-allowed`, `audio-capture`: para y explica en castellano).
 *
 * NOTA SOBRE LA PUNTUACIÓN: este motor apenas puntúa en español — es un
 * límite del reconocedor de Chrome, no de este código. Para puntuación de
 * verdad el texto final se re-transcribe en el servidor (Scribe/Whisper);
 * ver `useVoiceDictation.ts`, que usa este hook solo como vista previa.
 */

// ── Tipos mínimos de la Web Speech API (no siempre están en lib.dom) ──
interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  0: SpeechAlternative;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  /** Índice del PRIMER resultado que cambió en este evento. Lo anterior ya
   *  se procesó en eventos previos: la clave para no recorrerlo todo. */
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Errores que NO tienen arreglo reintentando: hay que parar y avisar. */
const FATAL: Record<string, string> = {
  "not-allowed": "Bloqueaste el micrófono para este sitio. Habilítalo en el candado de la barra de direcciones.",
  "service-not-allowed": "El navegador no permite el reconocimiento de voz aquí.",
  "audio-capture": "No se encontró micrófono.",
};

/** Techo del transcript de UNA sesión de dictado. Un dictado real no pasa de
 *  unos miles de caracteres; el tope existe para que un micrófono abierto y
 *  olvidado no crezca sin fin. */
const MAX_CHARS = 20_000;

/** Espera antes de rearrancar tras un `onend`. Chrome necesita un tick para
 *  soltar el dispositivo; sin esto el `start()` vuelve a tirar
 *  InvalidStateError. */
const RESTART_DELAY_MS = 250;

export function useSpeechDictation({
  lang = "es-MX",
  onTranscript,
}: {
  lang?: string;
  /** Texto acumulado hasta ahora (final + interino) e indicador de si el
   *  último fragmento es definitivo. */
  onTranscript: (text: string, isFinal: boolean) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cbRef = useRef(onTranscript);
  useEffect(() => {
    cbRef.current = onTranscript;
  });

  /** ¿El usuario quiere seguir dictando? Sobrevive a los cortes de Chrome:
   *  es lo que distingue "Chrome me cortó, rearranca" de "el usuario pulsó
   *  stop, no rearranques". */
  const wantRef = useRef(false);
  /** Tramos DEFINITIVOS acumulados de toda la sesión de dictado, a través de
   *  cuantos reinicios haga falta. Vive fuera de la instancia a propósito. */
  const finalRef = useRef("");
  /** Cuántos resultados de la instancia ACTUAL ya se contaron como finales.
   *  Impide contar dos veces si Chrome reemite un resultado ya definitivo. */
  const doneRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** rAF pendiente para avisar al consumidor (coalescencia de renders). */
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<{ text: string; isFinal: boolean } | null>(null);
  const startRef = useRef<() => void>(() => {});

  /** Avisa al consumidor como máximo UNA vez por frame. Chrome puede emitir
   *  interinos muy seguidos; sin esto cada uno provocaba render + reflow. */
  const emit = useCallback((text: string, isFinal: boolean) => {
    pendingRef.current = { text, isFinal };
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const p = pendingRef.current;
      pendingRef.current = null;
      if (p) cbRef.current(p.text, p.isFinal);
    });
  }, []);

  /** Suelta una instancia sin que sus callbacks disparen efectos (en especial
   *  el rearranque de `onend`). */
  const detach = useCallback((rec: SpeechRecognitionLike | null) => {
    if (!rec) return;
    rec.onresult = rec.onend = rec.onerror = null;
    try {
      rec.abort();
    } catch {
      /* ya estaba muerta */
    }
  }, []);

  const clearRestart = useCallback(() => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    // Primero se baja la intención: si `stop()` provoca un `onend`, el
    // handler ya sabe que NO debe rearrancar.
    wantRef.current = false;
    clearRestart();
    setListening(false);
    const rec = recRef.current;
    recRef.current = null;
    detach(rec);
  }, [clearRestart, detach]);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setError("Tu navegador no soporta dictado por voz.");
      return;
    }
    clearRestart();
    // Sesión nueva desde el botón: el transcript arranca limpio.
    finalRef.current = "";
    wantRef.current = true;
    setError(null);
    startRef.current();
  }, [clearRestart]);

  /** Arranca UNA instancia. Se usa tanto para el arranque del usuario como
   *  para los rearranques automáticos, que NO tocan `finalRef`. */
  const startInstance = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor || !wantRef.current) return;

    detach(recRef.current);
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    // Cada instancia empieza su propia numeración de resultados.
    doneRef.current = 0;

    rec.onresult = (e) => {
      let interim = "";
      // Solo el tramo NUEVO. `doneRef` protege de reprocesar un final ya
      // contado si Chrome reemite por debajo de `resultIndex`.
      const from = Math.max(e.resultIndex, doneRef.current);
      for (let i = from; i < e.results.length; i++) {
        const res = e.results[i];
        const chunk = res?.[0]?.transcript ?? "";
        if (res?.isFinal) {
          const prev = finalRef.current;
          const sep = prev && !prev.endsWith(" ") ? " " : "";
          finalRef.current = (prev + sep + chunk.trim()).slice(0, MAX_CHARS);
          doneRef.current = i + 1;
        } else {
          interim += chunk;
        }
      }
      const base = finalRef.current;
      const sep = base && interim && !base.endsWith(" ") ? " " : "";
      emit((base + sep + interim).trim().slice(0, MAX_CHARS), interim === "");
      // Tope alcanzado: se para en vez de seguir tragando audio que se tira.
      if (finalRef.current.length >= MAX_CHARS) stop();
    };

    rec.onerror = (e) => {
      const fatal = FATAL[e.error];
      if (fatal) {
        setError(fatal);
        stop(); // baja `wantRef`: el `onend` que viene NO rearrancará
        return;
      }
      // `no-speech` / `network` / `aborted` son parte de la vida normal de
      // un dictado largo: no se muestran. El `onend` que sigue rearranca.
    };

    rec.onend = () => {
      if (recRef.current !== rec) return; // instancia vieja: se ignora
      if (!wantRef.current) {
        setListening(false);
        return;
      }
      // Chrome nos cortó a mitad del dictado → sesión nueva, mismo texto.
      clearRestart();
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        startInstance();
      }, RESTART_DELAY_MS);
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // InvalidStateError: la instancia anterior todavía está soltando el
      // micrófono. NO se silencia como antes (eso dejaba el botón muerto):
      // se reintenta, y el estado sigue reflejando la intención real.
      recRef.current = null;
      detach(rec);
      clearRestart();
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        startInstance();
      }, RESTART_DELAY_MS * 2);
      setListening(true); // el usuario quiere dictar; estamos reintentando
    }
  }, [clearRestart, detach, emit, lang, stop]);

  // `start` y `startInstance` se necesitan mutuamente; el ref rompe el ciclo.
  useEffect(() => {
    startRef.current = startInstance;
  }, [startInstance]);

  // Limpieza al desmontar: sin esto un rearranque programado podía disparar
  // sobre un componente que ya no existe.
  useEffect(() => {
    setSupported(getCtor() !== null);
    return () => {
      wantRef.current = false;
      if (restartTimerRef.current !== null) clearTimeout(restartTimerRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        rec.onresult = rec.onend = rec.onerror = null;
        try {
          rec.abort();
        } catch {
          /* ya estaba muerta */
        }
      }
    };
  }, []);

  return { supported, listening, error, start, stop };
}
