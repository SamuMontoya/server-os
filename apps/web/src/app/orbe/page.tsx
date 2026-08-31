"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { OrbeIA } from "@/components/orbe/OrbeIA";

/* Demo aislada del orbe. La ruta pinta blanco puro porque el orbe se midió
   sobre fondo blanco y su shader rellena de blanco opaco fuera de la caja.

   ?verificar=1 monta la geometría del vídeo original para la auditoría
   pixel a pixel: orbe de 262 px de diámetro centrado en (357, 274) de un
   lienzo de 720×540, con los ojos dibujados apagados. */

function Orbe() {
  const params = useSearchParams();
  const verificar = params.get("verificar") === "1";

  useEffect(() => {
    document.documentElement.classList.add("orbe-route");
    return () => document.documentElement.classList.remove("orbe-route");
  }, []);

  if (verificar) {
    return (
      <div
        style={{
          position: "relative",
          width: 720,
          height: 540,
          background: "#fff",
          overflow: "hidden",
        }}
      >
        {/* El cuerpo mide el diámetro del orbe y se centra en (357, 274);
            el lienzo interno ya se desborda un 10 % por cada lado. */}
        <div
          style={{
            position: "absolute",
            left: 357 - 262 / 2,
            top: 274 - 262 / 2,
            width: 262,
            height: 262,
          }}
        >
          <OrbeIA tam="262px" ojos={false} ariaLabel="Orbe de la IA, auditoría" />
        </div>
      </div>
    );
  }

  return <OrbeIA />;
}

export default function PaginaOrbe() {
  return (
    <Suspense fallback={null}>
      <Orbe />
    </Suspense>
  );
}
