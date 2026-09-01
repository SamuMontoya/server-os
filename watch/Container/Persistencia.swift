import Foundation

/// Guarda los chats del Laboratorio en disco.
///
/// Va a un archivo JSON en Documents y no a UserDefaults: los hilos crecen
/// (mensajes, bloques, pasos) y UserDefaults está pensado para ajustes, no
/// para datos. Con hilos largos ahí, cada guardado reescribe el plist entero.
///
/// El modelo replica el de la web (`lib/lab-persist.ts`): varios chats a la
/// vez, cada uno con su hilo y su sesión del SDK, más el recuerdo de cuál es
/// el activo. Los tipos de la vista NO se hacen Codable a propósito — se
/// traducen aquí, para que un cambio de pantalla no obligue a migrar el disco.
enum Persistencia {
  /// Techo de chats retenidos. Los ACTIVOS nunca se descartan por el techo:
  /// perder el chat que estabas usando por haber abierto otros doce es el
  /// peor recorte posible.
  private static let tope = 30

  private static var archivo: URL {
    let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    return dir.appendingPathComponent("laboratorio.json")
  }

  // ── Lo que se guarda ─────────────────────────────────────────────────────
  struct PasoDTO: Codable {
    var nombre: String
    var objetivo: String
  }

  struct BloqueDTO: Codable {
    var tipo: String          // "texto" | "pasos"
    var contenido: String?
    var pasos: [PasoDTO]?
  }

  struct MensajeDTO: Codable {
    var mio: Bool
    var texto: String
    var bloques: [BloqueDTO]
  }

  struct PendienteDTO: Codable {
    var turno: String
    var base: String
    var seq: Int
  }

  struct ChatDTO: Codable, Identifiable {
    var id: String
    var titulo: String
    var actualizado: Date
    var mensajes: [MensajeDTO]
    var sdkSession: String?
    var pendiente: PendienteDTO?
  }

  struct EstadoDTO: Codable {
    var chats: [ChatDTO]
    var activo: String?
  }

  // ── Leer y escribir ──────────────────────────────────────────────────────
  static func cargar() -> EstadoDTO {
    guard let d = try? Data(contentsOf: archivo),
          let e = try? JSONDecoder().decode(EstadoDTO.self, from: d) else {
      return EstadoDTO(chats: [], activo: nil)
    }
    return e
  }

  static func guardar(_ e: EstadoDTO) {
    var recortado = e
    if recortado.chats.count > tope {
      // Se ordena por reciente y se conserva el activo aunque quede fuera.
      let activos = Set([e.activo].compactMap { $0 })
      let orden = recortado.chats.sorted { $0.actualizado > $1.actualizado }
      var quedan = Array(orden.prefix(tope))
      for c in orden where activos.contains(c.id) && !quedan.contains(where: { $0.id == c.id }) {
        quedan.append(c)
      }
      recortado.chats = quedan
    }
    guard let d = try? JSONEncoder().encode(recortado) else { return }
    // `.atomic` para que un cierre de la app a mitad de escritura no deje el
    // archivo truncado: sin eso, un JSON medio escrito borra TODOS los chats
    // al siguiente arranque, que es peor que no guardar.
    try? d.write(to: archivo, options: .atomic)
  }

  // ── Traducción a/desde los tipos de la vista ─────────────────────────────
  static func aDTO(_ m: Mensaje) -> MensajeDTO {
    MensajeDTO(mio: m.mio, texto: m.texto, bloques: m.bloques.map { b in
      switch b {
      case .texto(_, let c):
        BloqueDTO(tipo: "texto", contenido: c, pasos: nil)
      case .pasos(_, let l):
        BloqueDTO(tipo: "pasos", contenido: nil,
                  pasos: l.map { PasoDTO(nombre: $0.nombre, objetivo: $0.objetivo) })
      }
    })
  }

  static func deDTO(_ d: MensajeDTO) -> Mensaje {
    Mensaje(id: UUID(), mio: d.mio, texto: d.texto, bloques: d.bloques.compactMap { b in
      switch b.tipo {
      case "texto":
        return .texto(id: UUID(), contenido: b.contenido ?? "")
      case "pasos":
        return .pasos(id: UUID(),
                      lista: (b.pasos ?? []).map { Paso(nombre: $0.nombre, objetivo: $0.objetivo) })
      default:
        return nil
      }
    })
  }

  /// Título del chat: la primera frase de lo que preguntaste.
  ///
  /// No se le pide al modelo que lo resuma: eso costaría un turno por chat y
  /// en una lista lo que ayuda a reconocerlo es TU frase, no un resumen
  /// ajeno.
  static func titulo(de texto: String) -> String {
    let limpio = texto.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\n", with: " ")
    if limpio.count <= 48 { return limpio.isEmpty ? "Chat nuevo" : limpio }
    let corte = limpio.prefix(48)
    if let esp = corte.lastIndex(of: " ") { return String(corte[..<esp]) + "…" }
    return String(corte) + "…"
  }
}
