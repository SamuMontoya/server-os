import SwiftUI

/// Pie de la conversación: consumo · modelo · reloj de reinicio.
///
///     39%              Opus              1h 4'
///
/// Tres columnas sin cajas ni iconos. No espera a que estén los tres: si el
/// consumo falla, el modelo sigue vivo. Lo que no se sabe se deja EN BLANCO y
/// no con un guion, y la fila reserva su alto — así no salta cuando aparece el
/// modelo a mitad del turno.
struct BarraEstado: View {
  let modelo: String?
  @StateObject private var limites = Limites()

  var body: some View {
    HStack(spacing: 0) {
      Text(limites.pct.map { "\($0)%" } ?? "")
        .frame(maxWidth: .infinity, alignment: .leading)
      Text(modelo?.capitalized ?? "")
        .frame(maxWidth: .infinity, alignment: .center)
      Text(limites.restante ?? "")
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .font(.system(size: 12))
    .foregroundStyle(LabView.apagado)
    .frame(height: 15)
    .task { await limites.cargar() }
  }
}

/// Consumo del plan, del endpoint `/limits` del agente.
///
/// La web lo lee con su propia ruta de Next; esta app no puede, así que el
/// agente lo expone. Se pide UNA vez al abrir: el dato cambia por minutos, no
/// por segundos, y el endpoint de origen es de Anthropic y tiene límite —
/// pedirlo en cada turno nos daba 429.
@MainActor
final class Limites: ObservableObject {
  @Published var pct: Int?
  /// "1h 4'" — lo que queda de la ventana de 5 h.
  @Published var restante: String?

  func cargar() async {
    guard let base = await Turnos.servidor(),
          let u = URL(string: "\(base)/limits") else { return }
    var r = URLRequest(url: u)
    r.setValue("Bearer \(Turnos.claveParaLimites)", forHTTPHeaderField: "Authorization")
    r.timeoutInterval = 10
    guard let (d, _) = try? await URLSession.shared.data(for: r),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }

    if let p = j["pct"] as? Double { pct = Int(p.rounded()) }
    if let iso = j["resetsAt"] as? String {
      restante = Self.cuantoFalta(iso)
    }
  }

  /// "1h 4'". Se redondea hacia ARRIBA: mientras quede un segundo de ese
  /// minuto, el minuto cuenta — decir "0'" con tiempo restante es peor que
  /// sobrar por uno.
  private static func cuantoFalta(_ iso: String) -> String? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let fecha = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let fecha else { return nil }
    let seg = fecha.timeIntervalSinceNow
    guard seg > 0 else { return nil }
    let mins = Int(ceil(seg / 60))
    let h = mins / 60
    let m = mins % 60
    return h > 0 ? "\(h)h \(m)'" : "\(m)'"
  }
}
