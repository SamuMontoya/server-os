import SwiftUI

/// La pantalla de chats, calcada de `LabChatsScreen.tsx` y su CSS.
///
/// Layout de la web, no el de un sheet de iOS: X arriba a la derecha, el orbe
/// de 72px centrado debajo, el botón "Nuevo chat" a ancho completo, y las
/// tarjetas. No lleva barra de navegación ni título — el orbe ES el título.
struct ChatsView: View {
  @ObservedObject var modelo: LabModelo
  @Environment(\.dismiss) private var cerrar

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Spacer()
        Button { cerrar() } label: {
          Image(systemName: "xmark")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(LabView.glifo)
            .frame(width: 34, height: 34)
        }
      }

      Orbe(lado: 72)
        .padding(.top, 4)
        .padding(.bottom, 12)

      Button {
        modelo.crearChat()
        cerrar()
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
          Text("Chat nuevo")
        }
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(LabView.tinta)
        .frame(maxWidth: .infinity)
        .padding(10)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(hex: 0xE7E6E2)))
      }
      .padding(.bottom, 18)

      // List y no ScrollView+VStack: `.swipeActions` SOLO funciona dentro de
      // un List. Con un VStack compila igual y no hace absolutamente nada —
      // un fallo que no da ni un aviso. Las filas se desnudan (sin
      // separadores, sin inserciones, fondo transparente) para que la tarjeta
      // se vea exactamente como en la web.
      List {
        if modelo.chats.isEmpty {
          Text("Todavía no hay chats.")
            .font(.system(size: 13))
            .foregroundStyle(LabView.apagado)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 8, leading: 2, bottom: 8, trailing: 2))
            .listRowBackground(Color.clear)
        }
        ForEach(modelo.chats.sorted { $0.actualizado > $1.actualizado }) { c in
          tarjeta(c)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .environment(\.defaultMinListRowHeight, 0)
    }
    .padding(.horizontal, 20)
    .background(Color.white)
  }

  private func tarjeta(_ c: Chat) -> some View {
    let activo = c.id == modelo.activoId
    return Button { modelo.abrirChat(c.id) } label: {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(c.titulo)
            .font(.system(size: 14))
            .foregroundStyle(LabView.tinta)
            .lineLimit(1)
          Text(cuando(c.actualizado))
            .font(.system(size: 11.5))
            .foregroundStyle(LabView.apagado)
        }
        Spacer(minLength: 0)
        // Punto verde #2f9e6e: este chat tiene un turno corriendo. Es lo que
        // permite salirse de un chat largo sin miedo a perderlo.
        if c.corriendo || c.pendiente != nil {
          Circle().fill(Color(hex: 0x2F9E6E)).frame(width: 8, height: 8)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .background(activo ? Color(hex: 0xFAF9F7) : .white)
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10)
        .stroke(activo ? LabView.tinta : Color(hex: 0xEFEEEA)))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    // Deslizar para borrar, con el rojo #e35b4a del CSS. En la web hubo que
    // construir el gesto a mano porque el DOM no lo trae; aquí se compone con
    // el nativo, que trae la háptica y el rebote del sistema.
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button(role: .destructive) { modelo.borrarChat(c.id) } label: {
        Label("Borrar", systemImage: "trash")
      }
      .tint(Color(hex: 0xE35B4A))
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
