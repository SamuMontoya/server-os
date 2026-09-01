import SwiftUI
import AVKit
import AVFoundation   // AVKit trae VideoPlayer; AVPlayer vive aquí
import WatchKit

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

  private static let saltoDur = Salto.duracion   // 1,6 s
  private static let sacudidaDur = 0.75

  // `isLuminanceReduced` es el modo siempre-encendido: la pantalla atenuada.
  // Es la señal exacta de "el reloj está en reposo" — no hay que inventar
  // temporizadores ni escuchar el giro de muñeca.
  @Environment(\.isLuminanceReduced) private var atenuada
  @State private var saltoDesde: Date?
  @State private var sacudidaDesde: Date?
  @State private var paso: Paso?
  @State private var respuesta = ""
  @State private var imagen: URL?
  @State private var corriendo = false
  @State private var enRespuesta = false
  /// Volumen de la voz, movido con el dial. Arranca del valor guardado para
  /// que no se reinicie cada vez que se abre la app.
  @State private var volumen = Double(Voz.compartida.volumen)
  @State private var mostrarVolumen = false
  @FocusState private var dialActivo: Bool

  var body: some View {
    if enRespuesta {
      Respuesta(paso: paso, texto: respuesta, imagen: imagen, corriendo: corriendo) {
        // UN solo toque: vuelve al orbe y abre el dictado de una. Antes hacían
        // falta dos (uno para volver, otro para dictar), que en la muñeca es
        // un toque de más para lo que siempre quieres hacer a continuación.
        // El turno anterior no se cancela: es un trabajo del servidor.
        enRespuesta = false
        tocar()
      }
    } else {
      orbe
    }
  }

  /// El toque abre el dictado EN EL ACTO y lanza el salto a la vez. El salto
  /// se deja disparado igual: al volver del dictado (o al cancelarlo) todavía
  /// alcanza a verse, y esperar a que terminara metía 1,6 s de retraso entre
  /// tocar y poder hablar.
  private func tocar() {
    saltoDesde = Date()
    // El texto dictado no se pinta: el "Listo" del dictado del sistema ya
    // cierra el gesto, y una pantalla más encima sobra. Aquí es donde irá el
    // envío al agente cuando el reloj hable con el servidor.
    Dictado.pedir { dicho in
      saltoDesde = nil
      guard let dicho else { return }
      paso = nil
      respuesta = ""
      imagen = nil
      Voz.compartida.callar()   // una pregunta nueva calla la anterior
      corriendo = true
      enRespuesta = true
      Task {
        await Agente.preguntar(dicho) { ev in
          Task { @MainActor in
            switch ev {
            case .texto(let t):
              // Vibra en la PRIMERA palabra, no al terminar: en un reloj lo
              // valioso es poder bajar el brazo y que te avise cuando ya hay
              // algo que leer. Solo la primera, o cada delta vibraría.
              if respuesta.isEmpty { WKInterfaceDevice.current().play(.notification) }
              // Al llegar texto el paso desaparece: la respuesta va sola.
              paso = nil
              respuesta += t
              // Se habla lo MISMO que se pinta, ya sin markdown: si no, la
              // voz lee "asterisco asterisco" en cada énfasis que se escape.
              Voz.compartida.alLlegar(sinMarcas(t))
            case .imagen(let u):
              imagen = u
              WKInterfaceDevice.current().play(.notification)
            case .escala:
              // La vía rápida no bastó. Se limpia lo que hubiera dicho y a
              // partir de aquí se ven los pasos del turno completo.
              respuesta = ""
            case .paso(let n, let o):
              // Reemplaza, no acumula: solo interesa lo que está haciendo AHORA.
              withAnimation(.easeInOut(duration: 0.18)) {
                paso = Paso(nombre: n, objetivo: o)
              }
            case .fin:
              corriendo = false
              Voz.compartida.cerrar()
            case .fallo(let m):
              corriendo = false
              WKInterfaceDevice.current().play(.failure)
              if respuesta.isEmpty { respuesta = m }
            }
          }
        }
      }
    }
  }

  private var orbe: some View {
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
      .onTapGesture(perform: tocar)
      .overlay(alignment: .trailing) {
        if mostrarVolumen { indicadorVolumen }
      }
    }
    .ignoresSafeArea()
    // El dial va AQUÍ y no en la pantalla de respuesta: allí lo usa el
    // ScrollView para desplazar el texto, y dos cosas peleando por el mismo
    // mando se sienten rotas. En el orbe está libre.
    .focusable(true)
    .focused($dialActivo)
    .digitalCrownRotation($volumen, from: 0, through: 1, by: 0.05,
                          sensitivity: .medium, isContinuous: false,
                          isHapticFeedbackEnabled: true)
    .onAppear { dialActivo = true }
    .onChange(of: volumen) { _, v in
      Voz.compartida.volumen = Float(v)
      mostrarVolumen = true
      // Se esconde solo: un indicador permanente tapa el orbe, que es lo que
      // se quiere ver.
      Task {
        try? await Task.sleep(for: .seconds(1.2))
        mostrarVolumen = false
      }
    }
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

  /// Barra de volumen junto al dial, del lado en el que está la corona.
  private var indicadorVolumen: some View {
    VStack(spacing: 3) {
      Image(systemName: volumen == 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
        .font(.system(size: 11))
      Capsule()
        .fill(Color(white: 0.85))
        .frame(width: 4, height: 54)
        .overlay(alignment: .bottom) {
          Capsule()
            .fill(Color(white: 0.15))
            .frame(width: 4, height: max(4, 54 * volumen))
        }
    }
    .foregroundStyle(Color(white: 0.15))
    .padding(.trailing, 4)
    .transition(.opacity)
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
    return Salto.en(ahora.timeIntervalSince(desde))
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
