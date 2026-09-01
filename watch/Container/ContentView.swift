import SwiftUI

/// La app del iPhone ES el Laboratorio.
///
/// Antes era un contenedor con una pantalla explicativa: existía solo para
/// llevar dentro la app del reloj (watchOS lo exige). Sigue llevándola, pero
/// ahora además hace algo.
struct ContentView: View {
  var body: some View {
    LabView()
  }
}

#Preview {
  ContentView()
}
