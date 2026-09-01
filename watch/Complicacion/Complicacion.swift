import WidgetKit
import SwiftUI

/// Complicación de Hermes: un acceso directo en la esfera del reloj.
///
/// No muestra datos, solo abre la app. Por eso la línea de tiempo trae UNA
/// entrada con política `.never`: pedirle a watchOS que refresque algo que
/// nunca cambia gastaría presupuesto de actualización para nada.
struct Entrada: TimelineEntry {
  let date: Date
}

struct Proveedor: TimelineProvider {
  func placeholder(in contexto: Context) -> Entrada {
    Entrada(date: .now)
  }

  func getSnapshot(in contexto: Context, completion: @escaping (Entrada) -> Void) {
    completion(Entrada(date: .now))
  }

  func getTimeline(in contexto: Context, completion: @escaping (Timeline<Entrada>) -> Void) {
    completion(Timeline(entries: [Entrada(date: .now)], policy: .never))
  }
}

struct VistaComplicacion: View {
  @Environment(\.widgetFamily) private var familia

  var body: some View {
    switch familia {
    case .accessoryCircular:
      ZStack {
        // El fondo del sistema: sin él la complicación flota sobre la esfera
        // sin el disco que la separa del fondo, y en esferas claras se pierde.
        AccessoryWidgetBackground()
        orbe.padding(3)
      }

    case .accessoryCorner:
      orbe.padding(2)

    case .accessoryRectangular:
      HStack(spacing: 6) {
        orbe.frame(width: 26, height: 26)
        Text("OS").font(.headline)
        Spacer(minLength: 0)
      }

    case .accessoryInline:
      // En línea watchOS solo admite texto y un símbolo: una imagen propia
      // aquí se ignora, así que no se intenta.
      Text("OS")

    default:
      orbe
    }
  }

  private var orbe: some View {
    Image("orbe-icono")
      .resizable()
      .scaledToFit()
      // Sin esto, en las esferas teñidas el orbe sale como una silueta plana
      // y pierde justo lo que lo hace reconocible.
      .widgetAccentable()
  }
}

@main
struct HermesComplicacion: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "com.samumontoya.hermes.complicacion",
                        provider: Proveedor()) { _ in
      VistaComplicacion()
    }
    .configurationDisplayName("OS")
    .description("Abre OS y dicta.")
    .supportedFamilies([.accessoryCircular, .accessoryCorner,
                        .accessoryRectangular, .accessoryInline])
  }
}
