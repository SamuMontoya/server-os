import SwiftUI

/// La base y nada más: abre y saluda. Lo que se está probando aquí no es el
/// código, es si una app sideloaded llega a instalarse en el reloj.
struct ContentView: View {
  var body: some View {
    VStack(spacing: 6) {
      Text("Hola")
        .font(.title2)
        .fontWeight(.semibold)
      Text("Hermes")
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
  }
}

#Preview {
  ContentView()
}
