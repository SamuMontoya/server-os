"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Lectura en voz alta de las respuestas, con el mismo enfoque del lector
 * propio (~/samuel/herramientas-del-sistema/lector): el texto se parte en
 * FRASES y se encadenan con `onend`, en vez de mandar un bloque gigante.
 * Así se puede resaltar la frase que suena y Chrome no trunca los `speak`
 * largos (corta a los ~15s).
 *
 * Voz: Web Speech API, las del sistema. OJO — la calidad depende del
 * navegador: Safari expone las voces Siri (Paulina, Mónica suenan bien),
 * Chrome solo las legacy, que suenan peor con el mismo nombre.
 *
 * No hay paso de "generar audio": la síntesis es en vivo e instantánea, así
 * que aquí no hace falta el caché en IndexedDB que sí tiene el lector (allá
 * pre-renderiza documentos enteros).
 */

const KEY_ON = "hermes.autoSpeak";
const KEY_VOICE = "hermes.speakVoice";
const KEY_RATE = "hermes.speakRate";

// ── Store de módulo ───────────────────────────────────────────────────
// No es un provider porque lo leen ramas sin padre común: el toggle del
// TopBar, el selector, y la consola que dispara y resalta.

type State = {
  enabled: boolean;
  voiceURI: string;
  rate: number;
  /** Frase que suena ahora mismo, para que la consola la resalte. */
  speaking: string | null;
};

let state: State = { enabled: false, voiceURI: "", rate: 1, speaking: null };
const listeners = new Set<() => void>();

function emit() {
  state = { ...state };
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

let hydrated = false;
function getSnapshot(): State {
  if (!hydrated && typeof window !== "undefined") {
    hydrated = true;
    try {
      state = {
        ...state,
        enabled: localStorage.getItem(KEY_ON) === "1",
        voiceURI: localStorage.getItem(KEY_VOICE) ?? "",
        rate: Number(localStorage.getItem(KEY_RATE)) || 1,
      };
    } catch {
      // Modo privado: se queda con los valores por defecto.
    }
  }
  return state;
}

// El server no tiene localStorage ni `window`: siempre este objeto estable,
// o React re-renderiza en bucle. La transición ocurre tras hidratar.
const SERVER_STATE: State = { enabled: false, voiceURI: "", rate: 1, speaking: null };
function getServerSnapshot(): State {
  return SERVER_STATE;
}

function save(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Sin persistencia, pero la sesión actual sí respeta el ajuste.
  }
}

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// ── Voces ─────────────────────────────────────────────────────────────
// getVoices() llega vacío hasta que el motor carga: hay que cachear y
// reescuchar en `voiceschanged`, o la primera lectura se queda sin voz.
let voicesCache: SpeechSynthesisVoice[] = [];
function loadVoices() {
  if (!isSpeechSupported()) return;
  const v = window.speechSynthesis.getVoices();
  if (v.length) {
    voicesCache = v;
    emit(); // el selector se repuebla solo
  }
}
if (typeof window !== "undefined" && isSpeechSupported()) {
  loadVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
}

/** Voces en español, que es en lo que responde el agente. */
export function spanishVoices(): SpeechSynthesisVoice[] {
  if (!voicesCache.length) loadVoices();
  return voicesCache.filter((v) => /^es[-_]/i.test(v.lang));
}

function pickVoice(): SpeechSynthesisVoice | null {
  const es = spanishVoices();
  if (!es.length) return null;
  const want = getSnapshot().voiceURI;
  if (want) {
    const found = es.find((v) => v.voiceURI === want);
    if (found) return found;
  }
  // Default: Paulina — la pedida explícitamente. En Safari es voz Siri.
  return es.find((v) => /paulina/i.test(v.name)) ?? es[0];
}

// ── Texto hablable ────────────────────────────────────────────────────

/**
 * Markdown → texto hablable. Sin esto la voz lee "asterisco asterisco",
 * deletrea los bloques de código y nombra cada emoji.
 * Portado de normalizeForSpeech() del lector.
 */
export function toSpeakable(md: string): string {
  return (
    String(md || "")
      // El código no se lee: es ruido dictado en voz alta.
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      // Enlaces y wikilinks: sobrevive la etiqueta, no la URL.
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, " ")
      // Marcas de bloque.
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*[-–—]{3,}\s*$/gm, " ")
      // Tablas: los pipes se vuelven pausas, los separadores desaparecen.
      .replace(/^\s*\|?[\s:|-]{6,}\|?\s*$/gm, " ")
      .replace(/[ \t]*\|[ \t]*/g, ", ")
      // Énfasis.
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|\s)[*_]([^*_\n]+)[*_]/g, "$1$2")
      // Emojis y pictogramas: fuera. La voz los nombra uno por uno
      // ("emoji de fuego") y arruina la lectura.
      .replace(/\p{Extended_Pictographic}/gu, " ")
      .replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{20E3}\u{200D}]/gu, "")
      .replace(/[→←↑↓▸▾▶◀◌·•✓✗×–—]/g, " ")
      // Comillas tipográficas y repeticiones que la voz arrastra.
      .replace(/[""„]/g, '"')
      .replace(/['']/g, "'")
      .replace(/\.{3,}/g, "…")
      .replace(/([!?])\1+/g, "$1")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, ". ")
      .replace(/\s*\.\s*\./g, ".")
      .trim()
  );
}

