import SwiftUI

/// El contenedor existe para transportar la app del reloj, no para hacer
/// nada. Muestra el estado para que, si el reloj no la ofrece, se sepa al
/// menos que el iPhone sí la instaló.
struct ContentView: View {
  var body: some View {
    VStack(spacing: 12) {
      Text("Hola")
        .font(.largeTitle)
        .fontWeight(.semibold)
      Text("Esta app de iPhone lleva dentro la del reloj.\nBúscala en la app Watch → Apps disponibles.")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding()
  }
}

#Preview {
  ContentView()
}
