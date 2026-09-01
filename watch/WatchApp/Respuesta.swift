import SwiftUI

/// Un paso del agente: qué hizo y sobre qué.
struct Paso: Identifiable {
  let id = UUID()
  let nombre: String
  let objetivo: String

  /// Icono y verbo por tool. Las `mcp__hermes__x` caen al genérico a
  /// propósito: son decenas, y en una pantalla de reloj el nombre exacto no
  /// aporta nada que el verbo no diga ya.
  var simbolo: String {
    switch base {
    case "Read": "doc.text"
    case "Write": "square.and.pencil"
    case "Edit", "MultiEdit": "pencil"
    case "Bash": "terminal"
    case "Grep": "magnifyingglass"
    case "Glob", "LS": "folder"
    case "WebFetch", "WebSearch": "globe"
    case "Task": "bolt"
    default: "sparkles"
    }
  }

  var verbo: String {
    switch base {
    case "Read": "Leyó"
    case "Write": "Escribió"
    case "Edit", "MultiEdit": "Editó"
    case "Bash": "Ejecutó"
    case "Grep": "Buscó"
    case "Glob", "LS": "Listó"
    case "WebFetch", "WebSearch": "Consultó"
    case "Task": "Delegó"
    default: "Usó"
    }
  }

  /// `mcp__hermes__save_memory` → `save_memory`, que es lo único legible.
  private var base: String {
    nombre.contains("__") ? String(nombre.split(separator: "_").last ?? "") : nombre
  }
}

/// La pantalla de respuesta.
///
/// Muestra UNA cosa a la vez: mientras trabaja, solo el paso EN CURSO; cuando
/// llega la respuesta, solo el texto. En una pantalla de reloj apilar el
/// historial de pasos lo vuelve ilegible, y los pasos ya cumplidos no le
/// sirven a nadie una vez hay respuesta.
/// Quita el markdown del texto.
///
/// El prompt ya le pide al modelo que no lo use, pero pedirlo no basta: se le
/// escapa un `**` cada tantas respuestas y en un reloj eso se lee como basura,
/// no como énfasis. Limpiarlo aquí es la única garantía, y es barato.
///
/// No se convierte a texto con formato a propósito: en una pantalla de 40 mm
/// la negrita no aporta jerarquía, solo ruido.
func sinMarcas(_ t: String) -> String {
  var r = t
  for m in ["**", "__", "`", "*", "_", "#"] {
    r = r.replacingOccurrences(of: m, with: "")
  }
  // Viñetas al principio de línea: el modelo las cuela aunque se le pida una
  // sola frase, y dejan el texto empezando por un guion suelto.
  r = r.split(separator: "\n")
    .map { linea -> String in
      var l = linea.trimmingCharacters(in: .whitespaces)
      while l.hasPrefix("- ") || l.hasPrefix("• ") { l = String(l.dropFirst(2)) }
      return l
    }
    .joined(separator: " ")
  return r.trimmingCharacters(in: .whitespacesAndNewlines)
}

struct Respuesta: View {
  let paso: Paso?
  let texto: String
  let corriendo: Bool
  let alTocar: () -> Void

  fileprivate static let tinta = Color(red: 0x37 / 255, green: 0x35 / 255, blue: 0x2f / 255)

  var body: some View {
    GeometryReader { geo in
      ScrollView {
        VStack(spacing: 6) {
          if !texto.isEmpty {
            Text(sinMarcas(texto))
              .font(.system(size: 16))
              .lineSpacing(4)
              .foregroundStyle(Self.tinta)
              .multilineTextAlignment(.center)
          } else if let paso {
            vistaPaso(paso)
          } else if corriendo {
            OrbeCargando()
          } else {
            // Terminó sin texto ni paso. Antes esto dejaba la pantalla en
            // blanco, que no dice si falló o si simplemente no contestó.
            Text("Sin respuesta")
              .font(.system(size: 14))
              .foregroundStyle(Self.tinta.opacity(0.45))
          }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.vertical, 14)
        // Centrado real: lo corto queda a media pantalla y lo largo crece y
        // hace scroll.
        .frame(minHeight: geo.size.height, alignment: .center)
      }
    }
    .background(Color.white)
    .ignoresSafeArea()
    .contentShape(Rectangle())
    .onTapGesture(perform: alTocar)
  }

