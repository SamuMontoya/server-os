import Foundation

/// Cliente del agente de server-os.
///
/// Habla el contrato de turnos (`POST /chat/turns` + SSE de
/// `/chat/turns/:id/stream`), NO el de `/v1/chat/completions`. La diferencia
/// importa en un reloj: el turno es un TRABAJO DEL SERVIDOR, así que si la
/// pantalla se apaga a mitad de la respuesta el turno sigue vivo y al volver
/// se re-engancha desde su `seq`. Con un stream a pelo se perdería.
enum Agente {
  /// URL y clave se inyectan al compilar desde el `.env` del repo (lo hace
  /// `scripts/install-watch.sh`), para no dejar la clave escrita en el
  /// proyecto, que sí va a git.
  /// DOS direcciones y se prueba en orden. La LAN primero porque es directa;
  /// la de Tailscale como respaldo. El reloj NO corre Tailscale (watchOS no
  /// está soportado), así que la segunda solo sirve mientras el iPhone haga
  /// de puente — por eso la LAN manda cuando estás en casa.
  static var bases: [String] {
    [Bundle.main.object(forInfoDictionaryKey: "HermesURL") as? String ?? "",
     Bundle.main.object(forInfoDictionaryKey: "HermesURLAlt") as? String ?? ""]
      .filter { !$0.isEmpty }
  }
  static var base: String { bases.first ?? "" }
  private static var clave: String {
    (Bundle.main.object(forInfoDictionaryKey: "HermesAPIKey") as? String) ?? ""
  }

  static var configurado: Bool { !bases.isEmpty }

  /// Lo que el reloj sabe pintar. El resto de eventos del contrato (`model`,
  /// `session`, `retry`) se ignoran a propósito: en una pantalla así no
  /// aportan y solo quitarían sitio.
  enum Evento {
    case texto(String)
    /// La vía rápida no bastó: se pasa al turno completo, con pasos.
    case escala
    /// Una imagen de internet para enseñar en pantalla.
    case imagen(URL)
    case paso(nombre: String, objetivo: String)
    case fin
    case fallo(String)
  }

  /// Canal propio del reloj. `session_key` separa el hilo: los turnos del
  /// reloj no se cruzan con los del dashboard ni esperan a los suyos, porque
  /// cada turno es un trabajo independiente del servidor. Por eso el reloj
  /// nunca queda bloqueado detrás de una tarea larga abierta en el escritorio.
  static let canal = "reloj"


  static func preguntar(_ texto: String,
                        sesion: String = canal,
                        alRecibir: @escaping (Evento) -> Void) async {
    guard configurado else {
      alRecibir(.fallo("Sin servidor configurado"))
      return
    }
    for (i, servidor) in bases.enumerated() {
      let ultima = i == bases.count - 1
      if await intentar(servidor, texto: texto, sesion: sesion,
                        alRecibir: alRecibir, silencioso: !ultima) { return }
    }
  }

  /// Devuelve `true` si llegó a abrir el turno. Con `silencioso` no reporta el
  /// fallo: es un intento intermedio y todavía queda otra dirección que probar.
  private static func intentar(_ servidor: String, texto: String, sesion: String,
                               alRecibir: @escaping (Evento) -> Void,
                               silencioso: Bool) async -> Bool {
    guard let u = URL(string: "\(servidor)/watch/ask") else { return false }
    do {
      var p = URLRequest(url: u)
      p.httpMethod = "POST"
      p.setValue("application/json", forHTTPHeaderField: "Content-Type")
      p.setValue("Bearer \(clave)", forHTTPHeaderField: "Authorization")
      // El preámbulo de estilo ya NO viaja en el mensaje: vive en el prompt
      // de sistema de la sesión persistente del servidor. Mandarlo aquí
      // alargaba cada pregunta y encima confundía al clasificador.
      p.httpBody = try JSONSerialization.data(withJSONObject: ["message": texto])
      p.timeoutInterval = 300

      // La respuesta ES el stream: /watch/ask contesta por SSE directamente,
      // sin el paso previo de crear un turno. Un viaje menos antes de hablar.
      let (bytes, _) = try await URLSession.shared.bytes(for: p)
      var evento = ""
      for try await linea in bytes.lines {
        if linea.hasPrefix("event:") {
          evento = String(linea.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if linea.hasPrefix("data:") {
          let crudo = String(linea.dropFirst(5)).trimmingCharacters(in: .whitespaces)
          let j = (try? JSONSerialization.jsonObject(
            with: Data(crudo.utf8))) as? [String: Any] ?? [:]
          switch evento {
          case "delta":
            if let t = j["text"] as? String, !t.isEmpty { alRecibir(.texto(t)) }
          case "paso":
            if let n = j["name"] as? String, !n.isEmpty {
              alRecibir(.paso(nombre: n, objetivo: j["target"] as? String ?? ""))
            }
          case "imagen":
            if let u = j["url"] as? String, let url = URL(string: u) {
              alRecibir(.imagen(url))
            }
          case "latido":
            // Solo mantiene viva la conexión mientras el turno trabaja. No se
            // pinta nada: el orbe dando mortales ya dice que sigue vivo.
            break
          case "escala":
            // La pregunta necesitaba mirar el sistema: se limpia lo dicho por
            // la vía rápida y a partir de aquí se ven los pasos.
            alRecibir(.escala)
          case "fin":
            alRecibir(.fin)
            return true
          default:
            break
          }
        }
      }
      alRecibir(.fin)
      return true
    } catch {
      if !silencioso { alRecibir(.fallo("No se pudo conectar")) }
      return false
    }
  }

  private static func despachar(evento: String, cuerpo: [String: Any],
                                alRecibir: @escaping (Evento) -> Void) -> Bool {
    // `state` es el snapshot inicial: al re-engancharse trae lo ya acumulado.
    if evento == "state" {
      if let t = cuerpo["text"] as? String, !t.isEmpty { alRecibir(.texto(t)) }
      return false
    }
    if evento == "end" {
      alRecibir(.fin)
      return true
    }

    switch cuerpo["kind"] as? String {
    case "delta":
      if let t = cuerpo["text"] as? String, !t.isEmpty { alRecibir(.texto(t)) }
    case "tool":
      let tool = cuerpo["tool"] as? [String: Any] ?? [:]
      let nombre = tool["name"] as? String ?? ""
      if !nombre.isEmpty {
        alRecibir(.paso(nombre: nombre, objetivo: tool["target"] as? String ?? ""))
      }
    case "done", "stopped":
      alRecibir(.fin)
      return true
    case "error":
      alRecibir(.fallo(cuerpo["text"] as? String ?? "Falló el turno"))
      return true
    default:
      // model, session, retry: no aportan en una pantalla así.
      break
    }
    return false
  }
}
