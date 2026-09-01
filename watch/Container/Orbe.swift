import SwiftUI

/// El Orbe IA, el mismo que la web.
///
/// Son los 211 fotogramas horneados de `pelicula.webp` (los mismos que usa el
/// reloj, ver `scripts/hornear-orbe.py`) más los OJOS dibujados encima. Los
/// ojos no están en el atlas: se borraron por inpainting y la web los pinta
/// como nodos del DOM. Aquí igual, con sus mismos keyframes de mirada y
/// parpadeo copiados del CSS — si se movieran distinto, sería otro personaje.
struct Orbe: View {
  /// Diámetro del ORBE (no del lienzo). En la web: 72px en la pantalla de
  /// chats, 56px pensando, 14px dentro de un paso.
  var lado: CGFloat = 56
  /// Los ojos se pueden apagar; la web los deja puestos en los tres sitios.
  var ojos = true

  private static let n = 211
  private static let fps: Double = 30
  private static let bucle = Double(n) / fps          // 7,0333 s
  private static let asp = 1.031496
  /// El lienzo horneado mide 1,2 diámetros (margen de la fase de estirado).
  private static let margen: CGFloat = 1.2

  // Ojos en radios, del CSS: --ojo-an .092, --ojo-al .185, gap .278
  private static let ojoAn = 0.092
  private static let ojoAl = 0.185
  private static let ojoSep = 0.185
  private static let ojoCerrado = 0.497

  var body: some View {
    TimelineView(.animation) { t in
      let s = t.date.timeIntervalSinceReferenceDate
      let i = Int(s * Self.fps) % Self.n
      let fase = s.truncatingRemainder(dividingBy: Self.bucle) / Self.bucle
      let r = lado / 2

      ZStack {
        Image(String(format: "orbe-%03d", i))
          .resizable()
          .interpolation(.high)
          .scaledToFit()
          .frame(width: lado * Self.margen, height: lado * Self.margen)
        if ojos { Self.parOjos(r: r, fase: fase) }
      }
      .frame(width: lado * Self.margen, height: lado * Self.margen)
    }
  }

  @ViewBuilder
  private static func parOjos(r: CGFloat, fase: Double) -> some View {
    let (mx, my) = mirada(fase)
    let pb = parpadeo(fase)
    HStack(spacing: (ojoSep * 2 - ojoAn) * r) {
      ojo(r: r, escalaY: pb)
      ojo(r: r, escalaY: pb)
    }
    .offset(x: mx * r, y: my * r)
  }

  private static func ojo(r: CGFloat, escalaY: Double) -> some View {
    Capsule()
      .fill(Color(white: Double(0x14) / 255))
      .frame(width: ojoAn * r, height: ojoAl * r)
      .scaleEffect(y: escalaY)
  }

  // ── Curvas (réplica de los keyframes del CSS) ─────────────────────────────
  private static func bezier(_ p1x: Double, _ p1y: Double,
                             _ p2x: Double, _ p2y: Double, _ t: Double) -> Double {
    var lo = 0.0, hi = 1.0
    for _ in 0..<20 {
      let u = (lo + hi) / 2, v = 1 - u
      let x = 3 * v * v * u * p1x + 3 * v * u * u * p2x + u * u * u
      if x < t { lo = u } else { hi = u }
    }
    let u = (lo + hi) / 2, v = 1 - u
    return 3 * v * v * u * p1y + 3 * v * u * u * p2y + u * u * u
  }

  private static func tramo(_ paradas: [(Double, Double, Double)], _ t: Double,
                            _ ease: (Double) -> Double) -> (Double, Double) {
    for k in 0..<(paradas.count - 1) {
      let a = paradas[k], b = paradas[k + 1]
      if t >= a.0 && t <= b.0 {
        let span = b.0 - a.0
        let u = span == 0 ? 0 : (t - a.0) / span
        let e = ease(u)
        return (a.1 + (b.1 - a.1) * e, a.2 + (b.2 - a.2) * e)
      }
    }
    let u = paradas[paradas.count - 1]
    return (u.1, u.2)
  }

  /// keyframes `mirar`. Y hacia abajo, igual que `offset` de SwiftUI.
  private static func mirada(_ t: Double) -> (Double, Double) {
    tramo([(0.0, 0.0, -0.2), (0.26, 0.0, -0.2), (0.315, 0.28, -0.3),
           (0.41, 0.274, -0.312), (0.47, 0.0, -0.2), (1.0, 0.0, -0.2)],
          t) { bezier(0.38, 0.03, 0.24, 1.0, $0) }
  }

  /// keyframes `parpadeo` (escala vertical del ojo).
  private static func parpadeo(_ t: Double) -> Double {
    tramo([(0.0, 1.0, 0), (0.15, 1.0, 0), (0.16, ojoCerrado, 0), (0.17, 1.0, 0),
           (0.645, 1.0, 0), (0.673, ojoCerrado, 0), (0.70, ojoCerrado, 0),
           (0.725, 1.0, 0), (1.0, 1.0, 0)],
          t) { bezier(0.42, 0.0, 0.58, 1.0, $0) }.0
  }
}
