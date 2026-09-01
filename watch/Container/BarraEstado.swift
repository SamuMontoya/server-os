import SwiftUI

/// Pie de la conversación: consumo · modelo · reloj de reinicio.
///
/// Tres columnas sin cajas ni iconos, como `LabStatusBar.tsx`:
///
///     35%              Opus              2h 15'
///
/// No espera a que estén los tres: si falta uno, los otros se pintan igual.
/// Lo que todavía no se sabe se deja EN BLANCO y no con un guion, y la fila
/// reserva su alto — así no salta cuando aparece el modelo a mitad del turno.
///
/// EL PORCENTAJE NO ESTÁ TODAVÍA, y no por descuido: sale del endpoint privado
/// de OAuth de Anthropic, que la web lee SOLO DESDE SERVIDOR con un token de
/// disco. El agente no lo expone, así que el iPhone no tiene de dónde
/// pedirlo — hace falta añadirle una ruta al agente primero.
struct BarraEstado: View {
  let modelo: String?

  var body: some View {
    HStack {
      Text("")                                  // consumo: pendiente
        .frame(maxWidth: .infinity, alignment: .leading)
      Text(modelo?.capitalized ?? "")
        .frame(maxWidth: .infinity, alignment: .center)
      Text("")                                  // reinicio: pendiente
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .font(.system(size: 11))
    .foregroundStyle(LabView.apagado)
    // Alto reservado: sin esto la fila aparece de golpe cuando llega el
    // modelo y empuja el composer hacia abajo a mitad de la respuesta.
    .frame(height: 13)
  }
}
