import Foundation

/// Un paso del agente: qué tool usó y sobre qué.
struct Paso: Identifiable, Equatable {
  let id = UUID()
  let nombre: String
  let objetivo: String

  static func desde(_ j: [String: Any]) -> Paso? {
    guard let n = j["name"] as? String, !n.isEmpty else { return nil }
    return Paso(nombre: n, objetivo: j["target"] as? String ?? "")
  }

  /// Verbo en pasado, copiado de `apps/web/src/lib/tool-labels.ts`.
  ///
  /// El vocabulario es del DOMINIO, no de una pantalla: si aquí dijera "Read"
  /// y en la web "Leyó", serían dos productos distintos. Las `mcp__hermes__*`
  /// se buscan sin su prefijo, igual que allá.
  var verbo: String {
    Self.verbos[base] ?? "Usó \(base)"
  }

  private var base: String {
    guard let ultimo = nombre.split(separator: "_").last, nombre.contains("__") else {
      return nombre
    }
    // mcp__hermes__save_memory → save_memory (no solo "memory")
    if let i = nombre.range(of: "__", options: .backwards) {
      return String(nombre[i.upperBound...])
    }
    return String(ultimo)
  }

  var simbolo: String {
    switch base {
    case "Read": "doc.text"
    case "Write": "square.and.pencil"
    case "Edit", "MultiEdit": "pencil"
    case "Bash": "terminal"
    case "Grep": "magnifyingglass"
    case "Glob", "LS": "folder"
    case "WebSearch", "WebFetch": "globe"
    case "Task": "bolt"
    case "TodoWrite": "checklist"
    default: "sparkles"
    }
  }

  private static let verbos: [String: String] = [
    "Read": "Leyó", "Glob": "Listó", "Grep": "Buscó", "Bash": "Ejecutó",
    "Write": "Escribió", "Edit": "Editó", "MultiEdit": "Editó",
    "WebSearch": "Buscó en la web", "WebFetch": "Abrió",
    "TodoWrite": "Actualizó el plan", "ToolSearch": "Cargó herramientas",
    "Task": "Lanzó un subagente",
    "search_knowledge": "Buscó en el conocimiento",
    "save_memory": "Guardó en memoria",
    "search_memory": "Buscó en la memoria",
    "save_preference": "Guardó una preferencia",
    "get_project_status": "Leyó el estado del proyecto",
    "update_project_note": "Actualizó la nota del proyecto",
    "search_vault": "Buscó en el vault",
    "capture_idea": "Capturó una idea",
    "get_recent_activity": "Leyó la actividad reciente",
    "control_lights": "Controló las luces",
  ]
}

/// Un tramo de la respuesta, EN EL ORDEN EN QUE PASÓ.
///
/// Esta es la decisión de diseño que define el Laboratorio, y viene calcada de
/// la web (ver la cabecera de `apps/web/src/app/laboratorio/page.tsx`):
///
/// Antes la respuesta eran dos campos sueltos —todo el texto y todas las
/// tools— y la pantalla los pintaba siempre igual: primero los pasos, luego el
/// texto. Con eso, un turno que trabaja, explica, vuelve a trabajar y remata se
/// veía como si hubiera hecho TODO al principio y hablado al final. La
/// cronología real se perdía en el modelo de datos, no en la vista.
///
/// Aquí la respuesta es una LISTA de bloques que se arma en el orden de llegada
/// del stream: los deltas se pegan al bloque de texto de arriba, las tools al
/// de pasos de arriba, y cada cambio de tipo abre un bloque nuevo. Así el hilo
/// queda: acciones → texto → acciones → texto.
enum Bloque: Identifiable {
  case texto(id: UUID, contenido: String)
  case pasos(id: UUID, lista: [Paso])

  var id: UUID {
    switch self {
    case .texto(let id, _): id
    case .pasos(let id, _): id
    }
  }
}

/// Acumula el stream en bloques ordenados.
struct Constructor {
  private(set) var bloques: [Bloque] = []

  mutating func agregarTexto(_ t: String) {
    if case .texto(let id, let c) = bloques.last {
      bloques[bloques.count - 1] = .texto(id: id, contenido: c + t)
    } else {
      bloques.append(.texto(id: UUID(), contenido: t))
    }
  }

  mutating func agregarPaso(_ p: Paso) {
    if case .pasos(let id, let l) = bloques.last {
      bloques[bloques.count - 1] = .pasos(id: id, lista: l + [p])
    } else {
      bloques.append(.pasos(id: UUID(), lista: [p]))
    }
  }

  /// Repinta desde cero con el estado del servidor.
  ///
  /// Se usa cuando el turno llega con `truncated`: el buffer del servidor botó
  /// eventos, así que concatenar deltas dejaría huecos. El texto íntegro del
  /// snapshot es la única fuente fiable, aunque se pierda el entrelazado
  /// exacto — es mejor perder el orden que perder contenido.
  mutating func repintar(texto: String, pasos: [Paso]) {
    bloques = []
    if !pasos.isEmpty { bloques.append(.pasos(id: UUID(), lista: pasos)) }
    if !texto.isEmpty { bloques.append(.texto(id: UUID(), contenido: texto)) }
  }

  var vacio: Bool { bloques.isEmpty }
}

/// Un mensaje del hilo.
struct Mensaje: Identifiable {
  let id: UUID
  let mio: Bool
  var texto: String
  var bloques: [Bloque]

  static func usuario(_ t: String) -> Mensaje {
    Mensaje(id: UUID(), mio: true, texto: t, bloques: [])
  }

  static func agente() -> Mensaje {
    Mensaje(id: UUID(), mio: false, texto: "", bloques: [])
  }
}
