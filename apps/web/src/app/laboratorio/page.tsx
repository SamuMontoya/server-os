"use client";

// Laboratorio: mismo MOTOR del chat principal (turnos del servidor vía
// apps/agent/src/agent/chat-turns.ts), con el pellejo de Notion en vez del
// HUD. A propósito NO reutiliza el ChatPanel entero (tabs, historial,
// exec bar, voz en tiempo real): esto es el envío/recepción mínimo para
// empezar a vivir acá — el resto (persistencia entre recargas, reenganche
// tras bloquear pantalla, multi-tab) llega en ajustes posteriores.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ChatToolStep } from "@hermes/shared";
import { useSpeechDictation } from "@/hooks/useSpeechDictation";
import { useWorkspace } from "@/state/WorkspaceContext";
import { startTurn, attachTurn, fetchTurn } from "@/lib/chat-turns";
import { Markdown } from "@/components/Markdown";
import { AgentSteps } from "@/components/AgentSteps";
import { LabStatusBar } from "@/components/LabStatusBar";
import { uuid } from "@/lib/uuid";

type LabMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Pasos de herramientas del turno (solo en mensajes del asistente):
   *  los tool_use REALES que el SDK reportó mientras generaba esta
   *  respuesta — leer archivos, correr comandos, buscar en la memoria, etc. */
  steps?: ChatToolStep[];
};

