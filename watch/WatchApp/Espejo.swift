import Foundation
import SwiftUI
import WatchKit

/// "Espejo": el reloj sigue un chat del Laboratorio que arrancó OTRO
/// dispositivo (la web o el iPhone) — ver `POST/GET/DELETE /watch/link` y
/// `apps/agent/src/watch/active-link.ts` en el servidor.
///
/// Es un canal DISTINTO del de `Agente.swift`: ahí el reloj pregunta algo
/// propio por `/watch/ask` (sesión rápida, sin tools). Acá el reloj no
/// pregunta nada — se cuelga de un turno de `/chat/turns/:id` que YA existe,
/// con el MISMO contrato que ya usa `Container/Turnos.swift` en el iPhone.
/// Por eso la lógica de seguimiento de abajo es un calco de esa, no algo
/// nuevo: reconexión con cursor (`seq`), el nombre del evento SIEMPRE es
/// "turn" con el tipo real en `kind` (ver el comentario largo allá).
enum Espejo {
  struct Vinculo {
    let turnId: String
    let title: String
  }

  /// Lo que le importa a la pantalla del reloj. `desconectado` no es un
  /// fallo del turno — puede seguir vivo del otro lado — es "se perdió la
  /// conexión desde acá", y se avisa distinto.
  enum Evento {
    case texto(String)
    case paso(nombre: String, objetivo: String)
    case fin(gist: String)
    case error(String)
    case desconectado
  }

  private static var clave: String {
    (Bundle.main.object(forInfoDictionaryKey: "HermesAPIKey") as? String) ?? ""
  }

  private static func peticion(_ ruta: String, metodo: String = "GET",
                               cuerpo: [String: Any]? = nil) -> URLRequest? {
    guard let u = URL(string: Agente.base + ruta) else { return nil }
    var r = URLRequest(url: u)
    r.httpMethod = metodo
    r.setValue("Bearer \(clave)", forHTTPHeaderField: "Authorization")
    if let cuerpo {
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = try? JSONSerialization.data(withJSONObject: cuerpo)
    }
    return r
  }

  /// ¿Hay un chat vinculado ahora mismo? Lo pregunta el gesto que abre el
  /// espejo (mantener presionado el orbe, ver ContentView).
  static func vinculoActivo() async -> Vinculo? {
    guard Agente.configurado, let r = peticion("/watch/link") else { return nil }
    guard let (d, resp) = try? await URLSession.shared.data(for: r),
          (resp as? HTTPURLResponse)?.statusCode == 200,
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          j["linked"] as? Bool == true,
          let turnId = j["turn_id"] as? String else { return nil }
    return Vinculo(turnId: turnId, title: (j["title"] as? String ?? ""))
  }

