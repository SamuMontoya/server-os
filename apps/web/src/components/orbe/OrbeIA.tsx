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

    let vivo = true;
    let raf = 0;
    // `perdido` congela el bucle mientras el contexto está muerto (GPU
    // reseteada/driver caído/cambio de GPU en portátiles híbridos): sin esto,
    // cada llamada a gl.* con el contexto perdido lanza o no hace nada y el
    // lienzo queda en el último fotograma válido (o negro) sin que nadie lo
    // note ni lo repare.
    let perdido = false;

    // Estado GL que se recrea completo cada vez que el contexto se restaura
    // (todo lo que vive en la GPU se pierde con el contexto: shaders,
    // programa, buffers y — sobre todo — la textura del atlas).
    let gl: WebGLRenderingContext | null = null;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let pr: WebGLProgram | null = null;
    let bf: WebGLBuffer | null = null;
    let tex: WebGLTexture | null = null;
    let uRes: WebGLUniformLocation | null = null;
    let uTex: WebGLUniformLocation | null = null;
    let uF0: WebGLUniformLocation | null = null;
    let uF1: WebGLUniformLocation | null = null;
    let uMix: WebGLUniformLocation | null = null;
    let uMov: WebGLUniformLocation | null = null;
    let atlasListo = false;

    // La imagen decodificada y el JSON de movimiento NO dependen de la GPU:
    // sobreviven a una pérdida de contexto en memoria de JS. Al restaurar no
    // hace falta re-descargarlos, solo volver a subir la imagen ya lista.
    let MOV: Mov[] | null = null;
    const img = new Image();

    const compilar = (ctx: WebGLRenderingContext, tipo: number, fuente: string) => {
      const s = ctx.createShader(tipo)!;
      ctx.shaderSource(s, fuente);
      ctx.compileShader(s);
      if (!ctx.getShaderParameter(s, ctx.COMPILE_STATUS)) {
        const log = ctx.getShaderInfoLog(s);
        ctx.deleteShader(s);
        throw new Error(log ?? "fallo al compilar el shader");
      }
      return s;
    };

    /** Sube la textura del atlas a la GPU. Se llama al terminar de decodificar
     *  la imagen Y, otra vez, al restaurar el contexto (si la imagen ya
     *  estaba lista, no hay que esperar red de nuevo). */
    const subirAtlas = () => {
      if (!gl || !tex) return;
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
      gl.uniform1i(gl.getUniformLocation(pr!, "uAtlas"), 0);
      atlasListo = true;
    };

    /** (Re)crea todo lo que vive en la GPU: shaders, programa, buffer,
     *  uniforms y la textura (vacía; subirAtlas la llena). Se llama al montar
     *  y de nuevo en cada `webglcontextrestored`. Devuelve false si algo
     *  falla (sin WebGL utilizable). */
    const crearRecursosGL = (): boolean => {
      const ctx = lienzo.getContext("webgl", {
        alpha: false,
        antialias: false,
        // Evita que el navegador fuerce la GPU discreta: en portátiles con
        // gráficos híbridos (Intel+NVIDIA/AMD), cambiar de GPU a mitad de
        // sesión es la causa más común de "se congela/parpadea/se pone negro
        // un rato" en WebGL — y de una pérdida de contexto que dispara el
        // problema en el primer lugar. El orbe es decorativo, no necesita la
        // GPU de más potencia.
        powerPreference: "low-power",
      }) as WebGLRenderingContext | null;
      if (!ctx) return false;
      gl = ctx;

      try {
        vs = compilar(ctx, ctx.VERTEX_SHADER, VERT);
        fs = compilar(ctx, ctx.FRAGMENT_SHADER, FRAG);
        pr = ctx.createProgram()!;
        ctx.attachShader(pr, vs);
        ctx.attachShader(pr, fs);
        ctx.linkProgram(pr);
        if (!ctx.getProgramParameter(pr, ctx.LINK_STATUS)) {
          throw new Error(ctx.getProgramInfoLog(pr) ?? "fallo al enlazar");
        }
      } catch (err) {
        console.error("[OrbeIA] shader:", err);
        return false;
      }

      ctx.useProgram(pr);

      // Triángulo que cubre la pantalla; el recorte lo hace el shader.
      bf = ctx.createBuffer();
      ctx.bindBuffer(ctx.ARRAY_BUFFER, bf);
      ctx.bufferData(
        ctx.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        ctx.STATIC_DRAW,
      );
      const loc = ctx.getAttribLocation(pr, "pos");
      ctx.enableVertexAttribArray(loc);
      ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);

      // Los locations se resuelven una vez, no en cada fotograma.
      const U = (n: string) => ctx.getUniformLocation(pr!, n);
      uRes = U("uRes");
      uTex = U("uTex");
      uF0 = U("uF0");
      uF1 = U("uF1");
      uMix = U("uMix");
      uMov = U("uMov");

      ctx.uniform1f(U("uLado"), META.t);
      ctx.uniform1f(U("uRej"), META.g);
      ctx.uniform1f(U("uCaja"), META.caja);
      ctx.uniform1f(U("uAsp"), META.asp);
      ctx.uniform1f(U("uGris"), GRIS);
      ctx.uniform1f(U("uUmbral"), UMBRAL);
      ctx.uniform1f(U("uMargen"), MARGEN);

      tex = ctx.createTexture();
      atlasListo = false;
      if (img.complete && img.naturalWidth > 0) {
        // La imagen ya estaba decodificada de antes (caso típico de
        // restauración de contexto): no hay que esperar la red de nuevo.
        subirAtlas();
      }

      // El tamaño del búfer depende de clientWidth/clientHeight, que no
      // cambian por la pérdida de contexto — se vuelve a fijar igual en
      // ambos casos (montaje y restauración). Va ANTES del clear: fijar
      // canvas.width/height RESETEA el drawing buffer por spec de WebGL (a
      // negro/transparente), así que un clear hecho antes de este resize se
      // pierde sin más — ese orden invertido era el bug real detrás del
      // "a veces se ve negra" (confirmado leyendo el píxel central con
      // gl.readPixels en los tests de Playwright).
      medir();

      // Blanco de entrada, antes de que atlas/movimiento terminen de cargar:
      // sin este clear (después del resize de arriba), el contenido del
      // framebuffer quedaría en lo que sea que deje el reset del backing
      // store — en la práctica, negro opaco.
      ctx.clearColor(1, 1, 1, 1);
      ctx.clear(ctx.COLOR_BUFFER_BIT);

      return true;
    };

    // ── Tamaño del búfer ─────────────────────────────────────────────────────
    // Tamaño CSS × DPR, con DPR topado en 2 y un presupuesto de 3,2 Mpx: si el
    // orbe se hace enorme, baja la resolución antes que los fps.
    const medir = () => {
      if (!gl) return;
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
        // Cambiar canvas.width/height resetea el drawing buffer (spec de
        // WebGL) — en régimen estable el próximo fotograma del bucle lo
        // vuelve a pintar enseguida y no se nota, pero si esto pasa MIENTRAS
        // atlas/movimiento aún cargan (marco() todavía no dibuja nada), sin
        // este clear el lienzo se ve negro hasta que terminen de cargar.
        if (!atlasListo || !MOV) {
          gl.clearColor(1, 1, 1, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }
    };

    // ── Pérdida/restauración de contexto ────────────────────────────────────
    // Sin `preventDefault()` en `webglcontextlost`, el navegador NO intenta
    // restaurar el contexto y el lienzo queda muerto para siempre — eso es
    // el "a veces se ve negra" reportado (una vez perdido, sin este
    // manejador no vuelve solo ni con más fotogramas ni recargando el
    // componente, solo recargando la página entera). El evento de pérdida
    // también puede repetirse varias veces seguidas si el driver está
    // inestable (típico en GPUs híbridas de Windows/Edge) — eso es el
    // parpadeo: se pierde, se restaura, se pierde de nuevo.
    const alPerderContexto = (e: Event) => {
      e.preventDefault();
      perdido = true;
      cancelAnimationFrame(raf);
    };
    const alRestaurarContexto = () => {
      perdido = false;
      if (!crearRecursosGL()) {
        setSinWebgl(true);
        return;
      }
      raf = requestAnimationFrame(marco);
    };
    lienzo.addEventListener("webglcontextlost", alPerderContexto, false);
    lienzo.addEventListener("webglcontextrestored", alRestaurarContexto, false);

    if (!crearRecursosGL()) {
      setSinWebgl(true);
      return () => {
        lienzo.removeEventListener("webglcontextlost", alPerderContexto);
        lienzo.removeEventListener("webglcontextrestored", alRestaurarContexto);
      };
    }

    // ── Assets ───────────────────────────────────────────────────────────────
    img.onload = () => {
      if (!vivo || perdido) return;
      subirAtlas();
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

    const observador = new ResizeObserver(medir);
    observador.observe(lienzo);
    window.addEventListener("resize", medir);

    // ── Bucle ────────────────────────────────────────────────────────────────
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let quieto = mq.matches;

    const DUR = META.n / META.fps; // 7,0333 s
    const t0 = performance.now();

    // Con `prefers-reduced-motion` el bucle no reprograma más fotogramas
    // tras el primero (más abajo) — a propósito, para no animar. Pero si ESE
    // primer fotograma cae antes de que atlas/movimiento terminen de cargar,
    // sin esta bandera el lienzo se quedaba en blanco/negro PARA SIEMPRE
    // (nunca llegaba un segundo intento que sí encontrara los assets listos).
    let dibujoHecho = false;
    const marco = (ahora: number) => {
      if (!vivo || perdido || !gl) return;
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
        dibujoHecho = true;
      }
      if (!quieto || !dibujoHecho) raf = requestAnimationFrame(marco);
    };
    raf = requestAnimationFrame(marco);

    // Si cambia la preferencia hay que congelar o volver a arrancar el bucle.
    const alCambiarMovimiento = (e: MediaQueryListEvent) => {
      quieto = e.matches;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(marco);
    };
    mq.addEventListener("change", alCambiarMovimiento);

    // Red de seguridad: navegadores como Edge (modo de eficiencia/"sleeping
    // tabs") pausan rAF o hasta duermen la GPU de una pestaña en segundo
    // plano. Al volver a primer plano no hay garantía de en qué quedó el
    // framebuffer — puede llevar dormido un resize que reseteó el buffer
    // mientras nadie miraba. Forzar un tick nuevo (cancelando el que
    // quedara pendiente) en vez de esperar a que el navegador decida
    // reanudar solo es lo que evita el frame viejo/negro justo al volver.
    const alCambiarVisibilidad = () => {
      if (document.visibilityState !== "visible" || !gl) return;
      medir();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(marco);
    };
    document.addEventListener("visibilitychange", alCambiarVisibilidad);

    return () => {
      vivo = false;
      cancelAnimationFrame(raf);
      aborto.abort();
      img.onload = null;
      img.onerror = null;
      mq.removeEventListener("change", alCambiarMovimiento);
      observador.disconnect();
      window.removeEventListener("resize", medir);
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      lienzo.removeEventListener("webglcontextlost", alPerderContexto);
      lienzo.removeEventListener("webglcontextrestored", alRestaurarContexto);
      if (!gl) return;
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