export default function Laboratorio() {
  const { selectedProject } = useWorkspace();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<LabMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // Modelo con el que está respondiendo AHORA (lo dice el servidor por el
  // stream, y cambia si el router escala a mitad del turno). Se conserva al
  // terminar: entre mensajes sigue mostrando con qué se respondió el último,
  // que es más informativo que volver a un guion.
  const [model, setModel] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Texto que ya había en el input al arrancar el mic: el dictado se pega
  // detrás, no lo reemplaza (igual que en ChatPanel).
  const dictationBaseRef = useRef("");

  // Una sesión por visita a la página (igual que un tab nuevo del chat
  // principal). `resume` guarda la sesión del SDK una vez que el primer
  // turno la devuelve, así el segundo mensaje YA tiene el contexto del
  // primero — sin esto, cada envío sería una conversación nueva y suelta.
  const sessionKeyRef = useRef<string | null>(null);
  if (sessionKeyRef.current === null) sessionKeyRef.current = uuid();
  const sdkSessionIdRef = useRef<string | null>(null);
  const unfollowRef = useRef<(() => void) | null>(null);

  // Textarea auto-crecible (hasta ~5 líneas), igual que en ChatPanel.
  //
  // "auto" NO sirve como reset aquí: con el atributo `rows` puesto, un
  // textarea en `height:auto` sigue usando el alto intrínseco de esas filas
  // (así calcula su tamaño por defecto) — nunca se encoge por debajo de eso,
  // así que el scrollHeight medido después seguía siendo el alto "de más"
  // de rows=1. Por eso el placeholder quedaba con hueco debajo aunque ya
  // llamáramos esto al montar. Reseteando a "0px" el navegador SÍ reporta el
  // scrollHeight real del contenido (una línea), sin el piso de `rows`.
  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  // Al montar, con el draft vacío, fija el alto real de una línea en vez de
  // dejar el alto por defecto del navegador (más alto → placeholder pegado
  // arriba con hueco debajo, ver .lab-textarea en globals.css).
  useEffect(() => {
    resizeInput();
  }, []);

  // Escribe/acumula en el mensaje de respuesta por id — igual patrón que
  // `writeReply` en ChatPanel, pero sobre el array plano de esta página.
  const writeReply = (replyId: number, fn: (prev: string) => string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === replyId ? { ...m, content: fn(m.content) } : m)),
    );
  };
  const writeSteps = (replyId: number, fn: (prev: ChatToolStep[]) => ChatToolStep[]) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === replyId ? { ...m, steps: fn(m.steps ?? []) } : m)),
    );
  };

  // Engancha el stream del turno y va pintando la respuesta a medida que
  // llega. Es la versión mínima de `follow()` en ChatPanel: sin pasos de
  // herramientas ni reenganche tras perder la pestaña — eso llega después.
  const follow = (turnId: string, from: number, replyId: number) => {
    unfollowRef.current?.();
    const close = attachTurn(turnId, from, {
      onState: (st) => {
        if (st.text) writeReply(replyId, () => st.text);
        // El snapshot trae la lista COMPLETA de pasos hasta ahora (verdad del
        // servidor, no un delta): se reemplaza entero, igual que el texto.
        if (st.steps.length > 0) writeSteps(replyId, () => st.steps);
        setBusy(st.status === "running");
        // El snapshot ya trae el modelo elegido: al reengancharse a un turno
        // en curso el pie no queda en "—" esperando el próximo evento.
        if (st.model) setModel(st.model);
        if (st.sdkSessionId) sdkSessionIdRef.current ??= st.sdkSessionId;
        scrollToBottom();
      },
      onDelta: (text) => {
        writeReply(replyId, (prev) => prev + text);
        scrollToBottom();
      },
      onTool: (step) => {
        // Los pasos (tool_use reales) llegan ANTES del primer texto: son lo
        // que reemplaza al "pensando" mudo mientras el agente trabaja.
        writeSteps(replyId, (prev) => [...prev, step]);
        scrollToBottom();
      },
      onSession: (sid) => {
        sdkSessionIdRef.current ??= sid;
      },
      // El router avisa qué modelo puso a correr, y VUELVE a avisar si escala
      // (haiku→sonnet→opus) a mitad del turno: el pie lo refleja en vivo.
      onModel: (m) => setModel(m),
      onEnd: (status) => {
        unfollowRef.current = null;
        setBusy(false);
        if (status === "error") {
          void fetchTurn(turnId).then((st) => {
            const detail = st?.error ? `⚠ ${st.error}` : "⚠ el turno falló";
            writeReply(replyId, (prev) => (prev.trim() ? `${prev}\n\n${detail}` : detail));
          });
        }
        scrollToBottom();
      },
      onDisconnected: () => {
        // Se agotaron los reintentos del navegador; el turno puede seguir
        // vivo en el servidor. De momento se avisa y ya — reengancharse
        // solo al volver es uno de los "ajustes posteriores" pendientes.
        setBusy(false);
        writeReply(replyId, (prev) =>
          prev.trim() ? prev : "⚠ se perdió la conexión con Hermes.",
        );
      },
    });
    unfollowRef.current = close;
  };

  const scrollToBottom = () => {
    requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ block: "end" }));
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (listening) micStop();

    const userMsg: LabMessage = { id: Date.now(), role: "user", content: text };
    const replyMsg: LabMessage = { id: Date.now() + 1, role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, replyMsg]);
    setDraft("");
    setBusy(true);
    // El textarea no se re-mide solo al vaciar el value por JS (no dispara
    // onChange); lo hacemos a mano en el próximo frame, cuando el DOM ya
    // tiene el value nuevo.
    requestAnimationFrame(resizeInput);
    scrollToBottom();

    try {
      const turnId = await startTurn({
        message: text,
        sessionKey: sessionKeyRef.current!,
        project: selectedProject,
        resume: sdkSessionIdRef.current,
      });
      follow(turnId, 0, replyMsg.id);
    } catch (err) {
      setBusy(false);
      const detail = err instanceof Error ? err.message : "no se pudo enviar el mensaje";
      writeReply(replyMsg.id, () => `⚠ ${detail}`);
    }
  };

  // Se cierra el stream (no se cancela el turno: sigue vivo en el servidor)
  // al desmontar, para no seguir escribiendo en un componente que ya no está.
  useEffect(() => () => unfollowRef.current?.(), []);

  // Dictado por voz → texto, mismo hook que el composer del chat principal.
  // El transcript se vuelca automáticamente al draft (por eso no hace falta
  // botón de "aceptar": hablar YA escribe en el input).
  const { supported: micSupported, listening, start: micStart, stop: micStop } =
    useSpeechDictation({
      onTranscript: (text) => {
        const base = dictationBaseRef.current;
        const sep = base && !base.endsWith(" ") ? " " : "";
        setDraft(base + sep + text);
        resizeInput();
      },
    });

  const toggleMic = () => {
    if (listening) {
      micStop();
      return;
    }
    dictationBaseRef.current = draft.trimEnd();
    micStart();
    inputRef.current?.focus();
  };

  // El tema del dashboard pinta <html>/<body> casi negros. Como el papel se
  // comprime al viewport visible, cualquier hueco (teclado, rebote del scroll)
  // enseñaba ese fondo. Marcamos la ruta para que el CSS lo ponga en blanco, y
  // lo devolvemos al salir para no contaminar el resto de la app.
  useEffect(() => {
    document.documentElement.classList.add("lab-route");
    return () => document.documentElement.classList.remove("lab-route");
  }, []);

  // Fallback para navegadores que ignoran `interactive-widget=resizes-content`
  // (Safari iOS): ahí el teclado NO encoge el layout viewport, solo desplaza
  // la vista, y el papel se quedaba con el alto de pantalla completa. El
  // resultado era el hueco de abajo que solo se acomodaba scrolleando a mano.
  //
  // Publicamos dos números y el CSS hace el resto:
  //   --lab-vh     → alto REAL visible (sin teclado)  → el papel se comprime
  //   --lab-vp-top → cuánto se desplazó la vista       → el papel la persigue
  // Como la barra de input vive DENTRO del papel (margin-top:auto), ajustar
  // el papel ya la coloca: no hay dos cosas que sincronizar.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Alto de referencia SIN teclado. No sirve comparar contra
    // window.innerHeight: con `interactive-widget=resizes-content` (Chrome)
    // ese número también encoge al abrir el teclado, así que la resta daría 0
    // y nunca detectaríamos nada. Guardamos el máximo visto y solo crece.
    let baseline = vv.height;

    let frame = 0;
    const sync = () => {
      // Coalescemos en un rAF: iOS dispara decenas de resize/scroll durante la
      // animación del teclado y escribir estilos en cada uno provoca tirones.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = document.documentElement;
        root.style.setProperty("--lab-vh", `${vv.height}px`);
        root.style.setProperty("--lab-vp-top", `${vv.offsetTop}px`);
        // Teclado abierto = perdimos un trozo grande de alto visible. 140px de
        // umbral porque la barra de URL de Safari al colapsarse mueve ~60-90px
        // y eso NO es teclado: no queremos recolocar el input por scrollear.
        if (vv.height > baseline) baseline = vv.height;
        root.classList.toggle("lab-kb", baseline - vv.height > 140);
        // El documento no debe scrollear nunca en esta ruta (el CSS lo fija),
        // pero iOS a veces lo empuja igual al enfocar. Lo devolvemos a cero:
        // esto es, literalmente, el scroll manual que Samu tenía que hacer,
        // hecho por nosotros y en el momento correcto.
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };

    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      window.removeEventListener("orientationchange", sync);
      const root = document.documentElement;
      root.style.removeProperty("--lab-vh");
      root.style.removeProperty("--lab-vp-top");
      root.classList.remove("lab-kb");
    };
  }, []);

  return (
    <main className="lab-paper">
      <Link href="/" className="lab-back" title="Volver" aria-label="Volver">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M15 5 8 12l7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>

      <div className="lab-messages">
        {messages.map((m, idx) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="lab-bubble">
                {m.content}
              </div>
            );
          }
          const steps = m.steps ?? [];
          // Solo el ÚLTIMO mensaje puede estar en curso: es donde escribe el
          // turno activo (busy es global porque solo corre un turno a la vez).
          const streaming = busy && idx === messages.length - 1;
          return (
            <div key={m.id} className="lab-answer">
              {/* Pasos ANTES del texto (patrón Replit): el trabajo se ve
                  mientras ocurre, la respuesta aterriza debajo. El wrapper
                  .lab-steps repinta los acentos violeta/ámbar del HUD oscuro
                  a la paleta clara de Notion — ver globals.css. */}
              {steps.length > 0 && (
                <div className="lab-steps">
                  <AgentSteps steps={steps} busy={streaming} />
                </div>
              )}
              {m.content ? (
                <Markdown source={m.content} project={selectedProject ?? undefined} />
              ) : streaming && steps.length === 0 ? (
                // "Pensando" solo hasta el primer paso: a partir de ahí los
                // pasos ya cuentan qué está haciendo (igual que ChatPanel).
                <span className="lab-thinking" role="status" aria-label="Hermes está pensando">
                  <span />
                  <span />
                  <span />
                </span>
              ) : null}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="lab-inputbar">
        <form
          className="lab-composer"
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
        >
          {micSupported && (
            <button
              type="button"
              className={`lab-mic ${listening ? "lab-mic--listening" : ""}`}
              onClick={toggleMic}
              aria-label={listening ? "Detener dictado" : "Dictar por voz"}
              aria-pressed={listening}
              title={listening ? "Detener dictado" : "Dictar por voz"}
            >
              {listening ? (
                <span className="lab-mic-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M6 11a6 6 0 0 0 12 0M12 19v2"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              resizeInput();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Escribe algo…"
            aria-label="Entrada de texto"
            className="lab-textarea"
          />
          <button
            type="submit"
            className="lab-send"
            disabled={!draft.trim() || busy}
            aria-label="Enviar"
            title="Enviar"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 19V5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
        {/* Pie: consumo · modelo en curso · reloj de reinicio. Vive DENTRO de
            la barra (no del form) para que comparta su ancho máximo y se
            mueva con ella cuando el teclado la empuja. */}
        <LabStatusBar model={model} />
      </div>
    </main>
  );
}
