import Foundation
import SwiftUI

/// Un chat del Laboratorio.
struct Chat: Identifiable {
  let id: String
  var titulo: String
  var actualizado: Date
  var mensajes: [Mensaje]
  var sdkSession: String?
  var pendiente: Persistencia.PendienteDTO?
  /// Se está ejecutando un turno de este chat ahora mismo.
  var corriendo = false
}

/// Una imagen adjunta al mensaje que se está escribiendo.
struct Adjunto: Identifiable {
  let id: String            // el que devolvió el servidor
  let miniatura: UIImage
}

/// El estado del Laboratorio: varios chats, el activo, y su conversación con
/// el servidor.
@MainActor
final class LabModelo: ObservableObject {
  @Published var chats: [Chat] = []
  @Published var activoId: String = ""
  @Published var borrador = ""
  @Published var trabajando = false
  @Published var adjuntos: [Adjunto] = []
  @Published var subiendo = false
  @Published var pegadoAbajo = true
  @Published var marcaCambio = 0
  @Published var mostrarChats = false
  /// Mensaje que hay que llevar arriba tras enviar (el anclaje de la web).
  @Published var anclar: UUID?

  private var constructor = Constructor()
  private var turno: String?
  private var base: String?
  private var tarea: Task<Void, Never>?

  var activo: Chat? { chats.first { $0.id == activoId } }
  var mensajes: [Mensaje] { activo?.mensajes ?? [] }

  init() {
    let e = Persistencia.cargar()
    chats = e.chats.map {
      Chat(id: $0.id, titulo: $0.titulo, actualizado: $0.actualizado,
           mensajes: $0.mensajes.map(Persistencia.deDTO),
           sdkSession: $0.sdkSession, pendiente: $0.pendiente)
    }
    activoId = e.activo ?? chats.first?.id ?? nuevoId()
    if activo == nil { crearChat(activar: true) }
  }

  private func nuevoId() -> String { UUID().uuidString }

  // ── Chats ─────────────────────────────────────────────────────────────────
  func crearChat(activar: Bool = true) {
    let c = Chat(id: nuevoId(), titulo: "Chat nuevo", actualizado: Date(), mensajes: [])
    chats.insert(c, at: 0)
    if activar { activoId = c.id }
    persistir()
  }

  func abrirChat(_ id: String) {
    guard id != activoId else { mostrarChats = false; return }
    // Cambiar de chat NO cancela el turno del anterior: sigue vivo en el
    // servidor y al volver se re-engancha desde su cursor.
    tarea?.cancel()
    tarea = nil
    trabajando = false
    activoId = id
    constructor = Constructor()
    mostrarChats = false
    persistir()
    Task { await recuperarPendiente() }
  }

  func borrarChat(_ id: String) {
    chats.removeAll { $0.id == id }
    if activoId == id {
      if chats.isEmpty { crearChat(activar: true) } else { activoId = chats[0].id }
      Task { await recuperarPendiente() }
    }
    persistir()
  }

  // ── Enviar ────────────────────────────────────────────────────────────────
  func enviar() {
    let texto = borrador.trimmingCharacters(in: .whitespacesAndNewlines)
    let ids = adjuntos.map(\.id)
    guard !texto.isEmpty || !ids.isEmpty, !trabajando else { return }
    borrador = ""
    adjuntos = []
    pegadoAbajo = true

    let mio = Mensaje.usuario(texto.isEmpty ? "¿Qué ves en esta imagen?" : texto)
    modificarActivo { c in
      if c.mensajes.isEmpty { c.titulo = Persistencia.titulo(de: mio.texto) }
      c.mensajes.append(mio)
      c.mensajes.append(.agente())
      c.actualizado = Date()
      c.corriendo = true
    }
    // El mensaje enviado se lleva ARRIBA en vez de al fondo: así la respuesta
    // crece hacia abajo dentro de la pantalla y se lee sin perseguirla. Es el
    // anclaje que hace la web.
    anclar = mio.id
    constructor = Constructor()
    trabajando = true
    marcaCambio += 1

    tarea = Task {
      do {
        let (id, b) = try await Turnos.arrancar(
          mensaje: mio.texto, sesion: "lab-ios-\(activoId)",
          resume: activo?.sdkSession, adjuntos: ids)
        turno = id
        base = b
        guardarPendiente(turno: id, base: b, seq: 0)
        await seguir(base: b, turno: id, desde: 0)
      } catch {
        fallar(error.localizedDescription)
      }
    }
  }

  func detener() async {
    guard let base, let turno else { return }
    await Turnos.detener(base, turno)
  }

