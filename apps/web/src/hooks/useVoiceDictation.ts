"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechDictation } from "./useSpeechDictation";
import { transcribeDictation } from "@/lib/hermes";

/**
 * Dictado del composer, en dos capas.
 *
 * EL PROBLEMA: la Web Speech API del navegador (`useSpeechDictation`) da
 * texto en vivo y gratis, pero en español casi no pone comas ni puntos —
 * es un límite del reconocedor de Chrome, no hay parche del lado del cliente.
 * A la vez, Scribe/Whisper del servidor SÍ puntúan bien, pero necesitan el
 * clip completo: no hay texto hasta que sueltas el micrófono.
 *
 * LA SOLUCIÓN: usar las dos a la vez.
 *  - Mientras hablas, se graba con MediaRecorder Y se pinta el texto de la
 *    Web Speech API como VISTA PREVIA (siempre `isFinal: false`), para que el
 *    input no se quede mudo.
 *  - Al soltar el botón, el clip grabado se manda a `/dictado/transcribir` y
 *    el texto que vuelve —con puntuación de verdad— REEMPLAZA la vista
 *    previa (`isFinal: true`).
 *
 * Si el servidor falla o no hay credenciales de STT, se conserva la vista
 * previa: se pierde la puntuación, nunca el dictado.
 *
 * El `MediaStream` se PARA al soltar el botón (ver `stop()`). Antes se
 * mantenía vivo entre dictados para no volver a pedir permiso — pero el
 * permiso, una vez concedido, no se vuelve a preguntar (Chrome/Safari lo
 * recuerdan por origen); lo único que lograba dejarlo abierto era que el
 * indicador de grabación del navegador quedara encendido para siempre,
 * porque este componente vive dentro de `ChatPanel`/`Laboratorio`, que el
 * `AppShell` nunca desmonta mientras se navega por el workspace.
 */

/** Tope de un dictado. Sin esto un micrófono olvidado abierto genera un blob
 *  enorme y una factura de STT sorpresa. Al llegar aquí se para solo (el
 *  texto NO se pierde: se transcribe lo grabado hasta ese momento). */
const MAX_CLIP_MS = 5 * 60 * 1000;

/** Clip por debajo de esto = toque accidental del botón, no se sube. */
const MIN_CLIP_BYTES = 1024;

function mediaSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Primer contenedor que este navegador sepa grabar. Safari solo hace mp4;
 *  Chrome/Firefox prefieren webm/opus. `undefined` = que elija el navegador. */
function pickMime(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported?.(m));
}

