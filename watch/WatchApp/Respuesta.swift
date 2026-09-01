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
            Text(texto)
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


/// El orbe girando: es el "cargando".
///
/// Un spinner del sistema en esta pantalla se lee como "el aparato está
/// esperando". El orbe girando se lee como "está pensando", que es lo que de
/// verdad ocurre — y de paso mantiene en pantalla al mismo personaje en vez de
/// cambiarlo por un widget genérico.
struct OrbeCargando: View {
  /// Una vuelta cada 0,7 s. Más lento parece que se ha colgado; más rápido
  /// deja de leerse como un giro y se convierte en parpadeo.
  private static let vuelta = 0.7

  var body: some View {
    TimelineView(.animation) { t in
      let s = t.date.timeIntervalSinceReferenceDate
      let i = Int(s * 30) % 211
      let giro = (s.truncatingRemainder(dividingBy: Self.vuelta) / Self.vuelta) * 360
      // El bote va al DOBLE del giro: toca suelo en cada media vuelta, que es
      // cuando el orbe se ve de perfil. Sincronizados se lee como un salto;
      // desfasados parecen dos animaciones distintas peleándose.
      let bote = -abs(sin(s * .pi / (Self.vuelta / 2))) * 7

      Image(String(format: "orbe-%03d", i))
        .resizable()
        .scaledToFit()
        .frame(width: 64, height: 64)
        .rotation3DEffect(.degrees(giro), axis: (x: 0, y: 1, z: 0))
        .offset(y: bote)
    }
  }
}
