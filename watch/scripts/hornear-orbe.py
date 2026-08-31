#!/usr/bin/env python3
"""Hornea los fotogramas del Orbe IA para el reloj.

POR QUÉ HORNEAR Y NO PORTAR EL SHADER
El orbe de la web es un shader WebGL que lee el atlas medido del vídeo. En
watchOS no hay WebGL, y portar el GLSL a Metal es mucho riesgo para lo que en
realidad es una animación determinista: los mismos 211 fotogramas, siempre
iguales. Se calcula aquí lo que allá calcula la GPU y el reloj solo pasa
imágenes.

Lo que se replica, y que NO estaba en un recorte ingenuo del atlas:
  · el mapeo de color del fragment shader (cuerpo casi blanco + croma en los
    cantos brillantes) — sin él el orbe sale oscuro sobre fondo negro
  · el movimiento por fotograma de movimiento.json — el SALTO
  · los OJOS, que no están en el atlas: se borraron por inpainting y se
    dibujan encima, con su mirada y su parpadeo
"""

import json
import os
import numpy as np
from PIL import Image

RAIZ = os.path.join(os.path.dirname(__file__), "..", "..")
ATLAS = os.path.join(RAIZ, "apps/web/public/assets/pelicula.webp")
MOVIM = os.path.join(RAIZ, "apps/web/public/assets/movimiento.json")
SALIDA = os.path.join(os.path.dirname(__file__), "..", "WatchApp/Assets.xcassets")

# Constantes del componente web (META + las del módulo).
N, LADO, REJ, CAJA, FPS, ASP = 211, 272, 15, 1.1, 30, 1.031496
GRIS, UMBRAL = 0.935, 0.3
BUCLE = N / FPS                      # 7,0333 s

# El lienzo mide 1,20 diámetros = ±1,2 radios (MARGEN = 1/2.4 en el shader).
SPAN = 1.2
PX = 192                             # resolución de horneado

# El cuerpo se hornea ESTABILIZADO y SIN OJOS: en el reloj los ojos se dibujan
# en SwiftUI (para poder cerrarlos al dormir y sacudirlos al despertar) y el
# movimiento se aplica como transformada, solo al tocar la pantalla. Horneado
# todo junto, como en la web, no habría forma de separarlos.
CON_OJOS = False
CON_MOVIMIENTO = False

# Ojos, en radios (del CSS: --ojo-an .092, --ojo-al .185, gap .278)
OJO_AN, OJO_AL, OJO_GAP, OJO_CERRADO = 0.092, 0.185, 0.278, 0.497
SS = 4                               # supermuestreo para el borde de los ojos


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def bezier(p1x, p1y, p2x, p2y, t):
    """cubic-bezier de CSS: se resuelve x(u)=t por bisección y se evalúa y(u)."""
    lo, hi = 0.0, 1.0
    for _ in range(24):
        u = (lo + hi) / 2
        v = 1 - u
        x = 3 * v * v * u * p1x + 3 * v * u * u * p2x + u * u * u
        if x < t:
            lo = u
        else:
            hi = u
    u = (lo + hi) / 2
    v = 1 - u
    return 3 * v * v * u * p1y + 3 * v * u * u * p2y + u * u * u


def tramo(paradas, t, ease):
    """Interpola una lista [(pct, valor...)] como haría una animación CSS."""
    for i in range(len(paradas) - 1):
        a, b = paradas[i], paradas[i + 1]
        if a[0] <= t <= b[0]:
            span = b[0] - a[0]
            u = 0.0 if span == 0 else (t - a[0]) / span
            k = ease(u)
            return [a[j] + (b[j] - a[j]) * k for j in range(1, len(a))]
    return list(paradas[-1][1:])


def mirada(t):
    """keyframes `mirar`, con su cubic-bezier(.38,.03,.24,1). CSS: y hacia abajo."""
    paradas = [(0.0, 0.0, -0.2), (0.26, 0.0, -0.2), (0.315, 0.28, -0.3),
               (0.41, 0.274, -0.312), (0.47, 0.0, -0.2), (1.0, 0.0, -0.2)]
    return tramo(paradas, t, lambda u: bezier(0.38, 0.03, 0.24, 1.0, u))


def parpadeo(t):
    """keyframes `parpadeo` (escala vertical del ojo), ease-in-out."""
    paradas = [(0.0, 1.0), (0.15, 1.0), (0.16, OJO_CERRADO), (0.17, 1.0),
               (0.645, 1.0), (0.673, OJO_CERRADO), (0.70, OJO_CERRADO),
               (0.725, 1.0), (1.0, 1.0)]
    return tramo(paradas, t, lambda u: bezier(0.42, 0.0, 0.58, 1.0, u))[0]


