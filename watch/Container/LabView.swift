import SwiftUI
import PhotosUI  // adjuntar imágenes; el botón se quitó del composer

/// El Laboratorio, nativo.
///
/// Tipografía y colores salen de `globals.css` del dashboard, no de un gusto
/// nuevo: `--font-notion` arranca en `-apple-system` (que en iOS ES la fuente
/// del sistema) y la tinta del cuerpo es #37352f.
struct LabView: View {
  @StateObject private var modelo = LabModelo()
  @FocusState private var escribiendo: Bool
  @State private var elegirFoto: PhotosPickerItem?
  @StateObject private var dictado = Dictado()

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
    // fullScreenCover y no sheet: en la web la pantalla de chats es
    // `position: fixed; inset: 0` — cubre el viewport entero. Un sheet deja
    // ver el hilo detrás y se arrastra hacia abajo, que no es lo mismo.
    .fullScreenCover(isPresented: $modelo.mostrarChats) { ChatsView(modelo: modelo) }
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
    HStack {
      Button { modelo.mostrarChats = true } label: {
        Image(systemName: "line.3.horizontal")
          .font(.system(size: 19, weight: .regular))
          .foregroundStyle(Self.tinta)
          .frame(width: 34, height: 34)
      }
      Spacer()
      // El "+" va en un cuadrado gris redondeado, no suelto: es el único
      // control con fondo de la pantalla y así se lee como el botón primario.
      Button { modelo.crearChat() } label: {
        Image(systemName: "plus")
          .font(.system(size: 19, weight: .regular))
          .foregroundStyle(Self.tinta)
          .frame(width: 40, height: 40)
          .background(Color(hex: 0xF1F1EF))
          .clipShape(RoundedRectangle(cornerRadius: 11))
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
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

  /// Chat nuevo: orbe grande, saludo y UNA sugerencia.
  ///
  /// Una sola sugerencia y como TEXTO, no como botones: tres tarjetas llenan
  /// la pantalla y la convierten en un menú. Aquí lo que manda es el orbe, y
  /// la línea de abajo solo insinúa por dónde empezar. Se puede tocar.
  private var vacio: some View {
    VStack(spacing: 0) {
      // Un solo Spacer arriba y otro abajo, iguales: antes había dos abajo y
      // eso empujaba el conjunto hacia arriba en vez de centrarlo.
      Spacer(minLength: 0)
      Orbe(lado: 140)
      Text("Hola \(Self.dueno)")
        .font(.system(size: 30, weight: .bold))
        .foregroundStyle(Self.tinta)
        .padding(.top, 6)
      Button { modelo.borrador = Self.sugerencia } label: {
        Text(Self.sugerencia)
          .font(.system(size: 16))
          .foregroundStyle(Self.apagado)
          .multilineTextAlignment(.center)
      }
      .buttonStyle(.plain)
      .padding(.top, 14)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity)
  }

  /// El nombre sale de la configuración, no del código: el mismo repo corre en
  /// la máquina de cualquiera con su propio .env.
  private static let dueno =
    (Bundle.main.object(forInfoDictionaryKey: "HermesOwner") as? String) ?? "Samu"

  private static let sugerencia = "Resume en qué anda cada proyecto"

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
          // Markdown de verdad: títulos, listas, código y enlaces. Pintar el
          // texto crudo dejaba los `##` y los `-` a la vista.
          Markdown(fuente: c)
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
      // Sin línea divisoria: el composer ya se separa por su propio borde, y
      // la raya de más partía la pantalla en dos.
      if !modelo.adjuntos.isEmpty || modelo.subiendo {
        tiraAdjuntos
      }
      HStack(spacing: 10) {
        // Micrófono: círculo OSCURO dentro de la caja, a la izquierda. Es el
        // control con más peso visual del composer a propósito — dictar es lo
        // que más se hace desde el teléfono.
        Button { dictado.alternar($modelo.borrador) } label: {
          ZStack {
            Circle().fill(dictado.grabando ? Color(hex: 0xE35B4A) : Self.tinta)
            if dictado.grabando {
              BarrasMic(nivel: dictado.nivel).colorInvert()
            } else {
              Image(systemName: "mic.fill")
                .font(.system(size: 15))
                .foregroundStyle(.white)
            }
          }
          .frame(width: 34, height: 34)
        }

        TextField("Escribe algo…", text: $modelo.borrador, axis: .vertical)
          .font(.system(size: 17))
          .lineLimit(1...5)
          .focused($escribiendo)
          .foregroundStyle(Self.tinta)

        Button {
          if dictado.grabando { dictado.parar() }
          if modelo.trabajando { Task { await modelo.detener() } }
          else { modelo.enviar() }
        } label: {
          Image(systemName: modelo.trabajando ? "stop.fill" : "arrow.up")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(botonActivo ? Self.tinta : Color(hex: 0xD3D1CB))
            .clipShape(Circle())
        }
        .disabled(!botonActivo)
      }
      // La caja del composer: borde de 1px y radio 10, como .lab-composer.
      .padding(.horizontal, 8)
      .padding(.vertical, 8)
      .background(Color.white)
      .clipShape(RoundedRectangle(cornerRadius: 26))
      .overlay(RoundedRectangle(cornerRadius: 26).stroke(Self.borde))
      .padding(.horizontal, 16)
      .padding(.top, 6)

      if let e = dictado.error {
        Text(e)
          .font(.system(size: 11))
          .foregroundStyle(Color(hex: 0xE35B4A))
          .padding(.top, 6)
      }
      BarraEstado(modelo: modelo.modeloTurno)
        // Alineado con el composer y un poco más adentro: el porcentaje y el
        // tiempo tocaban el borde de la pantalla.
        .padding(.horizontal, 30)
        .padding(.top, 8)
      // 8 y no 22: con el pie de estado debajo (porcentaje · modelo · tiempo)
      // ya hay separación del indicador de inicio, así que el composer puede
      // bajar. Con 22 quedaba flotando a media pantalla.
      .padding(.bottom, 8)
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
