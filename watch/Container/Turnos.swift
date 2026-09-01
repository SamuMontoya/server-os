import Foundation

/// Cliente de los turnos del chat, puerto de `apps/web/src/lib/chat-turns.ts`.
///
/// LA GRACIA ES LA MISMA QUE EN LA WEB: el turno no vive dentro de la
/// petición, es un TRABAJO DEL SERVIDOR con id propio. Se arranca, se escucha,
/// y si se pierde la conexión se vuelve a enganchar DESDE EL CURSOR (`seq`).
/// En un iPhone eso no es un lujo: iOS congela la app al bloquear la pantalla,
/// y con un stream a pelo la respuesta se perdía a media frase. Irse no
/// cancela nada; cancelar es pulsar ⏹.
enum Turnos {
  // ── Configuración (inyectada al compilar desde el .env) ──────────────────
  static var bases: [String] {
    ["HermesURL", "HermesURLAlt", "HermesURLPub"]
      .compactMap { Bundle.main.object(forInfoDictionaryKey: $0) as? String }
      .filter { !$0.isEmpty }
  }
  private static var clave: String {
    (Bundle.main.object(forInfoDictionaryKey: "HermesAPIKey") as? String) ?? ""
  }

  private static var ultimaBuena: String? {
    get { UserDefaults.standard.string(forKey: "labBase") }
    set { UserDefaults.standard.set(newValue, forKey: "labBase") }
  }

  /// Igual que en el reloj: las direcciones se sondean A LA VEZ con un plazo
  /// real. En serie, una IP que se traga los paquetes (la LAN de casa vista
  /// desde fuera) bloquea a las siguientes y la app dice "sin conexión"
  /// teniendo otra viva. Y `URLRequest.timeoutInterval` no sirve de plazo: es
  /// el tiempo sin recibir DATOS, no un límite para conectar.
  static func servidor() async -> String? {
    if let u = ultimaBuena, await vive(u) { return u }
    let orden = bases
    let vivas = await withTaskGroup(of: (Int, Bool).self) { g in
      for (i, s) in orden.enumerated() { g.addTask { (i, await vive(s)) } }
      var ok: [Int] = []
      for await (i, v) in g where v { ok.append(i) }
      return ok.sorted()
    }
    guard let i = vivas.first else { return nil }
    ultimaBuena = orden[i]
    return orden[i]
  }

  private static func vive(_ base: String, plazo: Double = 2.5) async -> Bool {
    guard let u = URL(string: "\(base)/health") else { return false }
    return await withTaskGroup(of: Bool.self) { g in
      g.addTask {
        var r = URLRequest(url: u)
        r.timeoutInterval = plazo
        r.cachePolicy = .reloadIgnoringLocalCacheData
        let ok = try? await URLSession.shared.data(for: r)
        return (ok?.1 as? HTTPURLResponse)?.statusCode == 200
      }
      g.addTask { try? await Task.sleep(for: .seconds(plazo)); return false }
      let p = await g.next() ?? false
      g.cancelAll()
      return p
    }
  }

  private static func peticion(_ base: String, _ ruta: String, metodo: String = "GET",
                               cuerpo: [String: Any]? = nil) -> URLRequest? {
    guard let u = URL(string: base + ruta) else { return nil }
    var r = URLRequest(url: u)
    r.httpMethod = metodo
    r.setValue("Bearer \(clave)", forHTTPHeaderField: "Authorization")
    if let cuerpo {
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = try? JSONSerialization.data(withJSONObject: cuerpo)
    }
    return r
  }

  // ── Estado de un turno ───────────────────────────────────────────────────
  struct Estado {
    var status: String
    /// Texto ÍNTEGRO acumulado en el SERVIDOR: con esto se repinta sin dudas.
    var text: String
    var steps: [Paso]
    var seq: Int
    /// El buffer botó eventos: hay que repintar con `text`, no concatenar.
    var truncated: Bool
    var model: String?
    var sdkSessionId: String?
  }

