"use client";

import { useEffect, useRef, useState } from "react";
import estilos from "./OrbeIA.module.css";

/* ─────────────────────────────────────────────────────────────────────────────
   ORBE IA

   No es una animación inventada: la película de color se MIDIÓ del vídeo
   original fotograma a fotograma y viaja como textura (atlas 4080×4080, rejilla
   15×15 de baldosas de 272 px). El shader sólo la lee.

   El movimiento (desplazamiento y deformación de cada fotograma) se guarda
   aparte en movimiento.json y se deshace EN EL SHADER, no con una transformada
   CSS sobre el lienzo: en CSS serían dos remuestreos encadenados.
   ──────────────────────────────────────────────────────────────────────────── */

const META = { n: 211, t: 272, g: 15, caja: 1.1, fps: 30, asp: 1.031496 };

const RUTA_ATLAS = "/assets/pelicula.webp";
const RUTA_MOVIMIENTO = "/assets/movimiento.json";

/** Claridad del cuerpo del orbe: más alto = más cerca del blanco. */
const GRIS = 0.935;
/** Desde qué luminancia manda el color en vez del gris. */
const UMBRAL = 0.3;
/** El lienzo mide 1,20 diámetros = 2,40 radios. OJO: es el DIÁMETRO del lienzo
 *  en radios, no la fracción de lienzo. Confundirlo dobla el tamaño del orbe. */
const MARGEN = 1.0 / 2.4;

const DPR_MAX = 2;
const PX_MAX = 3.2e6;

const VERT = `attribute vec2 pos; void main(){ gl_Position = vec4(pos,0.,1.); }`;

const FRAG = `
precision highp float;
uniform sampler2D uAtlas;
uniform vec2  uRes, uTex;
uniform float uLado, uRej, uCaja;   // lado de baldosa · rejilla · radios que abarca
uniform float uF0, uF1, uMix, uMargen;
uniform vec4  uMov;      // dx, dy, sx, sy medidos, interpolados
uniform float uAsp;      // radio mediano x / radio mediano y
uniform float uGris;     // claridad del cuerpo del orbe
uniform float uUmbral;   // desde que luminancia manda el color en vez del gris

vec3 texel(vec2 p){
  return texture2D(uAtlas, (p + 0.5) / uTex).rgb;
}

// Catmull-Rom, no bilineal: bilineal solo es continuo en valor, no en pendiente,
// y al ampliar se ve un pliegue en cada frontera de texel (eso es lo que se lee
// como "pixelado").
vec4 pesosCR(float t){
  float t2 = t*t, t3 = t2*t;
  return vec4(-0.5*t3 +     t2 - 0.5*t,
               1.5*t3 - 2.5*t2       + 1.0,
              -1.5*t3 + 2.0*t2 + 0.5*t,
               0.5*t3 - 0.5*t2);
}

vec3 baldosa(float f, vec2 uvOrbe){
  float fila = floor(f / uRej);
  vec2 orig = vec2(f - fila * uRej, fila) * uLado;
  vec2 p = (uvOrbe / uCaja * 0.5 + 0.5) * uLado - 0.5;
  vec2 b = floor(p);
  vec4 wx = pesosCR(p.x - b.x), wy = pesosCR(p.y - b.y);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++){
    float yy = clamp(b.y + float(j) - 1.0, 0.0, uLado - 1.0);
    vec3 f4 = vec3(0.0);
    for (int i = 0; i < 4; i++){
      float xx = clamp(b.x + float(i) - 1.0, 0.0, uLado - 1.0);
      f4 += texel(orig + vec2(xx, yy)) * wx[i];
    }
    acc += f4 * wy[j];
  }
  return max(acc, vec3(0.0));   // Catmull-Rom puede pasarse por debajo de cero
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  uv.y = -uv.y;
  uv /= uMargen;                       // ahora en radios del orbe
  uv.y *= uAsp;                        // sin esto el orbe sale 3,1 % mas alto
  uv = (uv - uMov.xy) / uMov.zw;       // deshace el movimiento medido
  if (max(abs(uv.x), abs(uv.y)) > uCaja) { gl_FragColor = vec4(1.0); return; }
  vec3 col = mix(baldosa(uF0, uv), baldosa(uF1, uv), uMix);
  float lum = max(col.r, max(col.g, col.b));
  vec3 crom = lum > 0.004 ? col / lum : vec3(1.0);
  // El gris arranca en 0,14 y no mas abajo: el atlas va en WebP con perdida y el
  // compresor deja ringing pegado al canto brillante con picos de 27/255 = 0,106.
  vec3 base = mix(vec3(1.0), vec3(uGris), smoothstep(0.14, 0.34, lum));
  vec3  vivo   = crom * mix(0.58, 1.0, smoothstep(uUmbral, 1.0, lum));
  float fuerza = smoothstep(uUmbral, uUmbral + 0.50, lum);
  gl_FragColor = vec4(mix(base, vivo, fuerza), 1.0);
}
`;

