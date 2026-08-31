import SwiftUI
import AVKit
import AVFoundation   // AVKit trae VideoPlayer; AVPlayer vive aquí

/// El Orbe IA en el reloj.
///
/// ARQUITECTURA: el cuerpo y los ojos van SEPARADOS, igual que en la web
/// (allá el cuerpo es un shader y los ojos son nodos del DOM). El cuerpo son
/// 211 fotogramas horneados por `scripts/hornear-orbe.py` desde los mismos
/// assets (`pelicula.webp` + `movimiento.json`); los ojos se dibujan aquí.
///
/// Se hornean ESTABILIZADOS y SIN ojos a propósito. Con todo horneado junto
/// no habría forma de cerrar los ojos al dormir, ni de sacudir la cabeza, ni
/// de separar el salto del bucle — que es justo lo que se pide.
struct ContentView: View {
  // ── Cuerpo ────────────────────────────────────────────────────────────────
  private static let n = 211
  private static let fps: Double = 30            // META.fps de la web
  private static let cuadros = (0..<n).map { String(format: "orbe-%03d", $0) }
  private static let bucle = Double(n) / fps     // 7,0333 s
  private static let asp = 1.031496

  /// El lienzo horneado mide 1,2 diámetros (margen para la fase de estirado).
  /// Para que el ORBE ocupe el 80%, la imagen va a 1,2 × 0,8 — poner la imagen
  /// al 80% dejaría el orbe al 67%.
  private static let ladoOrbe = 0.8
  private static let margenLienzo = 1.2

  // ── Ojos, en radios (del CSS: --ojo-an .092, --ojo-al .185, gap .278) ─────
  private static let ojoAncho = 0.092
  private static let ojoAlto = 0.185
  private static let ojoSepX = 0.185             // gap/2 + ancho/2
  private static let ojoCerrado = 0.497          // parpadeo normal
  private static let ojoDormido = 0.07           // dormido: una línea

  // ── Salto (movimiento.json, fotogramas 126-174, normalizado al reposo) ────
  private struct Mov { let dx, dy, sx, sy: Double }
  private static func C(_ a: Double, _ b: Double, _ c: Double, _ d: Double) -> Mov {
    Mov(dx: a, dy: b, sx: c, sy: d)
  }
  private static let salto: [Mov] = [
    C(+0.0000,+0.0000,1.0000,1.0000), C(+0.0076,+0.0079,1.0075,0.9916), C(+0.0000,+0.0079,1.0148,0.9916), C(+0.0076,+0.0157,1.0222,0.9831),
    C(+0.0076,+0.0157,1.0222,0.9831), C(+0.0076,+0.0157,1.0222,0.9831), C(+0.0076,+0.0079,1.0222,0.9916), C(+0.0153,-0.0236,1.0148,1.0085),
    C(+0.0153,-0.0866,0.9852,1.0255), C(+0.0229,-0.1732,0.9630,1.0509), C(+0.0229,-0.2362,0.9482,1.0848), C(+0.0229,-0.2756,0.9333,1.1102),
    C(+0.0229,-0.2913,0.9186,1.1271), C(+0.0229,-0.2913,0.9186,1.1271), C(+0.0229,-0.2913,0.9186,1.1271), C(+0.0229,-0.2992,0.9186,1.1187),
    C(+0.0153,-0.3150,0.9260,1.1017), C(+0.0153,-0.2992,0.9260,1.0678), C(+0.0153,-0.2677,0.9408,1.0339), C(+0.0153,-0.2205,0.9556,1.0000),
    C(+0.0153,-0.1417,0.9852,0.9661), C(+0.0153,-0.0236,1.0297,0.9407), C(+0.0076,+0.0709,1.0519,0.9238), C(+0.0000,+0.0866,1.0593,0.9238),
    C(+0.0076,+0.0236,0.9926,1.0085), C(+0.0076,-0.0236,0.9482,1.0424), C(+0.0076,-0.0630,0.9333,1.0678), C(+0.0076,-0.0945,0.9186,1.0848),
    C(+0.0153,-0.1260,0.9111,1.0848), C(+0.0153,-0.1575,0.9260,1.0678), C(+0.0076,-0.1890,0.9482,1.0509), C(+0.0153,-0.2047,0.9556,1.0339),
    C(+0.0153,-0.2205,0.9704,1.0170), C(+0.0153,-0.1890,0.9704,1.0170), C(+0.0076,-0.1339,0.9778,1.0255), C(+0.0153,-0.0866,0.9852,1.0424),
    C(+0.0153,-0.0394,0.9852,1.0594), C(+0.0153,-0.0236,0.9852,1.0594), C(+0.0229,-0.0236,0.9778,1.0594), C(+0.0076,-0.0315,0.9778,1.0678),
    C(+0.0000,-0.0394,0.9704,1.0763), C(+0.0000,-0.0551,0.9704,1.0932), C(+0.0000,-0.0551,0.9704,1.0932), C(-0.0076,-0.0630,0.9630,1.1017),
    C(-0.0076,-0.0630,0.9630,1.1017), C(-0.0076,-0.0630,0.9630,1.1017), C(-0.0076,-0.0630,0.9630,1.1017), C(-0.0076,-0.0630,0.9630,1.1017),
  ]
  private static let saltoDur = Double(salto.count) / fps   // 1,6 s
  private static let sacudidaDur = 0.75