  @ViewBuilder
  private func vistaPaso(_ p: Paso) -> some View {
    VStack(spacing: 3) {
      Image(systemName: p.simbolo)
        .font(.system(size: 17))
        .foregroundStyle(Self.tinta)

      Text(p.verbo)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(Self.tinta)

      if !p.objetivo.isEmpty {
        // Una sola línea cortada por el medio: un comando largo partido en
        // tres líneas se come la pantalla y no se lee mejor.
        Text(p.objetivo)
          .font(.system(size: 11))
          .foregroundStyle(Self.tinta.opacity(0.5))
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .transition(.opacity)
    .id(p.id)
  }
}


/// El "cargando": el orbe dando mortales hacia atrás.
///
/// Un ProgressView del sistema se lee como "el aparato está esperando". Esto
/// se lee como "está pensando", y mantiene en pantalla al mismo personaje en
/// vez de cambiarlo por un widget genérico a mitad de la interacción.
///
/// No es una animación inventada: usa el MISMO salto medido del vídeo que
/// dispara el toque (`Salto`), con su impulso, su estirado en el aire y su
/// achatamiento al caer. Lo único que se añade es la vuelta. Por eso se
/// mueve como el orbe y no como un icono girando.
struct OrbeCargando: View {
  /// Pausa entre saltos: el tiempo de tomar impulso otra vez. Sin ella el
  /// orbe gira sin parar y deja de leerse como saltos encadenados.
  private static let pausa = 0.18
  private static var ciclo: Double { Salto.duracion + pausa }

  private static let lado: CGFloat = 64
  /// El lienzo horneado mide 1,2 diámetros, así que el radio del orbe dentro
  /// de la imagen es la mitad de eso entre 1,2.
  private static let radio: CGFloat = lado / 2 / 1.2

  /// Grados de vuelta según la fracción de salto recorrida. La rotación va
  /// SOLO mientras está en el aire y completa los 360º justo al aterrizar:
  /// girar con el orbe en el suelo se vería como un patinazo.
  private static func giro(en p: Double) -> Double {
    if p <= Salto.aire.inicio { return 0 }
    if p >= Salto.aire.fin { return 360 }
    let u = (p - Salto.aire.inicio) / (Salto.aire.fin - Salto.aire.inicio)
    // Suavizado a la entrada y la salida: una rampa lineal arranca y frena de
    // golpe, y eso rompe la sensación de peso.
    return u * u * (3 - 2 * u) * 360
  }

  var body: some View {
    TimelineView(.animation) { t in
      let s = t.date.timeIntervalSinceReferenceDate
      let dt = s.truncatingRemainder(dividingBy: Self.ciclo)
      let m = Salto.en(dt)
      let giro = Self.giro(en: dt / Salto.duracion)
      let i = Int(s * 30) % 211

      ZStack {
        Image(String(format: "orbe-%03d", i))
          .resizable()
          .scaledToFit()
          .frame(width: Self.lado, height: Self.lado)
          // Negativo = hacia ATRÁS. En positivo la mortal sale hacia adelante,
          // que se lee como voltereta de caída y no como impulso.
          .rotation3DEffect(.degrees(-giro), axis: (x: 1, y: 0, z: 0))

        Self.ojos(giro: giro)
      }
      .scaleEffect(x: m.sx, y: m.sy)
      .offset(y: (m.dy / 1.031496) * 32)
    }
  }

  /// Dónde cae un punto de la superficie tras girar la esfera `th` radianes
  /// sobre el eje horizontal. Va aparte porque en línea el compilador de
  /// SwiftUI no termina de inferir tipos en un tiempo razonable.
  private static func puntoEnEsfera(x0: CGFloat, y0: CGFloat, r: CGFloat,
                                    th: Double) -> (y: CGFloat, escorzo: CGFloat, visible: Bool) {
    // Profundidad en reposo: el ojo está en la SUPERFICIE, no en el centro.
    let dentro = r * r - x0 * x0 - y0 * y0
    let z0: CGFloat = dentro > 0 ? dentro.squareRoot() : 0
    let c = CGFloat(cos(th))
    let sn = CGFloat(sin(th))
    let yp = y0 * c + z0 * sn
    let zp = -y0 * sn + z0 * c
    return (y: -yp, escorzo: max(zp / r, 0.001), visible: zp > 0)
  }

  /// Los ojos van sobre la SUPERFICIE de la esfera, no pegados a la imagen.
  ///
  /// Rotar el sprite con los ojos dentro los aplanaría contra el disco y la
  /// mortal se vería como una carta girando. Aquí cada ojo es un punto en la
  /// esfera que se rota de verdad: sube, se achata al acercarse al canto,
  /// desaparece cuando pasa a la cara de atrás (z < 0) y vuelve por abajo. Ese
  /// ir y venir es lo que hace que se lea como un volumen.
  @ViewBuilder
  private static func ojos(giro: Double) -> some View {
    let r = radio
    let th = -giro * .pi / 180          // el mismo sentido que el cuerpo
    // Posición en reposo, tomada del CSS del orbe web.
    let y0 = 0.2 * r                    // hacia arriba
    let x0 = 0.185 * r
    let ancho = 0.092 * r
    let alto = 0.185 * r

    let p = puntoEnEsfera(x0: x0, y0: y0, r: r, th: th)

    ForEach([-1.0, 1.0], id: \.self) { signo in
      Capsule()
        .fill(Color(white: Double(0x14) / 255))
        .frame(width: ancho, height: alto)
        // Escorzo: de frente se ve entero, de canto se aplasta a nada.
        .scaleEffect(y: p.escorzo)
        .offset(x: signo * x0, y: p.y)
        // Detrás de la esfera no se ve. Sin este corte los ojos seguirían
        // pintándose sobre el cuerpo cuando deberían estar ocultos, y la
        // mortal perdería justo el efecto que la hace parecer 3D.
        .opacity(p.visible ? 1 : 0)
    }
  }
}
