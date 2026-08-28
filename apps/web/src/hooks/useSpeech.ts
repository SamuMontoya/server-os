"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Lectura en voz alta de las respuestas (texto → voz) con la Web Speech API
 * del navegador — las MISMAS voces del sistema que usa `say` en la terminal.
 * Gratis, on-device, sin API key. Es el espejo de useSpeechDictation.
 *
 * Provisional a propósito: cuando ElevenLabs esté configurado, la voz buena
 * sale por ahí y esto queda como respaldo.
 *
 * El interruptor vive en un store de módulo (no en un provider) porque lo
 * leen dos ramas del árbol que no comparten padre: el toggle del TopBar y la
 * consola que dispara la lectura.
 */

const KEY = "hermes.autoSpeak";

let enabled = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// El estado real vive en localStorage: sobrevive recargas y cambios de vista.
function readStored(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Modo privado o cookies bloqueadas: se degrada a apagado, no revienta.
    return false;
  }
}

let hydrated = false;
function getSnapshot(): boolean {
  if (!hydrated && typeof window !== "undefined") {
    enabled = readStored();
    hydrated = true;
  }
  return enabled;
}

// El server no tiene localStorage: siempre apagado, y el cliente rehidrata.
function getServerSnapshot(): boolean {
  return false;
}

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function setAutoSpeak(next: boolean): void {
  enabled = next;
  hydrated = true;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // Sin persistencia, pero la sesión actual sí respeta el interruptor.
  }
  if (!next) stopSpeaking();
  emit();
}

// El soporte NO se puede leer directo en el render: en el server no hay
// `window`, así que el primer render del cliente diría `true` donde el HTML
// del server dijo `false` → error de hidratación. useSyncExternalStore con
// snapshot de server explícito hace la transición en un commit aparte.
const noopSubscribe = () => () => {};

/** Interruptor de "leer siempre las respuestas". */
export function useAutoSpeak(): { enabled: boolean; supported: boolean; toggle: () => void } {
  const on = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const supported = useSyncExternalStore(noopSubscribe, isSpeechSupported, getServerSnapshot);
  const toggle = useCallback(() => setAutoSpeak(!enabled), []);
  return { enabled: on, supported, toggle };
}

/**
 * Markdown → texto hablable. Sin esto la voz lee "asterisco asterisco" y
 * deletrea los bloques de código.
 */
export function toSpeakable(md: string): string {
  return (
    md
      // Los bloques de código no se leen: son ruido dictados en voz alta.
      .replace(/```[\s\S]*?```/g, ". ")
      .replace(/`([^`]+)`/g, "$1")
      // Enlaces y wikilinks: sobrevive la etiqueta, no la URL.
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Marcas de énfasis, títulos, citas, viñetas y separadores.
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|\s)[*_]([^*_\n]+)[*_]/g, "$1$2")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*[-–—]{3,}\s*$/gm, "")
      // Emojis y símbolos sueltos que la voz deletrea.
      .replace(/[⚡✅❌⚠️→▸▾▶◌·•]/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, ". ")
      // El paso anterior deja ".." donde el párrafo ya cerraba con punto.
      .replace(/\s*\.\s*\./g, ".")
      .trim()
  );
}

/** Corta el texto en frases: Chrome trunca los `speak` largos (~15s). */
function chunk(text: string): string[] {
  const parts: string[] = [];
  for (const raw of text.split(/(?<=[.!?…:])\s+|\n+/)) {
    const s = raw.trim();
    // Fragmentos que son solo puntuación (los deja el bloque de código
    // eliminado) no se mandan a hablar: la voz haría una pausa fantasma.
    if (!s || !/[\p{L}\p{N}]/u.test(s)) continue;
    // Una frase kilométrica igual hay que partirla: se corta por comas.
    if (s.length <= 220) {
      parts.push(s);
      continue;
    }
    let buf = "";
    for (const piece of s.split(/,\s*/)) {
      if ((buf + piece).length > 220 && buf) {
        parts.push(buf.trim());
        buf = "";
      }
      buf += piece + ", ";
    }
    if (buf.trim()) parts.push(buf.trim().replace(/,$/, ""));
  }
  return parts;
}

// getVoices() llega vacío hasta que el motor termina de cargar: hay que
// pedirlo una vez y volver a leerlo en `voiceschanged`, o la primera lectura
// se queda sin voz elegida.
let voicesCache: SpeechSynthesisVoice[] = [];
function warmVoices() {
  if (!isSpeechSupported()) return;
  const load = () => {
    voicesCache = window.speechSynthesis.getVoices();
  };
  load();
  window.speechSynthesis.addEventListener?.("voiceschanged", load);
}
if (typeof window !== "undefined") warmVoices();

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) voicesCache = voices;
  if (!voicesCache.length) return null;
  // Preferencia: español (el agente responde en español), luego lo que haya.
  // Si no hay ninguna en español se devuelve null y el navegador elige con
  // el `lang` de la utterance.
  return (
    voicesCache.find((v) => /^es[-_]/i.test(v.lang) && v.localService) ??
    voicesCache.find((v) => /^es[-_]/i.test(v.lang)) ??
    null
  );
}

export function stopSpeaking(): void {
  if (!isSpeechSupported()) return;
  window.speechSynthesis.cancel();
}

/** Lee el texto en voz alta. No hace nada si el interruptor está apagado. */
export function speak(markdown: string, opts?: { force?: boolean }): void {
  if (!isSpeechSupported()) return;
  if (!opts?.force && !getSnapshot()) return;

  const text = toSpeakable(markdown);
  if (!text) return;

  // Un turno nuevo pisa al anterior: nadie quiere oír dos respuestas a la vez.
  window.speechSynthesis.cancel();

  const voice = pickVoice();
  for (const part of chunk(text)) {
    const u = new SpeechSynthesisUtterance(part);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? "es-ES";
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  }
}
