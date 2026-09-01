import SwiftUI

/// La pantalla de chats, equivalente a `LabChatsScreen.tsx`.
///
/// Aquí SÍ se usa `List` con `.swipeActions` en vez de reimplementar el gesto
/// a mano como en la web: allá hubo que construirlo (el DOM no lo trae),
/// aquí es nativo, se siente como el resto del sistema y trae gratis la
/// háptica y el deshacer visual. Copiar la implementación de la web habría
/// sido peor producto por fidelidad mal entendida.
struct ChatsView: View {
  @ObservedObject var modelo: LabModelo
  @Environment(\.dismiss) private var cerrar

  private static let tinta = Color(red: 0x37 / 255, green: 0x35 / 255, blue: 0x2f / 255)

  var body: some View {
    NavigationStack {
      List {
        ForEach(modelo.chats.sorted { $0.actualizado > $1.actualizado }) { c in
          Button { modelo.abrirChat(c.id) } label: {
            HStack(spacing: 10) {
              VStack(alignment: .leading, spacing: 3) {
                Text(c.titulo)
                  .font(.system(size: 16, weight: c.id == modelo.activoId ? .semibold : .regular))
                  .foregroundStyle(Self.tinta)
                  .lineLimit(1)
                Text(cuando(c.actualizado))
                  .font(.system(size: 12))
                  .foregroundStyle(Self.tinta.opacity(0.45))
              }
              Spacer(minLength: 0)
              // Punto verde: este chat tiene un turno corriendo. Es lo que
              // permite salirse de un chat largo sin miedo a perderlo.
              if c.corriendo || c.pendiente != nil {
                Circle().fill(Color.green).frame(width: 7, height: 7)
              }
            }
            .contentShape(Rectangle())
          }
          .swipeActions(edge: .trailing) {
            Button(role: .destructive) { modelo.borrarChat(c.id) } label: {
              Label("Borrar", systemImage: "trash")
            }
          }
        }
      }
      .listStyle(.plain)
      .navigationTitle("Chats")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cerrar") { cerrar() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            modelo.crearChat()
            cerrar()
          } label: {
            Image(systemName: "plus")
          }
        }
      }
    }
  }

  /// "hace 5 min", "ayer"… Una fecha completa en una lista no dice nada útil.
  private func cuando(_ d: Date) -> String {
    let f = RelativeDateTimeFormatter()
    f.locale = Locale(identifier: "es")
    f.unitsStyle = .short
    return f.localizedString(for: d, relativeTo: Date())
  }
}