export function useVoiceDictation({
  lang = "es-MX",
  onTranscript,
}: {
  lang?: string;
  /** `isFinal: false` = vista previa del navegador (puede cambiar).
   *  `isFinal: true` = texto definitivo del servidor, ya con puntuación. */
  onTranscript: (text: string, isFinal: boolean) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** Último texto que pintó la vista previa: el respaldo si el servidor falla. */
  const previewRef = useRef("");
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cbRef = useRef(onTranscript);
  useEffect(() => {
    cbRef.current = onTranscript;
  });

  // Capa 1: texto en vivo. Siempre como NO definitivo — lo definitivo solo
  // puede venir del servidor.
  const live = useSpeechDictation({
    lang,
    onTranscript: (text) => {
      previewRef.current = text;
      cbRef.current(text, false);
    },
  });

  /** Pide el micrófono para ESTE dictado. El permiso del navegador ya está
   *  concedido de una vez anterior (si la hubo), así que esto no vuelve a
   *  mostrar el diálogo — solo abre el stream, que `stop()` cierra al soltar
   *  el botón. */
  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;
    return stream;
  }, []);

  const clearCap = useCallback(() => {
    if (capTimerRef.current !== null) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  }, []);

  /** Sube el clip y reemplaza la vista previa por el texto puntuado. */
  const finish = useCallback(async (mime: string) => {
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const blob = new Blob(chunks, { type: mime });
    // Clip vacío o ridículamente corto: se deja lo que hubiera y no se gasta
    // una llamada de STT.
    if (blob.size < MIN_CLIP_BYTES) return;

    setTranscribing(true);
    try {
      const result = await transcribeDictation(blob);
      // `null` = el servidor lo consideró silencio. La vista previa manda.
      if (result?.text) cbRef.current(result.text, true);
    } catch (err) {
      // Degradación deliberada: la vista previa YA está en el input, así que
      // el usuario conserva su dictado (sin puntuación fina).
      console.error("[dictado] no se pudo re-transcribir:", err);
      if (previewRef.current) {
        // Silencioso a propósito: el dictado ya quedó escrito y a Samu no le
        // importa perder la puntuación fina; avisarlo solo era ruido.
        cbRef.current(previewRef.current, true);
      } else {
        setError(err instanceof Error ? err.message : "No se pudo transcribir el dictado.");
      }
    } finally {
      setTranscribing(false);
    }
  }, []);

  const stop = useCallback(() => {
    clearCap();
    live.stop();
    setRecording(false);
    const rec = recorderRef.current;
    recorderRef.current = null;
    // `stop()` dispara `onstop`, que es donde se sube el clip.
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* ya estaba parado */
      }
    }
  }, [clearCap, live]);

  const start = useCallback(async () => {
    setError(null);
    previewRef.current = "";

    // Sin MediaRecorder no hay capa de servidor: se cae a solo Web Speech
    // (peor puntuación, pero el botón sigue sirviendo).
    if (!mediaSupported()) {
      live.start();
      setRecording(true);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await ensureStream();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setError(
        name === "NotAllowedError"
          ? "Bloqueaste el micrófono para este sitio. Habilítalo en el candado de la barra de direcciones."
          : name === "NotFoundError"
            ? "No se encontró micrófono."
            : "No se pudo abrir el micrófono.",
      );
      return;
    }

    const mime = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      // Contenedor rechazado: se deja elegir al navegador.
      rec = new MediaRecorder(stream);
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      // Soltar el stream AQUÍ, no en `stop()`: por spec, `ondataavailable`
      // con el último chunk ya se disparó antes de `onstop`, así que el clip
      // completo está en `chunksRef` y parar las pistas ahora no pierde nada.
      // Es el fix del "micrófono queda activo todo el tiempo": antes el
      // stream sobrevivía a propósito entre dictados, y como este componente
      // nunca se desmonta (vive dentro de ChatPanel/Laboratorio, que el
      // AppShell mantiene montados todo el tiempo) el indicador de grabación
      // del navegador se quedaba encendido para siempre tras el primer uso.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void finish(rec.mimeType || mime || "audio/webm");
    };
    recorderRef.current = rec;
    // Timeslice de 1 s: si la pestaña se va a segundo plano o el recorder
    // muere, lo grabado hasta ese punto ya está en `chunks` y se salva.
    rec.start(1000);

    live.start();
    setRecording(true);

    clearCap();
    capTimerRef.current = setTimeout(() => {
      capTimerRef.current = null;
      setError("Se alcanzó el máximo de 5 minutos por dictado; se transcribió lo grabado.");
      stop();
    }, MAX_CLIP_MS);
  }, [clearCap, ensureStream, finish, live, stop]);

  // Al desmontar: soltar el micrófono de verdad (si no, el indicador de
  // grabación del navegador se queda encendido) y cancelar el tope.
  useEffect(() => {
    return () => {
      if (capTimerRef.current !== null) clearTimeout(capTimerRef.current);
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (rec) {
        rec.ondataavailable = null;
        rec.onstop = null;
        if (rec.state !== "inactive") {
          try {
            rec.stop();
          } catch {
            /* ya estaba parado */
          }
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return {
    /** Basta con UNA de las dos capas para que el botón tenga sentido. */
    supported: mediaSupported() || live.supported,
    /** El micrófono está abierto y se está grabando. */
    listening: recording,
    /** Clip subido, esperando el texto puntuado del servidor. */
    transcribing,
    error: error ?? live.error,
    start,
    stop,
  };
}
