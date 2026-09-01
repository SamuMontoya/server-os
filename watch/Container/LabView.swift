import SwiftUI

/// El Laboratorio, nativo.
///
/// Tipografía y colores salen de `globals.css` del dashboard, no de un gusto
/// nuevo: `--font-notion` arranca en `-apple-system` (que en iOS ES la fuente
/// del sistema) y la tinta del cuerpo es #37352f.
struct LabView: View {
  @StateObject private var modelo = LabModelo()
  @FocusState private var escribiendo: Bool

  private static let tinta = Color(red: 0x37 / 255, green: 0x35 / 255, blue: 0x2f / 255)
  private static let suave = Color(red: 0xF7 / 255, green: 0xF6 / 255, blue: 0xF3 / 255)

  var body: some View {
    VStack(spacing: 0) {
      hilo
      composer
    }
    .background(Color.white)
    .task { await modelo.recuperarPendiente() }
  }

  // ── Hilo ──────────────────────────────────────────────────────────────────
  private var hilo: some View {
    ScrollViewReader { scroll in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if modelo.mensajes.isEmpty { vacio }
          ForEach(modelo.mensajes) { m in
            if m.mio { burbujaMia(m) } else { respuesta(m) }
          }
          Color.clear.frame(height: 1).id("fin")
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 12)
      }
      .onChange(of: modelo.marcaCambio) { _, _ in
        // Solo se sigue el final si el usuario YA estaba abajo. Arrastrarlo
        // hacia abajo mientras lee algo de arriba es de las cosas que más
        // molestan de un chat.
        if modelo.pegadoAbajo {
          withAnimation(.easeOut(duration: 0.2)) { scroll.scrollTo("fin", anchor: .bottom) }
        }
      }
    }
    .simultaneousGesture(DragGesture().onChanged { g in
      if g.translation.height > 12 { modelo.pegadoAbajo = false }
    })
  }

  private var vacio: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Laboratorio")
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(Self.tinta)
      Text("Escribe abajo. El turno vive en el servidor: puedes bloquear la pantalla y al volver sigue ahí.")
        .font(.system(size: 15))
        .lineSpacing(4)
        .foregroundStyle(Self.tinta.opacity(0.55))
    }
    .padding(.top, 40)
    .padding(.bottom, 12)
  }

  private func burbujaMia(_ m: Mensaje) -> some View {
    HStack {
      Spacer(minLength: 40)
      Text(m.texto)
        .font(.system(size: 16))
        .lineSpacing(4)
        .foregroundStyle(Self.tinta)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Self.suave)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
  }

  @ViewBuilder
  private func respuesta(_ m: Mensaje) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(m.bloques) { b in
        switch b {
        case .texto(_, let c):
          Text(c)
            .font(.system(size: 16))
            .lineSpacing(6)          // 1,7 de interlineado, como la web
            .foregroundStyle(Self.tinta)
            .textSelection(.enabled)
        case .pasos(_, let lista):
          BloquePasos(pasos: lista, vivo: modelo.trabajando && esUltimo(m))
        }
      }
      if m.bloques.isEmpty && modelo.trabajando && esUltimo(m) {
        OrbePensando()
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func esUltimo(_ m: Mensaje) -> Bool { modelo.mensajes.last?.id == m.id }

  // ── Composer ──────────────────────────────────────────────────────────────
  private var composer: some View {
    VStack(spacing: 0) {
      Divider().overlay(Self.tinta.opacity(0.08))
      HStack(alignment: .bottom, spacing: 10) {
        TextField("Escribe…", text: $modelo.borrador, axis: .vertical)
          .font(.system(size: 16))
          .lineLimit(1...6)
          .focused($escribiendo)
          .foregroundStyle(Self.tinta)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(Self.suave)
          .clipShape(RoundedRectangle(cornerRadius: 20))

        Button {
          if modelo.trabajando { Task { await modelo.detener() } }
          else { modelo.enviar() }
        } label: {
          Image(systemName: modelo.trabajando ? "stop.fill" : "arrow.up")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(botonActivo ? Self.tinta : Self.tinta.opacity(0.25))
            .clipShape(Circle())
        }
        .disabled(!botonActivo)
      }
      .padding(.horizontal, 16)
      .padding(.top, 10)
      // 22 y no 10: el mismo padding inferior que se subió en la web, porque
      // con el indicador de inicio del iPhone justo debajo, 10 px dejan el
      // composer pegado al borde y se toca sin querer.
      .padding(.bottom, 22)
    }
    .background(Color.white)
  }

  private var botonActivo: Bool {
    modelo.trabajando || !modelo.borrador.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

/// Bloque de pasos, plegable. Calcado de `LabSteps.tsx`.
struct BloquePasos: View {
  let pasos: [Paso]
  let vivo: Bool
  @State private var abierto = false

  private static let tinta = Color(red: 0x37 / 255, green: 0x35 / 255, blue: 0x2f / 255)

  var body: some View {
    // TODO el bloque es zona de toque, no un triángulo de 9 px: en móvil el
    // objetivo táctil de un caret es imposible de acertar. Misma decisión que
    // en la web, y por el mismo motivo.
    VStack(alignment: .leading, spacing: 6) {
      if vivo && !abierto, let actual = pasos.last {
        fila(actual, conOrbe: true)
          .id(pasos.count)     // relevo: fuerza la animación de entrada
          .transition(.opacity)
      } else {
        HStack(spacing: 6) {
          Image(systemName: abierto ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
          Text("\(pasos.count) paso\(pasos.count == 1 ? "" : "s")")
            .font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(Self.tinta.opacity(0.5))
      }
      if abierto {
        ForEach(pasos) { fila($0, conOrbe: false) }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(red: 0xFA / 255, green: 0xF9 / 255, blue: 0xF7 / 255))
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Self.tinta.opacity(0.07)))
    .contentShape(Rectangle())
    .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { abierto.toggle() } }
  }

  @ViewBuilder
  private func fila(_ p: Paso, conOrbe: Bool) -> some View {
    HStack(spacing: 8) {
      // Mientras el paso está EN EJECUCIÓN el glifo se reemplaza por el orbe:
      // es la única señal de "esto lo está haciendo Hermes ahora mismo".
      if conOrbe { OrbePensando(lado: 15) }
      else {
        Image(systemName: p.simbolo)
          .font(.system(size: 12))
          .foregroundStyle(Self.tinta.opacity(0.55))
          .frame(width: 15)
      }
      Text(p.verbo)
        .font(.system(size: 13, weight: conOrbe ? .medium : .regular))
        .foregroundStyle(Self.tinta.opacity(conOrbe ? 0.9 : 0.65))
      if !p.objetivo.isEmpty {
        Text(p.objetivo)
          .font(.system(size: 12))
          .foregroundStyle(Self.tinta.opacity(0.4))
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
    }
  }
}
