"use client";

// Pasos agénticos de UN turno de la consola (patrón Replit/Relevance AI): en
// vez de un "pensando…" opaco, el hilo muestra QUÉ está haciendo el agente.
// Los pasos llegan por el frame `hermes.tool` del SSE: son los tool_use REALES
// del turno — si el agente no usa tools, no se dibuja nada.

import { useState } from "react";
import type { ChatToolStep } from "@hermes/shared";
// Verbos/glifos compartidos con el Laboratorio (ver lib/tool-labels.ts).
import { glyphOf, shortTarget, verbOf } from "@/lib/tool-labels";

/**
 * Lista de pasos de un turno. Corriendo se ven todos (son el feedback de que
 * algo pasa); terminado se pliegan a una línea para no tapar la respuesta.
 */
export function AgentSteps({ steps, busy }: { steps: ChatToolStep[]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;

  const expanded = busy || open;

  return (
    <div className="mb-1.5">
      {!busy && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1 text-2xs tracking-label text-text-dim uppercase transition-colors hover:text-violet"
        >
          <span aria-hidden>{open ? "▾" : "▸"}</span>
          {steps.length} paso{steps.length === 1 ? "" : "s"}
        </button>
      )}
      {expanded && (
        <ul className="mt-1 space-y-0.5 border-l border-line pl-2">
          {steps.map((s, i) => {
            const target = shortTarget(s.target ?? "");
            const live = busy && i === steps.length - 1;
            return (
              <li key={i} className="flex items-baseline gap-1.5 text-2xs leading-snug">
                <span aria-hidden className={live ? "text-amber" : "text-violet"}>
                  {glyphOf(s.name)}
                </span>
                <span className={`shrink-0 ${live ? "pulse-dot text-text" : "text-text-dim"}`}>
                  {verbOf(s.name)}
                </span>
                {target && (
                  <span className="min-w-0 truncate font-mono text-text-dim opacity-70">
                    {target}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
