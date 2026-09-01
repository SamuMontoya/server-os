import SwiftUI

/// El orbe girando: el "está trabajando".
///
/// Reemplaza a las barras de skeleton, igual que se hizo en la web: un
/// skeleton dice "esto se está cargando", y lo que pasa aquí es que alguien
/// está PENSANDO. Y mantiene en pantalla al mismo personaje en vez de
/// cambiarlo por un widget genérico a mitad de la interacción.
struct OrbePensando: View {
  var lado: CGFloat = 30

  var body: some View {
    TimelineView(.animation) { t in
      let s = t.date.timeIntervalSinceReferenceDate
      // El anillo gira y respira. Sin la respiración se lee como un spinner
      // cualquiera; con ella parece vivo.
      let giro = (s.truncatingRemainder(dividingBy: 1.4) / 1.4) * 360
      let respira = 1 + 0.06 * sin(s * 2.4)

      ZStack {
        Circle()
          .strokeBorder(
            AngularGradient(
              colors: [Color(red: 0.91, green: 0.40, blue: 0.24),
                       Color(red: 0.23, green: 0.51, blue: 0.84),
                       Color(red: 0.11, green: 0.62, blue: 0.46),
                       Color(red: 0.91, green: 0.40, blue: 0.24)],
              center: .center),
            lineWidth: lado * 0.13)
          .rotationEffect(.degrees(giro))
        // Sin ojos, como se pidió para el estado de "operando": el orbe con
        // ojos es el personaje mirándote; sin ojos es el personaje ocupado.
      }
      .frame(width: lado, height: lado)
      .scaleEffect(respira)
    }
  }
}
