import SwiftUI
import PhotosUI

/// El Laboratorio, nativo.
///
/// Tipografía y colores salen de `globals.css` del dashboard, no de un gusto
/// nuevo: `--font-notion` arranca en `-apple-system` (que en iOS ES la fuente
/// del sistema) y la tinta del cuerpo es #37352f.
struct LabView: View {
  @StateObject private var modelo = LabModelo()
  @FocusState private var escribiendo: Bool
  @State private var elegirFoto: PhotosPickerItem?

  // Colores tomados uno a uno de globals.css. No son aproximaciones: un gris
  // "parecido" al lado del dashboard real se nota en cuanto se ven juntos.
  static let tinta = Color(hex: 0x37352F)        // cuerpo
  static let apagado = Color(hex: 0x9B9A97)      // secundario y placeholder
  static let glifo = Color(hex: 0x787774)        // iconos de barra
  static let burbuja = Color(hex: 0xECECEA)      // fondo del mensaje propio
  static let borde = Color(hex: 0xE9E9E7)        // borde del composer
  static let suave = Color(hex: 0xF7F6F3)

  var body: some View {
    VStack(spacing: 0) {
      cabecera
      hilo
      composer
    }
    .background(Color.white)
    .task { await modelo.recuperarPendiente() }
    .sheet(isPresented: $modelo.mostrarChats) { ChatsView(modelo: modelo) }
    .onChange(of: elegirFoto) { _, nuevo in
      guard let nuevo else { return }
      Task {
        if let d = try? await nuevo.loadTransferable(type: Data.self) {
          await modelo.adjuntar(d, nombre: "foto.jpg")
        }
        elegirFoto = nil
      }
    }
  }