def main():
    atlas = np.asarray(Image.open(ATLAS).convert("RGB"), dtype=np.float32) / 255.0
    mov = json.load(open(MOVIM))["mov"]
    assert len(mov) == N, f"movimiento.json trae {len(mov)}, se esperaban {N}"

    # Malla de uv, igual que gl_FragCoord en el shader.
    ejes = (np.arange(PX) + 0.5) / PX - 0.5
    ux = ejes * 2 * SPAN
    uy = -(ejes * 2 * SPAN) * ASP        # uv.y = -uv.y ; uv.y *= uAsp
    UX, UY = np.meshgrid(ux, uy)

    # Malla supermuestreada para los ojos (bordes limpios sin antialias manual).
    e2 = (np.arange(PX * SS) + 0.5) / (PX * SS) - 0.5
    EX, EY = np.meshgrid(e2 * 2 * SPAN, e2 * 2 * SPAN)   # ojos en coords CSS (y abajo)

    for f in range(N):
        dx, dy, sx, sy = mov[f] if CON_MOVIMIENTO else (0.0, 0.0, 1.0, 1.0)
        vx = (UX - dx) / sx
        vy = (UY - dy) / sy

        dentro = np.maximum(np.abs(vx), np.abs(vy)) <= CAJA

        # Coordenada dentro de la baldosa del atlas.
        fila, col = divmod(f, REJ)
        px = (vx / CAJA * 0.5 + 0.5) * LADO - 0.5
        py = (vy / CAJA * 0.5 + 0.5) * LADO - 0.5
        px = np.clip(px, 0, LADO - 1.001)
        py = np.clip(py, 0, LADO - 1.001)
        x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
        tx, ty = (px - x0)[..., None], (py - y0)[..., None]
        ox, oy = col * LADO, fila * LADO
        t00 = atlas[oy + y0,     ox + x0]
        t10 = atlas[oy + y0,     ox + x0 + 1]
        t01 = atlas[oy + y0 + 1, ox + x0]
        t11 = atlas[oy + y0 + 1, ox + x0 + 1]
        col_rgb = (t00 * (1 - tx) + t10 * tx) * (1 - ty) + \
                  (t01 * (1 - tx) + t11 * tx) * ty

        # Mapeo de color del fragment shader, tal cual.
        lum = col_rgb.max(axis=2, keepdims=True)
        crom = np.where(lum > 0.004, col_rgb / np.maximum(lum, 1e-6), 1.0)
        base = 1.0 + (GRIS - 1.0) * smoothstep(0.14, 0.34, lum)
        vivo = crom * (0.58 + 0.42 * smoothstep(UMBRAL, 1.0, lum))
        fuerza = smoothstep(UMBRAL, UMBRAL + 0.50, lum)
        out = base + (vivo - base) * fuerza
        out = np.where(dentro[..., None], out, 1.0)

        # ── Ojos ────────────────────────────────────────────────────────────
        if not CON_OJOS:
            img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
            nombre = f"orbe-{f:03d}"
            d = os.path.join(SALIDA, f"{nombre}.imageset")
            os.makedirs(d, exist_ok=True)
            img.save(os.path.join(d, f"{nombre}.png"))
            json.dump({"images": [{"filename": f"{nombre}.png", "idiom": "universal"}],
                       "info": {"author": "xcode", "version": 1}},
                      open(os.path.join(d, "Contents.json"), "w"), indent=2)
            if f % 40 == 0:
                print(f"  {f}/{N}")
            continue

        t = f / N
        mx, my = mirada(t)
        pb = parpadeo(t)

        # movOjos: translate(dx*50%, dy*50/asp %) scale(sx,sy) sobre un lado de
        # 2 radios → desplazamiento en radios = dx, dy/asp.
        cx_base = OJO_GAP / 2 + OJO_AN / 2
        mascara = np.zeros((PX * SS, PX * SS), dtype=bool)
        for signo in (-1, 1):
            ex = (signo * cx_base + mx) * sx + dx
            ey = (my) * sy + dy / ASP
            rx, ry = (OJO_AN / 2) * sx, (OJO_AL / 2) * sy * pb
            # Píldora: border-radius 999px sobre una caja más alta que ancha.
            X = (EX - ex) / rx
            Y = (EY - ey) / ry
            recta = ry - rx
            yy = np.clip(np.abs(EY - ey) - recta, 0, None) / max(rx, 1e-6)
            mascara |= (X * X + yy * yy) <= 1.0

        m = mascara.reshape(PX, SS, PX, SS).mean(axis=(1, 3))[..., None]
        out = out * (1 - m) + np.float32(0x14 / 255.0) * m

        img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGB")
        nombre = f"orbe-{f:03d}"
        d = os.path.join(SALIDA, f"{nombre}.imageset")
        os.makedirs(d, exist_ok=True)
        img.save(os.path.join(d, f"{nombre}.png"))
        json.dump({"images": [{"filename": f"{nombre}.png", "idiom": "universal"}],
                   "info": {"author": "xcode", "version": 1}},
                  open(os.path.join(d, "Contents.json"), "w"), indent=2)

        if f % 40 == 0:
            print(f"  {f}/{N}")

    print(f"  listo: {N} fotogramas de {PX}px · bucle {BUCLE:.4f}s")


if __name__ == "__main__":
    main()
