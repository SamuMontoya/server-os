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
    case paso(nombre: String, objetivo: String)
    case fin
    case fallo(String)
  }

  /// Canal propio del reloj. `session_key` separa el hilo: los turnos del
  /// reloj no se cruzan con los del dashboard ni esperan a los suyos, porque
  /// cada turno es un trabajo independiente del servidor. Por eso el reloj
  /// nunca queda bloqueado detrás de una tarea larga abierta en el escritorio.
  static let canal = "reloj"

  /// Se le pide brevedad en CADA turno y no solo al abrir sesión: el turno
  /// puede reanudar una sesión vieja del servidor, donde esa instrucción ya
  /// quedó sepultada bajo el historial.
  private static let estilo = """
    Estás respondiendo en la pantalla de un reloj. UNA sola frase, lo más \
    corta posible. Sin markdown, sin listas, sin viñetas, sin preámbulo, sin \
    repetir la pregunta. Si la respuesta es un dato, di solo el dato.
    """

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
    guard let u = URL(string: "\(servidor)/chat/turns") else { return false }
    do {
      var p = URLRequest(url: u)
      p.httpMethod = "POST"
      p.setValue("application/json", forHTTPHeaderField: "Content-Type")
      p.setValue("Bearer \(clave)", forHTTPHeaderField: "Authorization")
      p.httpBody = try JSONSerialization.data(withJSONObject: [
        "message": "\(estilo)\n\n\(texto)",
        "session_key": sesion,
      ])

      let (datos, _) = try await URLSession.shared.data(for: p)
      guard let j = try JSONSerialization.jsonObject(with: datos) as? [String: Any],
            let id = j["turn_id"] as? String else {
        if !silencioso { alRecibir(.fallo("Respuesta inesperada")) }
        return false
      }
      await escuchar(servidor: servidor, turno: id, alRecibir: alRecibir)
      return true
    } catch {
      if !silencioso { alRecibir(.fallo("No se pudo conectar")) }
      return false
    }
  }

  private static func escuchar(servidor: String, turno: String,
                               alRecibir: @escaping (Evento) -> Void) async {
    guard let u = URL(string: "\(servidor)/chat/turns/\(turno)/stream?from=0") else { return }
    var r = URLRequest(url: u)
    r.setValue("Bearer \(clave)", forHTTPHeaderField: "Authorization")
    r.timeoutInterval = 300

    do {
      let (bytes, _) = try await URLSession.shared.bytes(for: r)
      // SSE a mano: el cuerpo llega como líneas y solo interesan las `data:`.
      // El nombre del evento viene en su propia línea `event:`, así que hay
      // que recordarlo hasta que llegue su `data:`.
      var evento = ""
      for try await linea in bytes.lines {
        if linea.hasPrefix("event:") {
          evento = String(linea.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if linea.hasPrefix("data:") {
          let crudo = String(linea.dropFirst(5)).trimmingCharacters(in: .whitespaces)
          guard let d = crudo.data(using: .utf8),
                let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
          else { continue }
          if despachar(evento: evento, cuerpo: j, alRecibir: alRecibir) { return }
        }
      }
      alRecibir(.fin)
    } catch {
      alRecibir(.fallo("Se cortó la conexión"))
    }
  }

  /// Devuelve `true` cuando el turno terminó y hay que soltar el stream.
  ///
  /// OJO con el contrato: el NOMBRE del evento SSE es siempre `turn` — el tipo
  /// real viaja dentro, en `kind`. Mirar el nombre del evento (que es lo que
  /// haría cualquiera viniendo de un SSE normal) descarta absolutamente todo y
  /// el turno se ve como una pantalla en blanco.
  @discardableResult
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
