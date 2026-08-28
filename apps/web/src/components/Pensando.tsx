// Indicador de "Pensando" compartido por la consola, el asesor de Vida,
// el Estudio y el rail de sugerencias en vivo.
//
// Tres piezas: la P en mayúscula, un barrido de skeleton sobre las letras
// (mismo lenguaje que .skeleton) y tres puntos que saltan en cascada.
// Vive en un solo componente para que los cuatro lugares no se
// desincronicen — antes cada uno tenía su propia variante.

type Props = {
  /** Texto antes de los puntos. La mayúscula inicial va incluida. */
  label?: string;
  /** Diámetro de los puntos en px (4 acompaña a text-base; 3 a text-xs). */
  dot?: number;
  className?: string;
};

export function Pensando({ label = "Pensando", dot = 4, className = "" }: Props) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Hermes está ${label.toLowerCase()}`}
      className={`inline-flex items-center gap-1.5 align-middle ${className}`}
    >
      <span className="thinking-text">{label}</span>
      <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="thinking-dot rounded-full bg-violet"
            style={{
              width: dot,
              height: dot,
              // Cascada: cada punto arranca 160ms después del anterior.
              animationDelay: `${i * 160}ms`,
            }}
          />
        ))}
      </span>
    </span>
  );
}
