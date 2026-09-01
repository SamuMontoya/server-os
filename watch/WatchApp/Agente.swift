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

  /// Turno en vuelo, guardado en disco.
  ///
  /// watchOS suspende la app al bajar la muñeca y eso mata el SSE. Con el id y
  /// el cursor guardados, al volver se recupera lo que se perdió en vez de
  /// darlo por muerto. Va a UserDefaults porque tiene que sobrevivir a que el
  /// sistema mate el proceso, no solo a que se oculte.
  private static var pendiente: (id: String, seq: Int)? {
    get {
      guard let d = UserDefaults.standard.dictionary(forKey: "turnoReloj"),
            let id = d["id"] as? String else { return nil }
      return (id, d["seq"] as? Int ?? 0)
    }
    set {
      if let n = newValue {
        UserDefaults.standard.set(["id": n.id, "seq": n.seq], forKey: "turnoReloj")
      } else {
        UserDefaults.standard.removeObject(forKey: "turnoReloj")
      }
    }
  }

  /// ¿Había un turno a medias? Se re-engancha desde su cursor.
  ///
  /// Devuelve `false` si no había nada que recuperar, para que quien llama
  /// sepa si tiene que pintar la pantalla de reposo.
  static func recuperar(alRecibir: @escaping (Evento) -> Void) async -> Bool {
    guard let p = pendiente, configurado else { return false }
    guard let u = URL(string: "\(base)/watch/turns/\(p.id)/stream?from=\(p.seq)") else {
      return false
    }
    var r = URLRequest(url: u)
    r.setValue("Bearer \(clave)", forHTTPHeaderField: "Authorization")

    do {
      let (bytes, resp) = try await sesionHTTP.bytes(for: r)
      // 404 = el turno ya no existe (caducó o el agente reinició): pérdida
      // confirmada, se limpia. Cualquier otro fallo se deja para el próximo
      // arranque, porque puede ser solo red.
      if (resp as? HTTPURLResponse)?.statusCode == 404 {
        pendiente = nil
        return false
      }
      var evento = ""
      var seq = p.seq
      for try await linea in bytes.lines {
        if linea.hasPrefix("event:") {
          evento = String(linea.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if linea.hasPrefix("data:") {
          let crudo = String(linea.dropFirst(5)).trimmingCharacters(in: .whitespaces)
          let j = (try? JSONSerialization.jsonObject(
            with: Data(crudo.utf8))) as? [String: Any] ?? [:]
          seq += 1
          pendiente = (p.id, seq)
          if despacharEvento(evento, j, alRecibir: alRecibir) {
            pendiente = nil
            return true
          }
        }
      }
      return true
    } catch {
      return false
    }
  }

  /// Reparte un evento del stream. Devuelve `true` si el turno cerró.
  ///
  /// Vive aparte porque lo usan DOS caminos —la pregunta nueva y el
  /// re-enganche— y tenerlo duplicado garantizaba que un día divergieran.
  private static func despacharEvento(_ evento: String, _ j: [String: Any],
                                      alRecibir: @escaping (Evento) -> Void) -> Bool {
    switch evento {
    case "delta":
      if let t = j["text"] as? String, !t.isEmpty { alRecibir(.texto(t)) }
    case "paso":
      if let n = j["name"] as? String, !n.isEmpty {
        alRecibir(.paso(nombre: n, objetivo: j["target"] as? String ?? ""))
      }
    case "imagen":
      if let u = j["url"] as? String, let url = URL(string: u) { alRecibir(.imagen(url)) }
    case "escala":
      alRecibir(.escala)
    case "latido", "turno":
      break
    case "fin":
      alRecibir(.fin)
      return true
    default:
      break
    }
    return false
  }


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

  /// Devuelve `true` si el turno se completó.
  ///
  /// OJO con reintentar: `/watch/ask` NO es idempotente — puede apuntar una
  /// idea en la base y siempre alimenta la memoria de la sesión rápida. Si ya
  /// se vio texto, repetir duplicaría el trabajo del servidor y la respuesta
  /// en pantalla. Por eso `hablo` corta los reintentos.
  private static func intentar(_ servidor: String, texto: String, sesion: String,
                               alRecibir: @escaping (Evento) -> Void,
                               silencioso: Bool) async -> Bool {
    guard let u = URL(string: "\(servidor)/watch/ask") else { return false }

    /// Se enciende cuando el usuario YA vio u oyó algo. A partir de ahí no se
    /// puede reintentar: /watch/ask escribe en la base y alimenta la memoria
    /// de la sesión, así que repetir duplicaría las dos cosas.
    var hablo = false
    /// El servidor cierra con `fin`. Acabar sin él es un CORTE, no un final.
    var vioFin = false

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
      var seq = 0
      for try await linea in bytes.lines {
        if linea.hasPrefix("event:") {
          evento = String(linea.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if linea.hasPrefix("data:") {
          let crudo = String(linea.dropFirst(5)).trimmingCharacters(in: .whitespaces)
          let j = (try? JSONSerialization.jsonObject(
            with: Data(crudo.utf8))) as? [String: Any] ?? [:]
          // El servidor manda el id como primer evento: se guarda para poder
          // volver si la muñeca baja a mitad de la respuesta.
          if evento == "turno", let id = j["id"] as? String {
            pendiente = (id, 0)
            continue
          }
          seq += 1
          if let p = pendiente { pendiente = (p.id, seq) }
          if evento == "delta" || evento == "paso" || evento == "imagen" { hablo = true }
          if despacharEvento(evento, j, alRecibir: alRecibir) {
            vioFin = true
            pendiente = nil
            return true
          }
        }
      }
      if vioFin { return true }
      // Se acabó el stream sin que el servidor dijera `fin`.
      if hablo {
        // Ya se vio texto: no se reintenta (no es idempotente), pero tampoco
        // se miente diciendo que terminó bien.
        alRecibir(.fallo("Se cortó a medias"))
        return true
      }
      if !silencioso { alRecibir(.fallo("El servidor no dijo nada")) }
      return false
    } catch {
      // Si ya habló, se corta aquí: reintentar duplicaría lo dicho.
      if hablo {
        alRecibir(.fallo("Se cortó a medias"))
        return true
      }
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
