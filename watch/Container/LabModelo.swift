import Foundation
import SwiftUI

/// El estado del Laboratorio y su conversación con el servidor.
@MainActor
final class LabModelo: ObservableObject {
  @Published var mensajes: [Mensaje] = []
  @Published var borrador = ""
  @Published var trabajando = false
  @Published var pegadoAbajo = true
  /// Cambia con cada dato nuevo; la vista lo observa para autoscroll sin
  /// depender de la identidad de los bloques (que mutan en sitio).
  @Published var marcaCambio = 0

  private var constructor = Constructor()
  private var turno: String?
  private var base: String?
  private var tarea: Task<Void, Never>?
  private var sdkSession: String?
  private let sesion = "lab-ios"

  // El turno pendiente se guarda EN DISCO, no en memoria: iOS mata la app en
  // segundo plano cuando le hace falta RAM, y sin esto un turno de dos minutos
  // se perdía por cerrar la app — que es justo lo que el contrato de turnos
  // existe para evitar.
  private static let clavePendiente = "labTurnoPendiente"

  func enviar() {
    let texto = borrador.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !texto.isEmpty, !trabajando else { return }
    borrador = ""
    pegadoAbajo = true
    mensajes.append(.usuario(texto))
    mensajes.append(.agente())
    constructor = Constructor()
    trabajando = true
    marcaCambio += 1

    tarea = Task {
      do {
        let (id, b) = try await Turnos.arrancar(mensaje: texto, sesion: sesion, resume: sdkSession)
        turno = id
        base = b
        guardarPendiente(turno: id, base: b)
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

  /// Al abrir la app: ¿había un turno corriendo?
  ///
  /// Se re-engancha DESDE SU CURSOR en vez de dar por perdido nada. Y si el
  /// servidor no confirma (nil, no 404), se deja el pendiente en disco: puede
  /// ser un blip de red, y borrarlo obligaría a repetir una pregunta que el
  /// agente sigue trabajando.
  func recuperarPendiente() async {
    guard let p = UserDefaults.standard.dictionary(forKey: Self.clavePendiente),
          let id = p["turno"] as? String, let b = p["base"] as? String else { return }
    let desde = p["seq"] as? Int ?? 0

    switch await Turnos.estado(b, id, desde: 0) {
    case .some(.some(let e)):
      if e.status == "running" {
        turno = id
        base = b
        trabajando = true
        if mensajes.isEmpty || mensajes.last?.mio == true { mensajes.append(.agente()) }
        constructor.repintar(texto: e.text, pasos: e.steps)
        volcar()
        tarea = Task { await seguir(base: b, turno: id, desde: max(e.seq, desde)) }
      } else {
        // Terminó mientras la app no estaba: se pinta el resultado y se cierra.
        if mensajes.isEmpty || mensajes.last?.mio == true { mensajes.append(.agente()) }
        constructor.repintar(texto: e.text, pasos: e.steps)
        volcar()
        limpiarPendiente()
      }
    case .some(.none):
      limpiarPendiente()          // 404: pérdida confirmada
    case .none:
      break                        // no se sabe: se deja para el próximo arranque
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
      // `truncated` = el buffer del servidor botó eventos. Concatenar deltas
      // dejaría huecos, así que se repinta con el texto íntegro del snapshot.
      if e.truncated { constructor.repintar(texto: e.text, pasos: e.steps) }
      if let s = e.sdkSessionId { sdkSession = s }
      guardarPendiente(turno: id, base: b, seq: e.seq)
    case .delta(let t, let seq):
      constructor.agregarTexto(t)
      guardarPendiente(turno: id, base: b, seq: seq)
    case .paso(let p, let seq):
      constructor.agregarPaso(p)
      guardarPendiente(turno: id, base: b, seq: seq)
    case .sesion(let s):
      sdkSession = s
    case .modelo:
      break
    case .fin:
      trabajando = false
      limpiarPendiente()
    case .desconectado:
      // NO se marca como fallo: el turno sigue vivo del otro lado y se
      // recupera al volver a la app desde el cursor guardado.
      trabajando = false
    }
    volcar()
  }

  private func volcar() {
    if let i = mensajes.indices.last, !mensajes[i].mio {
      mensajes[i].bloques = constructor.bloques
    }
    marcaCambio += 1
  }

  private func fallar(_ m: String) {
    trabajando = false
    constructor.agregarTexto(m)
    volcar()
    limpiarPendiente()
  }

  // ── Pendiente en disco ────────────────────────────────────────────────────
  private func guardarPendiente(turno: String, base: String, seq: Int = 0) {
    UserDefaults.standard.set(["turno": turno, "base": base, "seq": seq],
                             forKey: Self.clavePendiente)
  }

  private func limpiarPendiente() {
    UserDefaults.standard.removeObject(forKey: Self.clavePendiente)
  }
}
