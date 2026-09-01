import SwiftUI
import WidgetKit

@main
struct HermesWatchApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
        // watchOS cachea las complicaciones con ganas: tras reinstalar puede
        // seguir pintando la versión anterior durante horas. Pedir el refresco
        // al abrir la app es la forma soportada de forzarlo.
        .onAppear { WidgetCenter.shared.reloadAllTimelines() }
    }
  }
}
