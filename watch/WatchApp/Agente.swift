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
  /// UNA sola dirección: la pública.
  ///
  /// Antes había tres (LAN, tailnet, Funnel) sondeadas en paralelo. Se quitan
  /// las privadas, y no por gusto — por cómo funciona la red en watchOS:
  ///
  /// · Con el iPhone cerca, watchOS NO usa la red del reloj: manda la petición
  ///   por un túnel IPsec al teléfono y la hace ÉL (WWDC15/711). Así que "la
  ///   LAN de casa" no es la del reloj, es la del iPhone, y depende de dónde
  ///   esté el teléfono, no el reloj.
  /// · Hay un fallo ABIERTO de Apple (FB23469093, reportado en watchOS 26.5
  ///   con un Apple Watch SE 3) por el que si el iPhone está cerca pero sin
  ///   internet, watchOS insiste en el túnel y NUNCA cae a la wifi del reloj.
  ///   Apple no tiene solución ni API pública para forzar la otra ruta. Tener
  ///   tres direcciones no lo esquiva: las tres salen por el mismo túnel roto.
  /// · Y el Funnel funciona en las dos situaciones, dentro y fuera de casa.
  ///
  /// La ganancia real es quitar peticiones: en watchOS cada una se paga por el
  /// túnel Bluetooth, y Apple pide "reducir el número de peticiones al mínimo
  /// absoluto" (WWDC19/716).
  static var bases: [String] {
    ["HermesURLPub", "HermesURL", "HermesURLAlt"]
      .compactMap { Bundle.main.object(forInfoDictionaryKey: $0) as? String }
      .filter { !$0.isEmpty }
  }
  static var base: String { bases.first ?? "" }

  static var configurado: Bool { !bases.isEmpty }

  private static var clave: String {
    (Bundle.main.object(forInfoDictionaryKey: "HermesAPIKey") as? String) ?? ""
  }

  /// Sesión propia, no `URLSession.shared`.
  ///
  /// `waitsForConnectivity` es lo que Apple recomienda EN LUGAR de sondear
  /// (Tech Talk 111378: "los chequeos previos suelen ser incorrectos"). En vez
  /// de preguntar si hay red, se lanza la petición y el sistema la retiene
  /// hasta que se pueda, avisando en vez de fallar.
  ///
  /// OJO con su alcance: solo cubre ESTABLECER la conexión. Si se cae a mitad,
  /// llega el error igual — por eso sigue habiendo reintentos abajo.
  private static let sesionHTTP: URLSession = {
    let c = URLSessionConfiguration.default
    c.waitsForConnectivity = true
    // Generoso a propósito: una escalada con tools puede tardar minutos, y el
    // servidor manda un latido cada 3s para que no parezca colgada.
    c.timeoutIntervalForRequest = 90
    c.timeoutIntervalForResource = 600
    return URLSession(configuration: c)
  }()

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
    // Reintentos con espera creciente. Hacen falta a pesar de
    // `waitsForConnectivity`: ese cubre "todavía no hay red", no "el túnel al
    // iPhone está en pie pero no lleva a ningún sitio", que es el fallo
    // abierto de Apple. Tres intentos y se rinde, porque en la muñeca esperar
    // más ya no es útil.
    let esperas: [Double] = [0.6, 2.0]
    for intento in 0...esperas.count {
      if await intentar(base, texto: texto, sesion: sesion,
                        alRecibir: alRecibir, silencioso: intento < esperas.count) {
        return
      }
      if intento < esperas.count {
        try? await Task.sleep(for: .seconds(esperas[intento]))
      }
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