  // ── Cabecera ──────────────────────────────────────────────────────────────
  private var cabecera: some View {
    HStack(spacing: 10) {
      Button { modelo.mostrarChats = true } label: {
        Image(systemName: "line.3.horizontal")
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(Self.glifo)
          .frame(width: 34, height: 34)
      }
      Text(modelo.activo?.titulo ?? "Laboratorio")
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(Self.tinta)
        .lineLimit(1)
      Spacer(minLength: 0)
      Button { modelo.crearChat() } label: {
        Image(systemName: "square.and.pencil")
          .font(.system(size: 15))
          .foregroundStyle(Self.glifo)
          .frame(width: 34, height: 34)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(Color.white)
    .overlay(alignment: .bottom) { Divider().overlay(Self.tinta.opacity(0.08)) }
  }

  // ── Hilo ──────────────────────────────────────────────────────────────────
  private var hilo: some View {
    ScrollViewReader { scroll in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if modelo.mensajes.isEmpty { vacio }
          ForEach(modelo.mensajes) { m in
            if m.mio { burbujaMia(m).id(m.id) } else { respuesta(m) }
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
      .onChange(of: modelo.anclar) { _, id in
        // Al enviar, el mensaje se lleva ARRIBA y no al fondo: así la
        // respuesta crece hacia abajo dentro de la pantalla y se lee sin
        // perseguirla con el pulgar.
        guard let id else { return }
        withAnimation(.easeOut(duration: 0.25)) { scroll.scrollTo(id, anchor: .top) }
        modelo.anclar = nil
      }
      .overlay(alignment: .bottomTrailing) {
        if !modelo.pegadoAbajo {
          Button {
            modelo.pegadoAbajo = true
            withAnimation { scroll.scrollTo("fin", anchor: .bottom) }
          } label: {
            Image(systemName: "arrow.down")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(Self.tinta)
              .frame(width: 34, height: 34)
              .background(.white, in: Circle())
              .overlay(Circle().stroke(Self.tinta.opacity(0.12)))
              .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
          }
          .padding(.trailing, 16)
          .padding(.bottom, 10)
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
      Spacer(minLength: 0)
      Text(m.texto)
        .font(.system(size: 15))
        .lineSpacing(3)
        .foregroundStyle(Self.tinta)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Self.burbuja)
        // 16/16/3/16, no un radio uniforme: la esquina de abajo a la derecha
        // casi recta es lo que da el pico del bocadillo. Con las cuatro
        // iguales deja de leerse como algo dicho por ti.
        .clipShape(.rect(topLeadingRadius: 16, bottomLeadingRadius: 16,
                         bottomTrailingRadius: 3, topTrailingRadius: 16))
        // 78% como en el CSS: a ancho completo un mensaje corto se confunde
        // con la respuesta.
        .frame(maxWidth: UIScreen.main.bounds.width * 0.78, alignment: .trailing)
    }
  }

  @ViewBuilder
  private func respuesta(_ m: Mensaje) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(m.bloques) { b in
        switch b {
        case .texto(_, let c):
          Text(c)
            .font(.system(size: 15))
            // 1,6 de interlineado del CSS: SwiftUI mide lineSpacing como el
            // hueco EXTRA, así que a 15px (interlineado propio ~18) hay que
            // sumar 6 para llegar a los 24 de 1,6 — no 24.
            .lineSpacing(6)
            .foregroundStyle(Self.tinta)
            .textSelection(.enabled)
        case .pasos(_, let lista):
          BloquePasos(pasos: lista, vivo: modelo.trabajando && esUltimo(m))
        }
      }
      if m.bloques.isEmpty && modelo.trabajando && esUltimo(m) {
        Orbe(lado: 56)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func esUltimo(_ m: Mensaje) -> Bool { modelo.mensajes.last?.id == m.id }

  // ── Composer ──────────────────────────────────────────────────────────────
  private var composer: some View {
    VStack(spacing: 0) {
      Divider().overlay(Self.tinta.opacity(0.08))
      if !modelo.adjuntos.isEmpty || modelo.subiendo {
        tiraAdjuntos
      }
      HStack(alignment: .bottom, spacing: 10) {
        PhotosPicker(selection: $elegirFoto, matching: .images) {
          Image(systemName: "photo")
            .font(.system(size: 17))
            .foregroundStyle(Self.apagado)
            .frame(width: 26, height: 30)
        }
        TextField("Escribe algo…", text: $modelo.borrador, axis: .vertical)
          .font(.system(size: 15))
          .lineLimit(1...5)          // max-height 120px del CSS
          .focused($escribiendo)
          .foregroundStyle(Self.tinta)

        Button {
          if modelo.trabajando { Task { await modelo.detener() } }
          else { modelo.enviar() }
        } label: {
          Image(systemName: modelo.trabajando ? "stop.fill" : "arrow.up")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(botonActivo ? Self.tinta : Self.apagado.opacity(0.5))
            .clipShape(Circle())
        }
        .disabled(!botonActivo)
      }
      // La caja del composer: borde de 1px y radio 10, como .lab-composer.
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .background(Color.white)
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(Self.borde))
      .padding(.horizontal, 20)      // --lab-bar-x
      .padding(.top, 14)             // --lab-bar-top
      // 22 y no 10: el mismo padding inferior que se subió en la web, porque
      // con el indicador de inicio del iPhone justo debajo, 10 px dejan el
      // composer pegado al borde y se toca sin querer.
      .padding(.bottom, 22)
    }
    .background(Color.white)
  }

  private var botonActivo: Bool {
    modelo.trabajando
      || !modelo.borrador.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !modelo.adjuntos.isEmpty
  }

  /// Miniaturas de lo adjunto. Salen de la imagen LOCAL, no del servidor:
  /// aparecen al instante y sin viaje de ida y vuelta.
  private var tiraAdjuntos: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(modelo.adjuntos) { a in
          Image(uiImage: a.miniatura)
            .resizable()
            .scaledToFill()
            .frame(width: 54, height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .topTrailing) {
              Button { modelo.quitarAdjunto(a.id) } label: {
                Image(systemName: "xmark.circle.fill")
                  .font(.system(size: 15))
                  .foregroundStyle(.white, .black.opacity(0.5))
              }
              .offset(x: 5, y: -5)
            }
        }
        if modelo.subiendo {
          RoundedRectangle(cornerRadius: 8)
            .fill(Self.suave)
            .frame(width: 54, height: 54)
            .overlay { Orbe(lado: 22) }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 10)
      .padding(.bottom, 2)
    }
  }
}

/// Bloque de pasos, plegable. Calcado de `LabSteps.tsx` y su CSS.
///
/// SIN tarjeta ni borde: en la web es texto suelto en el flujo de la
/// respuesta, no una caja. Encajonarlo lo convierte en un widget y rompe la
/// lectura de "acciones → texto → acciones".
struct BloquePasos: View {
  let pasos: [Paso]
  let vivo: Bool
  @State private var abierto = false

  var body: some View {
    // TODO el bloque es zona de toque, no un triángulo de 9 px: en móvil el
    // objetivo táctil de un caret es imposible de acertar. Misma decisión que
    // en la web, y por el mismo motivo.
    VStack(alignment: .leading, spacing: 3) {
      if vivo && !abierto, let actual = pasos.last {
        fila(actual, conOrbe: true)
          .id(pasos.count)     // relevo: fuerza la animación de entrada
          .transition(.opacity)
      } else {
        HStack(spacing: 5) {
          Image(systemName: abierto ? "chevron.down" : "chevron.right")
            .font(.system(size: 8, weight: .semibold))
          Text("\(pasos.count) paso\(pasos.count == 1 ? "" : "s")")
            .font(.system(size: 11))
        }
        .foregroundStyle(LabView.apagado)
      }
      if abierto {
        ForEach(pasos) { fila($0, conOrbe: false) }
      }
    }
    .padding(.vertical, 2)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { abierto.toggle() } }
  }

  @ViewBuilder
  private func fila(_ p: Paso, conOrbe: Bool) -> some View {
    HStack(spacing: 6) {
      // Mientras el paso está EN EJECUCIÓN el glifo se reemplaza por el orbe
      // de 14px CON ojos: es la única señal de "esto lo está haciendo Hermes
      // ahora mismo". Al plegarse vuelve el glifo.
      if conOrbe {
        Orbe(lado: 14).frame(width: 17, height: 17)
      } else {
        Image(systemName: p.simbolo)
          // #eb5757: el glifo de herramienta es rojo en el CSS. Llama la
          // atención justo lo suficiente sin competir con el texto.
          .foregroundStyle(Color(hex: 0xEB5757))
          .font(.system(size: 11))
          .frame(width: 17)
      }
      Text(p.verbo)
        .font(.system(size: 12.5))
        .foregroundStyle(Color(hex: 0x6B6A67))
      if !p.objetivo.isEmpty {
        Text(p.objetivo)
          .font(.system(size: 12))
          .foregroundStyle(LabView.apagado)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
    }
  }
}

/// Color desde un hex, para poder copiar los valores del CSS tal cual.
extension Color {
  init(hex: UInt32) {
    self.init(.sRGB,
              red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255)
  }
}