  // ── Adjuntos ──────────────────────────────────────────────────────────────
  /// Sube la imagen y guarda su id.
  ///
  /// Van como IDS y no en base64: el turno se manda igual de rápido con cuatro
  /// capturas que sin ninguna, y el servidor le pasa al modelo la ruta en
  /// disco. La miniatura sale de la imagen LOCAL, sin pedirla al servidor:
  /// aparece instantánea y sin viaje de ida y vuelta.
  func adjuntar(_ datos: Data, nombre: String) async {
    guard let img = UIImage(data: datos) else { return }
    subiendo = true
    defer { subiendo = false }
    guard let base = await Turnos.servidor(),
          let id = await Turnos.subirImagen(base, datos: datos, nombre: nombre) else { return }
    adjuntos.append(Adjunto(id: id, miniatura: img))
  }

  func quitarAdjunto(_ id: String) { adjuntos.removeAll { $0.id == id } }

  // ── Recuperar el pendiente ────────────────────────────────────────────────
  func recuperarPendiente() async {
    guard let p = activo?.pendiente else { return }
    switch await Turnos.estado(p.base, p.turno, desde: 0) {
    case .some(.some(let e)):
      asegurarHuecoAgente()
      constructor.repintar(texto: e.text, pasos: e.steps)
      volcar()
      if e.status == "running" {
        turno = p.turno
        base = p.base
        trabajando = true
        let b = p.base, t = p.turno, desde = max(e.seq, p.seq)
        tarea = Task { await seguir(base: b, turno: t, desde: desde) }
      } else {
        limpiarPendiente()
      }
    case .some(.none):
      limpiarPendiente()        // 404: pérdida confirmada
    case .none:
      break                      // no se sabe: se deja para el próximo arranque
    }
  }

  // ── Seguimiento ───────────────────────────────────────────────────────────
  private func seguir(base b: String, turno id: String, desde: Int) async {
    await Turnos.seguir(b, turno: id, desde: desde) { [weak self] ev in
      Task { @MainActor in self?.aplicar(ev, base: b, turno: id) }
    }
  }

  private func aplicar(_ ev: Turnos.Evento, base b: String, turno id: String) {
    switch ev {
    case .estado(let e):
      if e.truncated { constructor.repintar(texto: e.text, pasos: e.steps) }
      if let s = e.sdkSessionId { modificarActivo { $0.sdkSession = s } }
      guardarPendiente(turno: id, base: b, seq: e.seq)
    case .delta(let t, let seq):
      constructor.agregarTexto(t)
      guardarPendiente(turno: id, base: b, seq: seq)
    case .paso(let p, let seq):
      constructor.agregarPaso(p)
      guardarPendiente(turno: id, base: b, seq: seq)
    case .sesion(let s):
      modificarActivo { $0.sdkSession = s }
    case .modelo:
      break
    case .fin:
      trabajando = false
      modificarActivo { $0.corriendo = false }
      limpiarPendiente()
    case .desconectado:
      // NO es un fallo: el turno sigue vivo y se recupera al volver.
      trabajando = false
    }
    volcar()
  }

  private func asegurarHuecoAgente() {
    if activo?.mensajes.isEmpty ?? true || activo?.mensajes.last?.mio == true {
      modificarActivo { $0.mensajes.append(.agente()) }
    }
  }

  private func volcar() {
    modificarActivo { c in
      if let i = c.mensajes.indices.last, !c.mensajes[i].mio {
        c.mensajes[i].bloques = constructor.bloques
      }
      c.actualizado = Date()
    }
    marcaCambio += 1
  }

  private func fallar(_ m: String) {
    trabajando = false
    constructor.agregarTexto(m)
    modificarActivo { $0.corriendo = false }
    volcar()
    limpiarPendiente()
  }

  // ── Estado en disco ───────────────────────────────────────────────────────
  private func modificarActivo(_ f: (inout Chat) -> Void) {
    guard let i = chats.firstIndex(where: { $0.id == activoId }) else { return }
    f(&chats[i])
    persistir()
  }

  private func guardarPendiente(turno: String, base: String, seq: Int) {
    modificarActivo {
      $0.pendiente = Persistencia.PendienteDTO(turno: turno, base: base, seq: seq)
    }
  }

  private func limpiarPendiente() { modificarActivo { $0.pendiente = nil } }

  private func persistir() {
    Persistencia.guardar(Persistencia.EstadoDTO(
      chats: chats.map { c in
        Persistencia.ChatDTO(id: c.id, titulo: c.titulo, actualizado: c.actualizado,
                             mensajes: c.mensajes.map(Persistencia.aDTO),
                             sdkSession: c.sdkSession, pendiente: c.pendiente)
      },
      activo: activoId))
  }
}