  // ── Arrancar ─────────────────────────────────────────────────────────────
  static func arrancar(mensaje: String, sesion: String, resume: String?,
                      adjuntos: [String] = []) async throws -> (String, String) {
    guard let base = await servidor() else {
      throw NSError(domain: "hermes", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Sin conexión con el servidor"])
    }
    var cuerpo: [String: Any] = ["message": mensaje, "session_key": sesion]
    if let resume { cuerpo["resume"] = resume }
    if !adjuntos.isEmpty { cuerpo["attachments"] = adjuntos }
    guard let r = peticion(base, "/chat/turns", metodo: "POST", cuerpo: cuerpo) else {
      throw NSError(domain: "hermes", code: -2)
    }
    let (d, resp) = try await URLSession.shared.data(for: r)
    guard (resp as? HTTPURLResponse)?.statusCode == 200,
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let id = j["turn_id"] as? String else {
      throw NSError(domain: "hermes", code: -3,
                    userInfo: [NSLocalizedDescriptionKey: "El agente no aceptó el turno"])
    }
    return (id, base)
  }

  /// Estado del turno sin abrir stream, con reintentos.
  ///
  /// No se rinde ante un tropiezo transitorio: un 5xx del agente
  /// reiniciándose o un blip de red NO significan que el turno se perdió.
  /// Solo un 404 es pérdida real. Devuelve nil cuando se agotan los intentos
  /// sin poder confirmar nada — el llamador debe tratarlo como "todavía no se
  /// sabe", no como "perdido", o hará repetir una pregunta que sigue viva.
  static func estado(_ base: String, _ turno: String, desde: Int = 0,
                     intentos: Int = 4) async -> Estado?? {
    let esperas = [0.4, 1.2, 2.5, 5.0]
    for i in 0..<intentos {
      if let r = peticion(base, "/chat/turns/\(turno)?from=\(desde)"),
         let (d, resp) = try? await URLSession.shared.data(for: r) {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { return .some(nil) }          // pérdida confirmada
        if code == 200, let e = parsearEstado(d) { return .some(e) }
      }
      if i < intentos - 1 { try? await Task.sleep(for: .seconds(esperas[i])) }
    }
    return nil                                        // no se sabe
  }

  static func detener(_ base: String, _ turno: String) async {
    guard let r = peticion(base, "/chat/turns/\(turno)/stop", metodo: "POST") else { return }
    _ = try? await URLSession.shared.data(for: r)
  }

  /// Sube una imagen y devuelve su id.
  ///
  /// El servidor la guarda en disco y al modelo le pasa la RUTA, que abre con
  /// `Read`. Por eso el turno viaja con ids y no con base64: mandar cuatro
  /// capturas cuesta lo mismo que ninguna.
  static func subirImagen(_ base: String, datos: Data, nombre: String) async -> String? {
    guard let u = URL(string: base + "/chat/attachments") else { return nil }
    let linde = "hermes-\(UUID().uuidString)"
    var r = URLRequest(url: u)
    r.httpMethod = "POST"
    r.setValue("Bearer \(clave)", forHTTPHeaderField: "Authorization")
    r.setValue("multipart/form-data; boundary=\(linde)", forHTTPHeaderField: "Content-Type")
    r.timeoutInterval = 60

    var cuerpo = Data()
    cuerpo.append("--\(linde)\r\n".data(using: .utf8)!)
    cuerpo.append("Content-Disposition: form-data; name=\"image\"; filename=\"\(nombre)\"\r\n"
      .data(using: .utf8)!)
    cuerpo.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
    cuerpo.append(datos)
    cuerpo.append("\r\n--\(linde)--\r\n".data(using: .utf8)!)
    r.httpBody = cuerpo

    guard let (d, resp) = try? await URLSession.shared.data(for: r),
          (resp as? HTTPURLResponse)?.statusCode == 200,
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
    return j["id"] as? String
  }

  private static func parsearEstado(_ d: Data) -> Estado? {
    guard let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
    return Estado(
      status: j["status"] as? String ?? "running",
      text: j["text"] as? String ?? "",
      steps: (j["steps"] as? [[String: Any]] ?? []).compactMap(Paso.desde),
      seq: j["seq"] as? Int ?? 0,
      truncated: j["truncated"] as? Bool ?? false,
      model: j["model"] as? String,
      sdkSessionId: j["sdkSessionId"] as? String)
  }

  // ── Seguir el turno ──────────────────────────────────────────────────────
  enum Evento {
    case estado(Estado)
    case delta(String, Int)
    case paso(Paso, Int)
    case modelo(String)
    case sesion(String)
    case fin(String, Int)
    /// Se agotaron las reconexiones. El turno PUEDE seguir vivo del otro lado.
    case desconectado(Int)
  }

  private static let MAX_RECONEXIONES = 5
  private static let ESPERAS: [Double] = [0.5, 1.5, 3, 6, 10]

  /// Engancha el turno desde `desde` y lo sigue hasta que cierre.
  ///
  /// La reconexión se hace A MANO en vez de dejársela al sistema: un reintento
  /// automático repetiría la MISMA url —o sea el mismo `from`— y volvería a
  /// mandar deltas ya pintados. Aquí cada reconexión usa el cursor actualizado.
  static func seguir(_ base: String, turno: String, desde: Int,
                     alRecibir: @escaping (Evento) -> Void) async {
    var seq = desde
    var intentos = 0

    while !Task.isCancelled {
      var cerrado = false
      guard var r = peticion(base, "/chat/turns/\(turno)/stream?from=\(seq)") else { return }
      r.timeoutInterval = 600

      do {
        let (bytes, _) = try await URLSession.shared.bytes(for: r)
        intentos = 0                                  // conexión buena: se resetea
        var evento = ""
        for try await linea in bytes.lines {
          if Task.isCancelled { return }
          if linea.hasPrefix("event:") {
            evento = String(linea.dropFirst(6)).trimmingCharacters(in: .whitespaces)
          } else if linea.hasPrefix("data:") {
            let crudo = String(linea.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            guard let j = try? JSONSerialization.jsonObject(
              with: Data(crudo.utf8)) as? [String: Any] else { continue }
            if let s = j["seq"] as? Int { seq = max(seq, s) }

            switch evento {
            case "state":
              if let e = parsearEstado(Data(crudo.utf8)) { alRecibir(.estado(e)) }
            case "turn":
              // OJO: el nombre del evento es SIEMPRE "turn" — el tipo real va
              // dentro, en `kind`. Mirar el nombre del evento (lo natural
              // viniendo de un SSE normal) descarta todo y el turno se ve
              // como una pantalla en blanco.
              switch j["kind"] as? String {
              case "delta":
                if let t = j["text"] as? String, !t.isEmpty {
                  alRecibir(.delta(t, seq))
                }
              case "tool":
                if let p = Paso.desde(j["tool"] as? [String: Any] ?? [:]) {
                  alRecibir(.paso(p, seq))
                }
              case "model":
                if let m = j["model"] as? String { alRecibir(.modelo(m)) }
              case "session":
                if let s = j["sessionId"] as? String { alRecibir(.sesion(s)) }
              case "done", "stopped", "error":
                alRecibir(.fin(j["kind"] as? String ?? "done", seq))
                cerrado = true
              default:
                break
              }
            case "end":
              alRecibir(.fin(j["status"] as? String ?? "done", seq))
              cerrado = true
            default:
              break
            }
            if cerrado { return }
          }
        }
      } catch {
        /* se cayó: se reintenta abajo con el cursor actualizado */
      }

      if cerrado || Task.isCancelled { return }
      intentos += 1
      if intentos > MAX_RECONEXIONES {
        // No se dice "falló": el turno sigue trabajando del otro lado y al
        // volver a la app se recupera desde este mismo cursor.
        alRecibir(.desconectado(seq))
        return
      }
      try? await Task.sleep(for: .seconds(ESPERAS[min(intentos - 1, ESPERAS.count - 1)]))
    }
  }
}
