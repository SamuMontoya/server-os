"use client";

/**
 * Pasos agénticos del Laboratorio — UN bloque de acciones seguidas.
 *
 * Se separa de <AgentSteps/> (el del HUD oscuro) porque la regla de qué se ve
 * es distinta, no solo el color:
 *
 *   AgentSteps  → corriendo muestra TODOS los pasos, uno bajo otro. La lista
 *                 crece sin techo y empuja la respuesta fuera de pantalla.
 *   LabSteps    → corriendo muestra SOLO el paso en curso, en una línea que se
 *                 reemplaza sola ("Leyendo page.tsx" → "Ejecutando pnpm…").
 *                 Al terminar el bloque, se pliega a "N pasos".
 *
 * En ambos estados el encabezado es un botón: se puede desplegar la lista
 * completa en cualquier momento, incluso a mitad del turno.
 *
 * "El bloque" importa: un turno puede tener varios (acciones → texto →
 * acciones → texto). Cada bloque es una instancia de este componente y se
 * pliega cuando el agente pasa a escribir — ver LabBlock en laboratorio/page.tsx.
 */

import { useState } from "react";
import type { ChatToolStep } from "@hermes/shared";
import { glyphOf, shortTarget, verbOf } from "@/lib/tool-labels";

function StepRow({ step, live }: { step: ChatToolStep; live: boolean }) {
  const target = shortTarget(step.target ?? "");
  return (
    <>
      <span className="lab-step-glyph" aria-hidden>
        {glyphOf(step.name)}
      </span>
      <span className="lab-step-verb">{verbOf(step.name, live)}</span>
      {target && <span className="lab-step-target">{target}</span>}
    </>
  );
}

export function LabSteps({ steps, live }: { steps: ChatToolStep[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  const current = steps[steps.length - 1];
  const label = `${steps.length} paso${steps.length === 1 ? "" : "s"}`;
  const toggle = () => setOpen((o) => !o);

  // TODO el bloque es la zona de click (encabezado Y lista desplegada), no
  // solo un caret de 9px: el objetivo táctil de un triángulo es imposible de
  // acertar en móvil. Por eso esto es un <div role="button"> y no un <button>
  // real — dentro va la <ul>, y un <button> no puede contener listas ni otros
  // controles sin romper el HTML. A cambio hay que reponer a mano lo que el
  // botón daba gratis: tabIndex, aria-expanded y Enter/Espacio.
  return (
    <div
      className={`lab-steps ${live ? "lab-steps--live" : ""} ${open ? "lab-steps--open" : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={open ? "Ocultar los pasos" : "Ver todos los pasos"}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className="lab-steps-head">
        {live && !open ? (
          // La `key` es el contador de pasos: al llegar uno nuevo React
          // desmonta la línea anterior y monta esta, que es lo que dispara la
          // animación de entrada. Sin key el texto cambiaría de golpe y
          // parecería un glitch en vez de un relevo.
          <span key={steps.length} className="lab-step lab-step--current">
            <StepRow step={current} live />
          </span>
        ) : (
          // Plegado/resumen: en vez del caret gris va el glifo de la última
          // acción del bloque — el mismo vocabulario visual de las filas, así
          // el ojo ya sabe de qué trata el bloque sin abrirlo.
          <span className="lab-step lab-steps-summary">
            <span className="lab-step-glyph" aria-hidden>
              {glyphOf(current.name)}
            </span>
            <span className="lab-steps-count">{label}</span>
          </span>
        )}
      </div>

      {open && (
        <ul className="lab-steps-list">
          {steps.map((s, i) => (
            <li key={i} className="lab-step">
              <StepRow step={s} live={live && i === steps.length - 1} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
