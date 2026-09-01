import WidgetKit
import SwiftUI

/// Complicación de OS: un acceso directo en la esfera.
///
/// No muestra datos, solo abre la app. Por eso la línea de tiempo trae UNA
/// entrada con política `.never`: pedirle a watchOS que refresque algo que
/// nunca cambia gastaría presupuesto de actualización para nada.
struct Entrada: TimelineEntry {
  let date: Date
}

struct Proveedor: TimelineProvider {
  func placeholder(in contexto: Context) -> Entrada { Entrada(date: .now) }

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
        // Sin el fondo del sistema la complicación flota sin el disco que la
        // separa de la esfera, y en esferas claras se pierde.
        AccessoryWidgetBackground()
        orbe.padding(2)
      }

    case .accessoryCorner:
      orbe.padding(1)

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

  /// El PNG va a 120×120 y no más: ese es el tope que watchOS impone a las
  /// imágenes de `accessoryCircular`. Por encima no las dibuja y cae a un
  /// glifo genérico, sin dar ningún error — que es exactamente como se ve el
  /// fallo, y por qué no apunta a la causa.
  private var orbe: some View {
    Image("orbe-icono")
      .resizable()
      .scaledToFit()
      // Sin esto, en las esferas teñidas sale como silueta plana y pierde
      // justo lo que lo hace reconocible.
      .widgetAccentable()
  }
}

@main
struct ComplicacionOS: Widget {
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