type Mov = [number, number, number, number];

export type OrbeIAProps = {
  /** Diámetro del orbe como longitud CSS. Hasta ~260 px a DPR 2 se ve limpio;
   *  por encima de ~400 px la suavidad ya es la del vídeo original. */
  tam?: string;
  className?: string;
  ariaLabel?: string;
  /** Los ojos son dibujados, no los del vídeo (los del vídeo se borraron del
   *  atlas por inpainting armónico). Apagarlos sirve para auditar la película
   *  de color contra los fotogramas originales. */
  ojos?: boolean;
};

export function OrbeIA({
  tam = "min(62vmin, 520px)",
  className,
  ariaLabel = "Orbe de la IA, en reposo",
  ojos = true,
}: OrbeIAProps) {
  const refCuerpo = useRef<HTMLDivElement | null>(null);
  const refLienzo = useRef<HTMLCanvasElement | null>(null);
  const refMovOjos = useRef<HTMLDivElement | null>(null);
  const [sinWebgl, setSinWebgl] = useState(false);

  useEffect(() => {
    const lienzo = refLienzo.current;
    const movOjos = refMovOjos.current;
    if (!lienzo || !movOjos) return;

    const gl = lienzo.getContext("webgl", {
      alpha: false,
      antialias: false,
    }) as WebGLRenderingContext | null;

    if (!gl) {
      setSinWebgl(true);
      return;
    }

    let vivo = true;
    let raf = 0;

    const compilar = (tipo: number, fuente: string) => {
      const s = gl.createShader(tipo)!;
      gl.shaderSource(s, fuente);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(log ?? "fallo al compilar el shader");
      }
      return s;
    };

    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let pr: WebGLProgram | null = null;
    let bf: WebGLBuffer | null = null;
    let tex: WebGLTexture | null = null;

    try {
      vs = compilar(gl.VERTEX_SHADER, VERT);
      fs = compilar(gl.FRAGMENT_SHADER, FRAG);
      pr = gl.createProgram()!;
      gl.attachShader(pr, vs);
      gl.attachShader(pr, fs);
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(pr) ?? "fallo al enlazar");
      }
    } catch (err) {
      console.error("[OrbeIA] shader:", err);
      setSinWebgl(true);
      return;
    }

    gl.useProgram(pr);

    // Triángulo que cubre la pantalla; el recorte lo hace el shader.
    bf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(pr, "pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    // Los locations se resuelven una vez, no en cada fotograma.
    const U = (n: string) => gl.getUniformLocation(pr!, n);
    const uRes = U("uRes");
    const uTex = U("uTex");
    const uF0 = U("uF0");
    const uF1 = U("uF1");
    const uMix = U("uMix");
    const uMov = U("uMov");

    gl.uniform1f(U("uLado"), META.t);
    gl.uniform1f(U("uRej"), META.g);
    gl.uniform1f(U("uCaja"), META.caja);
    gl.uniform1f(U("uAsp"), META.asp);
    gl.uniform1f(U("uGris"), GRIS);
    gl.uniform1f(U("uUmbral"), UMBRAL);
    gl.uniform1f(U("uMargen"), MARGEN);

    // ── Assets ───────────────────────────────────────────────────────────────
    let MOV: Mov[] | null = null;
    let atlasListo = false;

    tex = gl.createTexture();
    const img = new Image();
    img.onload = () => {
      if (!vivo) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      // NEAREST a mano, nunca LINEAR del hardware: el atlas es una rejilla de
      // baldosas y el filtrado mezclaría una baldosa con la vecina (un fotograma
      // con otro) dejando costura en el canto.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      // 4080 no es potencia de dos: sin CLAMP_TO_EDGE la textura queda
      // INCOMPLETA en WebGL 1 y devuelve negro.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform2f(uTex, img.width, img.height);
      gl.uniform1i(U("uAtlas"), 0);
      atlasListo = true;
    };
    img.onerror = () => {
      console.error("[OrbeIA] no se pudo cargar el atlas:", RUTA_ATLAS);
      if (vivo) setSinWebgl(true);
    };
    img.src = RUTA_ATLAS;

    const aborto = new AbortController();
    fetch(RUTA_MOVIMIENTO, { signal: aborto.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { mov: Mov[] }) => {
        if (vivo) MOV = j.mov;
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          console.error("[OrbeIA] no se pudo cargar el movimiento:", err);
        }
      });

    // ── Tamaño del búfer ─────────────────────────────────────────────────────
    // Tamaño CSS × DPR, con DPR topado en 2 y un presupuesto de 3,2 Mpx: si el
    // orbe se hace enorme, baja la resolución antes que los fps.
    const medir = () => {
      let dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
      const bruto = lienzo.clientWidth * lienzo.clientHeight * dpr * dpr;
      if (bruto > PX_MAX) dpr *= Math.sqrt(PX_MAX / bruto);
      const w = Math.max(1, Math.round(lienzo.clientWidth * dpr));
      const h = Math.max(1, Math.round(lienzo.clientHeight * dpr));
      if (lienzo.width !== w || lienzo.height !== h) {
        lienzo.width = w;
        lienzo.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uRes, w, h);
      }
    };
    medir();

    const observador = new ResizeObserver(medir);
    observador.observe(lienzo);
    window.addEventListener("resize", medir);

    // ── Bucle ────────────────────────────────────────────────────────────────
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let quieto = mq.matches;

    const DUR = META.n / META.fps; // 7,0333 s
    const t0 = performance.now();

    const marco = (ahora: number) => {
      if (!vivo) return;
      if (atlasListo && MOV) {
        const t = quieto ? 0 : ((ahora - t0) / 1000) % DUR;
        const fi = t * META.fps;
        const i0 = Math.floor(fi) % META.n;
        const i1 = (i0 + 1) % META.n;
        const mx = fi - Math.floor(fi);

        gl.uniform1f(uF0, i0);
        gl.uniform1f(uF1, i1);
        gl.uniform1f(uMix, mx);

        const A = MOV[i0];
        const B = MOV[i1];
        const dx = A[0] + (B[0] - A[0]) * mx;
        const dy = A[1] + (B[1] - A[1]) * mx;
        const sx = A[2] + (B[2] - A[2]) * mx;
        const sy = A[3] + (B[3] - A[3]) * mx;
        gl.uniform4f(uMov, dx, dy, sx, sy);

        // dy va en unidades del radio VERTICAL y el porcentaje de translate es
        // del lado del elemento (el diámetro HORIZONTAL): hay que dividir por la
        // anisotropía al mover los ojos.
        movOjos.style.transform =
          `translate(${dx * 50}%, ${(dy * 50) / META.asp}%) ` +
          `scale(${sx}, ${sy})`;

        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (!quieto) raf = requestAnimationFrame(marco);
    };
    raf = requestAnimationFrame(marco);

    // Si cambia la preferencia hay que congelar o volver a arrancar el bucle.
    const alCambiarMovimiento = (e: MediaQueryListEvent) => {
      quieto = e.matches;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(marco);
    };
    mq.addEventListener("change", alCambiarMovimiento);

    return () => {
      vivo = false;
      cancelAnimationFrame(raf);
      aborto.abort();
      img.onload = null;
      img.onerror = null;
      mq.removeEventListener("change", alCambiarMovimiento);
      observador.disconnect();
      window.removeEventListener("resize", medir);
      if (tex) gl.deleteTexture(tex);
      if (bf) gl.deleteBuffer(bf);
      if (pr) {
        if (vs) gl.detachShader(pr, vs);
        if (fs) gl.detachShader(pr, fs);
        gl.deleteProgram(pr);
      }
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <div
      ref={refCuerpo}
      role="img"
      aria-label={ariaLabel}
      className={[estilos.cuerpo, sinWebgl ? estilos.sinWebgl : "", className]
        .filter(Boolean)
        .join(" ")}
      style={{ ["--d" as string]: tam }}
    >
      <canvas
        ref={refLienzo}
        className={estilos.lienzo}
        style={sinWebgl ? { display: "none" } : undefined}
      />
      {/* La envoltura se monta siempre (el bucle escribe su transform); lo que
          se apaga con `ojos` es la cara. */}
      <div ref={refMovOjos} className={estilos.movOjos}>
        {ojos ? (
          <div className={estilos.cara}>
            <div className={estilos.ojo} />
            <div className={estilos.ojo} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default OrbeIA;
