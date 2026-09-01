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
  /// TRES direcciones, probadas en orden: LAN → tailnet → Funnel público.
  ///
  /// La LAN primero porque es directa y no sale de casa. El tailnet después.
  /// Y la pública al final, que es la ÚNICA que funciona fuera de casa: el
  /// reloj no corre Tailscale (watchOS no lo soporta) y NO hereda la VPN del
  /// iPhone —su tráfico va por su propia pila de red—, así que sin una URL
  /// alcanzable desde internet se queda sin conexión en la calle.
  ///
  /// El orden importa por algo más que la velocidad: probar primero las
  /// privadas evita sacar el tráfico a internet cuando no hace falta.
  static var bases: [String] {
    ["HermesURL", "HermesURLAlt", "HermesURLPub"]
      .compactMap { Bundle.main.object(forInfoDictionaryKey: $0) as? String }
      .filter { !$0.isEmpty }
  }
  static var base: String { bases.first ?? "" }
  private static var clave: String {
    (Bundle.main.object(forInfoDictionaryKey: "HermesAPIKey") as? String) ?? ""
  }

  static var configurado: Bool { !bases.isEmpty }

  /// La última dirección que funcionó, recordada entre sesiones.
  ///
  /// Sin esto, fuera de casa el reloj probaría la LAN primero y esperaría su
  /// timeout ENTERO antes de pasar a la siguiente — la app se sentiría
  /// colgada justo cuando más la necesitas. Recordando la buena, el caso
  /// normal es un solo sondeo.
  private static var ultimaBuena: String? {
    get { UserDefaults.standard.string(forKey: "ultimaBase") }
    set { UserDefaults.standard.set(newValue, forKey: "ultimaBase") }
  }

  /// Orden de intento: la que funcionó la última vez y luego las demás.
  private static var ordenadas: [String] {
    guard let u = ultimaBuena, bases.contains(u) else { return bases }
    return [u] + bases.filter { $0 != u }
  }

  /// Sondea `/health` (que no pide autenticación) con un plazo REAL.
  ///
  /// OJO con `timeoutInterval`: es el tiempo sin recibir DATOS, no un límite
  /// para establecer la conexión. Contra una IP que se traga los paquetes
  /// —una LAN ajena, por ejemplo— la petición se queda colgada mucho más de
  /// lo que ese valor promete: medido, 8 segundos con un plazo de 2,5. De ahí
  /// la carrera contra un `Task.sleep`, que sí corta de verdad.
  private static func vive(_ servidor: String, plazo: Double = 2.5) async -> Bool {
    guard let u = URL(string: "\(servidor)/health") else { return false }
    return await withTaskGroup(of: Bool.self) { grupo in
      grupo.addTask {
        var r = URLRequest(url: u)
        r.timeoutInterval = plazo
        r.cachePolicy = .reloadIgnoringLocalCacheData
        do {
          let (_, resp) = try await URLSession.shared.data(for: r)
          return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch {
          return false
        }
      }
      grupo.addTask {
        try? await Task.sleep(for: .seconds(plazo))
        return false
      }
      let primero = await grupo.next() ?? false
      grupo.cancelAll()
      return primero
    }
  }

  /// Elige servidor probando TODAS las direcciones A LA VEZ.
  ///
  /// En serie, una dirección colgada bloquea a las siguientes y el reloj dice
  /// "sin conexión" aunque otra estuviera perfectamente viva — que es
  /// exactamente lo que pasaba fuera de casa. En paralelo cuesta el plazo de
  /// UNA, no la suma, y gana la que responda antes.
  ///
  /// El desempate lo lleva el orden de `ordenadas`: si dos contestan dentro
  /// del mismo instante, se prefiere la privada.
  private static func elegirServidor() async -> String? {
    let candidatas = ordenadas
    let vivas = await withTaskGroup(of: (Int, Bool).self) { grupo in
      for (i, s) in candidatas.enumerated() {
        grupo.addTask { (i, await vive(s)) }
      }
      var res: [Int] = []
      for await (i, ok) in grupo where ok { res.append(i) }
      return res.sorted()
    }
    guard let mejor = vivas.first else { return nil }
    return candidatas[mejor]
  }

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
    guard let servidor = await elegirServidor() else {
      alRecibir(.fallo("Sin conexión con el servidor"))
      return
    }
    if await intentar(servidor, texto: texto, sesion: sesion,
                      alRecibir: alRecibir, silencioso: false) {
      ultimaBuena = servidor
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