/**
 * Corta en frases, como buildSentences() del lector: se separa tras el signo
 * de cierre y se descartan los trozos sin letras ni números (los deja el
 * código eliminado y harían una pausa fantasma).
 */
export function toSentences(md: string): string[] {
  const text = toSpeakable(md);
  if (!text) return [];
  const SEP = "";
  const marked = text.replace(/([.!?…:])(["')\]]*)(\s+)/g, `$1$2${SEP}$3`);
  const out: string[] = [];
  for (const raw of marked.split(SEP)) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (!s || !/[\p{L}\p{N}]/u.test(s)) continue;
    // Una frase kilométrica igual hay que partirla: Chrome trunca a ~15s.
    if (s.length <= 240) {
      out.push(s);
      continue;
    }
    let buf = "";
    for (const piece of s.split(/,\s*/)) {
      if ((buf + piece).length > 240 && buf) {
        out.push(buf.trim().replace(/,$/, ""));
        buf = "";
      }
      buf += piece + ", ";
    }
    if (buf.trim()) out.push(buf.trim().replace(/,$/, ""));
  }
  return out;
}

// ── Reproducción ──────────────────────────────────────────────────────
// Cola de frases encadenadas. Un token de sesión invalida la cola anterior:
// sin él, el `onend` de una frase ya cancelada seguiría avanzando la nueva.

let queue: string[] = [];
let qIndex = 0;
let token = 0;
/** Frases ya encoladas de este turno, para no repetirlas al llegar deltas. */
let consumed = 0;

function setSpeaking(s: string | null) {
  if (state.speaking === s) return;
  state.speaking = s;
  emit();
}

function step(myToken: number) {
  if (myToken !== token) return;
  if (qIndex >= queue.length) {
    setSpeaking(null);
    return;
  }
  const phrase = queue[qIndex];
  const u = new SpeechSynthesisUtterance(phrase);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? "es-MX";
  u.rate = getSnapshot().rate;

  u.onstart = () => {
    if (myToken === token) setSpeaking(phrase);
  };
  u.onend = () => {
    if (myToken !== token) return;
    qIndex++;
    step(myToken);
  };
  u.onerror = (ev) => {
    // `interrupted`/`canceled` son un stop deliberado: no se sigue. Se limpia
    // igual el resaltado, o queda una frase subrayada sin nadie leyéndola
    // (pasa si algo cancela la síntesis sin pasar por stopSpeaking).
    const r = (ev as SpeechSynthesisErrorEvent).error;
    if (r === "interrupted" || r === "canceled") {
      if (myToken === token) setSpeaking(null);
      return;
    }
    if (myToken !== token) return;
    qIndex++;
    step(myToken);
  };

  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  token++;
  queue = [];
  qIndex = 0;
  consumed = 0;
  setSpeaking(null);
  if (isSpeechSupported()) window.speechSynthesis.cancel();
}

/** Empieza un turno nuevo: descarta lo que sonara antes. */
export function beginSpeechTurn(): void {
  stopSpeaking();
}

/**
 * Encola las frases COMPLETAS que hayan aparecido en el texto acumulado y
 * todavía no se hayan dicho. Se llama en cada delta del stream: así la voz
 * arranca con la primera frase, sin esperar a que termine el turno.
 *
 * La última frase se deja fuera a propósito mientras el stream sigue vivo:
 * puede estar a medias y se leería cortada.
 */
export function feedSpeech(fullText: string, opts?: { final?: boolean }): void {
  if (!isSpeechSupported()) return;
  if (!getSnapshot().enabled) return;

  const all = toSentences(fullText);
  const upTo = opts?.final ? all.length : Math.max(0, all.length - 1);
  if (upTo <= consumed) return;

  const fresh = all.slice(consumed, upTo);
  consumed = upTo;
  const wasIdle = qIndex >= queue.length;
  queue = queue.concat(fresh);
  if (wasIdle) step(token);
}

/** Lee un texto suelto de una (para probar una voz). */
export function speakSample(text: string): void {
  if (!isSpeechSupported()) return;
  stopSpeaking();
  queue = toSentences(text);
  qIndex = 0;
  consumed = queue.length;
  step(token);
}

// ── Hooks ─────────────────────────────────────────────────────────────

const noopSubscribe = () => () => {};

export function useSpeechSettings() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // `supported` no se puede leer directo en el render: el server no tiene
  // `window` y la hidratación falla al discrepar.
  const supported = useSyncExternalStore(noopSubscribe, isSpeechSupported, () => false);

  const toggle = useCallback(() => {
    const next = !state.enabled;
    state.enabled = next;
    hydrated = true;
    save(KEY_ON, next ? "1" : "0");
    if (!next) stopSpeaking();
    emit();
  }, []);

  const setVoice = useCallback((uri: string) => {
    state.voiceURI = uri;
    save(KEY_VOICE, uri);
    emit();
  }, []);

  const setRate = useCallback((r: number) => {
    state.rate = r;
    save(KEY_RATE, String(r));
    emit();
  }, []);

  return {
    ...s,
    supported,
    toggle,
    setVoice,
    setRate,
    voices: supported ? spanishVoices() : [],
    current: supported ? pickVoice() : null,
  };
}

/** Frase que suena ahora (null si no hay nada sonando). */
export function useSpeakingPhrase(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).speaking;
}
