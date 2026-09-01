import WidgetKit
import SwiftUI

/// DOS complicaciones, no una con el icono cambiado: así puedes elegir en la
/// esfera cuál te queda mejor sin reinstalar, y watchOS cachea cada una por su
/// `kind` — cambiar el icono de una existente se queda pegado durante horas.
///
/// Ninguna muestra datos: solo abren la app. Por eso la línea de tiempo trae
/// UNA entrada con política `.never` — pedirle a watchOS que refresque algo que
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
  let icono: String

  var body: some View {
    switch familia {
    case .accessoryCircular:
      ZStack {
        // Sin el fondo del sistema la complicación flota sin el disco que la
        // separa de la esfera, y en esferas claras se pierde.
        AccessoryWidgetBackground()
        imagen.padding(3)
      }

    case .accessoryCorner:
      imagen.padding(2)

    case .accessoryRectangular:
      HStack(spacing: 6) {
        imagen.frame(width: 26, height: 26)
        Text("OS").font(.headline)
        Spacer(minLength: 0)
      }

    case .accessoryInline:
      // En línea watchOS solo admite texto y un símbolo: una imagen propia
      // aquí se ignora, así que no se intenta.
      Text("OS")

    default:
      imagen
    }
  }

  private var imagen: some View {
    Image(icono)
      .resizable()
      .scaledToFit()
      // Sin esto, en las esferas teñidas sale como silueta plana y pierde
      // justo lo que lo hace reconocible.
      .widgetAccentable()
  }
}

struct ComplicacionOrbe: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "com.samumontoya.hermes.complicacion",
                        provider: Proveedor()) { _ in
      VistaComplicacion(icono: "orbe-icono")
    }
    .configurationDisplayName("OS")
    .description("Abre OS y dicta.")
    .supportedFamilies([.accessoryCircular, .accessoryCorner,
                        .accessoryRectangular, .accessoryInline])
  }
}

struct ComplicacionAnillo: Widget {
  var body: some WidgetConfiguration {
    // `kind` DISTINTO del de la otra: es la identidad con la que watchOS la
    // guarda en la esfera. Repetirlo haría que una pisara a la otra.
    StaticConfiguration(kind: "com.samumontoya.hermes.complicacion.anillo",
                        provider: Proveedor()) { _ in
      VistaComplicacion(icono: "anillo-icono")
    }
    .configurationDisplayName("OS anillo")
    .description("Abre OS y dicta.")
    .supportedFamilies([.accessoryCircular, .accessoryCorner,
                        .accessoryRectangular, .accessoryInline])
  }
}

@main
struct PaqueteComplicaciones: WidgetBundle {
  var body: some Widget {
    ComplicacionOrbe()
    ComplicacionAnillo()
  }
}