  /// Frase de una línea para el texto final (ver `POST /chat/gist`). Si el
  /// servidor no puede o el texto ya es corto, cae a `sinMarcas` a pelo —
  /// nunca se deja al reloj sin nada que mostrar por esto.
  private static func resumir(_ texto: String) async -> String {
    guard let r = peticion("/chat/gist", metodo: "POST", cuerpo: ["text": texto]) else { return "" }
    guard let (d, resp) = try? await URLSession.shared.data(for: r),
          (resp as? HTTPURLResponse)?.statusCode == 200,
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return "" }
    return (j["gist"] as? String ?? "").trimmingCharacters(in: .whitespaces)
  }

  private static let MAX_RECONEXIONES = 5
  private static let ESPERAS: [Double] = [0.5, 1.5, 3, 6, 10]

  /// Sigue el turno vinculado desde `desde` hasta que cierre.
  ///
  /// Vibra al terminar (éxito o fallo) y si se pierde la conexión de
  /// verdad — pero SOLO mientras esta función sigue corriendo, o sea con la
  /// vista del espejo abierta en el reloj. watchOS no deja código de
  /// terceros en segundo plano indefinido: avisar con el reloj CERRADO es
  /// otra pieza (push real vía APNs), no esta.
  static func seguir(turnId: String, desde: Int = 0,
                     alRecibir: @escaping (Evento) -> Void) async {
    var seq = desde
    var textoActual = ""
    var intentos = 0

    while !Task.isCancelled {
      // "done" | "stopped" | "error", o nil si el stream se cortó sin cerrar
      // el turno (hay que reconectar).
      var resultado: String?
      var mensajeError = ""
      guard var r = peticion("/chat/turns/\(turnId)/stream?from=\(seq)") else { return }
      r.timeoutInterval = 600

      do {
        let (bytes, _) = try await URLSession.shared.bytes(for: r)
        intentos = 0 // conexión buena: se resetea
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
              // Snapshot al enganchar: texto ÍNTEGRO ya acumulado en el
              // servidor. Se reemplaza, no se concatena.
              if let t = j["text"] as? String { textoActual = t }
              if !textoActual.isEmpty { alRecibir(.texto(textoActual)) }
            case "turn":
              switch j["kind"] as? String {
              case "delta":
                if let t = j["text"] as? String, !t.isEmpty {
                  textoActual += t
                  alRecibir(.texto(textoActual))
                }
              case "tool":
                let tool = j["tool"] as? [String: Any] ?? [:]
                let nombre = tool["name"] as? String ?? ""
                if !nombre.isEmpty {
                  alRecibir(.paso(nombre: nombre, objetivo: tool["target"] as? String ?? ""))
                }
              case "done", "stopped":
                resultado = j["kind"] as? String
              case "error":
                resultado = "error"
                mensajeError = j["text"] as? String ?? "El turno falló"
              default:
                break
              }
            case "end":
              resultado = resultado ?? (j["status"] as? String ?? "done")
            default:
              break
            }
            if resultado != nil { break }
          }
        }
      } catch {
        /* se cayó: se reintenta abajo con el cursor actualizado */
      }

      if let resultado {
        if resultado == "error" {
          WKInterfaceDevice.current().play(.failure)
          alRecibir(.error(mensajeError))
        } else {
          WKInterfaceDevice.current().play(.success)
          let gist = await resumir(textoActual)
          alRecibir(.fin(gist: gist.isEmpty ? sinMarcas(textoActual) : gist))
        }
        return
      }

      if Task.isCancelled { return }
      intentos += 1
      if intentos > MAX_RECONEXIONES {
        WKInterfaceDevice.current().play(.retry)
        alRecibir(.desconectado)
        return
      }
      try? await Task.sleep(for: .seconds(ESPERAS[min(intentos - 1, ESPERAS.count - 1)]))
    }
  }
}

/// La pantalla del espejo. Reusa `Respuesta` (misma cara que la vía rápida
/// del reloj) para no inventar una segunda forma de mostrar texto/pasos —
/// solo cambia de dónde sale el contenido.
struct EspejoView: View {
  let vinculo: Espejo.Vinculo
  let alVolver: () -> Void

  private enum Estado {
    case siguiendo
    case terminado(String)
    case fallo(String)
    case desconectado
  }

  @State private var texto = ""
  @State private var paso: Paso?
  @State private var estado: Estado = .siguiendo

  var body: some View {
    Respuesta(paso: paso, texto: cuerpo, imagen: nil, corriendo: corriendo, alTocar: alVolver)
      .overlay(alignment: .top) {
        if !vinculo.title.isEmpty {
          Text(vinculo.title)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.top, 4)
        }
      }
      .task {
        await Espejo.seguir(turnId: vinculo.turnId) { ev in
          Task { @MainActor in aplicar(ev) }
        }
      }
  }

  private var cuerpo: String {
    switch estado {
    case .siguiendo: sinMarcas(texto)
    case .terminado(let g): g
    case .fallo(let m): m
    case .desconectado: "Se perdió la conexión. El chat puede seguir corriendo — vuelve a intentarlo."
    }
  }

  private var corriendo: Bool {
    if case .siguiendo = estado { return true }
    return false
  }

  @MainActor
  private func aplicar(_ ev: Espejo.Evento) {
    switch ev {
    case .texto(let t):
      paso = nil
      texto = t
    case .paso(let n, let o):
      withAnimation(.easeInOut(duration: 0.18)) { paso = Paso(nombre: n, objetivo: o) }
    case .fin(let gist):
      paso = nil
      estado = .terminado(gist)
    case .error(let m):
      paso = nil
      estado = .fallo(m)
    case .desconectado:
      paso = nil
      estado = .desconectado
    }
  }
}