  // `isLuminanceReduced` es el modo siempre-encendido: la pantalla atenuada.
  // Es la señal exacta de "el reloj está en reposo" — no hay que inventar
  // temporizadores ni escuchar el giro de muñeca.
  @Environment(\.isLuminanceReduced) private var atenuada
  @State private var saltoDesde: Date?
  @State private var sacudidaDesde: Date?

  var body: some View {
    GeometryReader { geo in
      let lienzo = min(geo.size.width, geo.size.height) * Self.ladoOrbe * Self.margenLienzo
      let r = lienzo / 2 / Self.margenLienzo          // radio del orbe en puntos

      ZStack {
        Color.white

        TimelineView(.animation) { contexto in
          let ahora = contexto.date
          let t = ahora.timeIntervalSinceReferenceDate

          // Dormido: el cuerpo se congela. Un orbe con los ojos cerrados pero
          // el anillo girando no se lee como dormido, se lee como roto.
          let i = atenuada ? 0 : Int(t * Self.fps) % Self.n
          let fase = (t.truncatingRemainder(dividingBy: Self.bucle)) / Self.bucle

          let m = Self.movDeSalto(ahora: ahora, desde: saltoDesde)
          let sac = Self.sacudida(ahora: ahora, desde: sacudidaDesde)

          ZStack {
            Image(Self.cuadros[i])
              .resizable()
              .interpolation(.high)
              .scaledToFit()
              .frame(width: lienzo, height: lienzo)

            Self.ojos(r: r, fase: fase, dormido: atenuada)
          }
          // El salto se aplica al conjunto (cuerpo + ojos) porque en la web
          // también van juntos: el shader mueve el cuerpo y el CSS mueve los
          // ojos con la MISMA transformada.
          .scaleEffect(x: m.sx, y: m.sy)
          .offset(x: (m.dx * r) + sac, y: (m.dy / Self.asp) * r)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .contentShape(Rectangle())
      .onTapGesture { saltoDesde = Date() }
    }
    .ignoresSafeArea()
    .onChange(of: atenuada) { _, ahoraAtenuada in
      // Al despertar sacude la cabeza. Al dormirse no se hace nada: la
      // pantalla ya se está apagando y nadie lo vería.
      if !ahoraAtenuada { sacudidaDesde = Date() }
    }
    // watchOS NO expone forma de ocultar la hora ni el indicador de Modo
    // enfoque: `.statusBarHidden()` no existe en esta plataforma. Con un
    // VideoPlayer en pantalla el sistema la esconde solo, así que se deja uno
    // invisible de fondo. Es un truco apoyado en un comportamiento del
    // sistema, no en una API: si watchOS lo cambia, vuelve a salir la hora y
    // no se rompe nada más.
    .background(
      VideoPlayer(player: AVPlayer())
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    )
  }

  // ── Ojos ───────────────────────────────────────────────────────────────────

  @ViewBuilder
  private static func ojos(r: CGFloat, fase: Double, dormido: Bool) -> some View {
    let (mx, my) = dormido ? (0.0, -0.2) : mirada(fase)
    let pb = dormido ? ojoDormido : parpadeo(fase)
    HStack(spacing: (ojoSepX * 2 - ojoAncho) * r) {
      ojo(r: r, escalaY: pb)
      ojo(r: r, escalaY: pb)
    }
    .offset(x: mx * r, y: my * r)
  }

  private static func ojo(r: CGFloat, escalaY: Double) -> some View {
    Capsule()
      .fill(Color(white: Double(0x14) / 255))
      .frame(width: ojoAncho * r, height: ojoAlto * r)
      .scaleEffect(y: escalaY)
  }

  // ── Curvas (réplica de los keyframes CSS) ─────────────────────────────────

  /// cubic-bezier de CSS: resuelve x(u)=t por bisección y evalúa y(u).
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

  private static func tramo(_ paradas: [(Double, Double, Double)],
                            _ t: Double,
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

  /// keyframes `mirar` del CSS. Y hacia abajo, igual que `offset` de SwiftUI.
  private static func mirada(_ t: Double) -> (Double, Double) {
    tramo([(0.0, 0.0, -0.2), (0.26, 0.0, -0.2), (0.315, 0.28, -0.3),
           (0.41, 0.274, -0.312), (0.47, 0.0, -0.2), (1.0, 0.0, -0.2)],
          t) { bezier(0.38, 0.03, 0.24, 1.0, $0) }
  }

  /// keyframes `parpadeo` del CSS (escala vertical del ojo).
  private static func parpadeo(_ t: Double) -> Double {
    tramo([(0.0, 1.0, 0), (0.15, 1.0, 0), (0.16, ojoCerrado, 0), (0.17, 1.0, 0),
           (0.645, 1.0, 0), (0.673, ojoCerrado, 0), (0.70, ojoCerrado, 0),
           (0.725, 1.0, 0), (1.0, 1.0, 0)],
          t) { bezier(0.42, 0.0, 0.58, 1.0, $0) }.0
  }

  // ── Salto y sacudida ──────────────────────────────────────────────────────

  private static func movDeSalto(ahora: Date, desde: Date?) -> Mov {
    guard let desde else { return Mov(dx: 0, dy: 0, sx: 1, sy: 1) }
    let dt = ahora.timeIntervalSince(desde)
    guard dt >= 0, dt < saltoDur else { return Mov(dx: 0, dy: 0, sx: 1, sy: 1) }

    let f = dt * fps
    let i0 = min(Int(f), salto.count - 1)
    let i1 = min(i0 + 1, salto.count - 1)
    let k = f - Double(i0)
    let a = salto[i0], b = salto[i1]

    // Los datos medidos NO acaban en reposo (quedan en dy=-0,063, sy=1,10):
    // sin esta envolvente el orbe daría un tirón al terminar. Aterriza en el
    // último 35% de la secuencia.
    let p = dt / saltoDur
    let cierre = p < 0.65 ? 1.0 : 1.0 - (p - 0.65) / 0.35
    let suave = cierre * cierre * (3 - 2 * cierre)

    return Mov(dx: (a.dx + (b.dx - a.dx) * k) * suave,
               dy: (a.dy + (b.dy - a.dy) * k) * suave,
               sx: 1 + ((a.sx + (b.sx - a.sx) * k) - 1) * suave,
               sy: 1 + ((a.sy + (b.sy - a.sy) * k) - 1) * suave)
  }

  /// Sacudida de cabeza al despertar: oscilación horizontal que se apaga sola.
  private static func sacudida(ahora: Date, desde: Date?) -> CGFloat {
    guard let desde else { return 0 }
    let dt = ahora.timeIntervalSince(desde)
    guard dt >= 0, dt < sacudidaDur else { return 0 }
    let caida = 1 - dt / sacudidaDur
    return CGFloat(sin(dt * 2 * .pi * 3.2) * 9 * caida * caida)
  }
}

#Preview {
  ContentView()
}
