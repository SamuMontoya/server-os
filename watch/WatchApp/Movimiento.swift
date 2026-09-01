import Foundation

/// El salto del orbe, medido del vídeo original.
///
/// Son los fotogramas 126-174 de `movimiento.json` (el tramo donde el orbe
/// salta), normalizados para arrancar en reposo. Vive aquí y no dentro de una
/// vista porque lo usan DOS: el salto al tocar y el orbe girando del
/// "cargando".
struct Mov {
  let dx, dy, sx, sy: Double
}

private func C(_ a: Double, _ b: Double, _ c: Double, _ d: Double) -> Mov {
  Mov(dx: a, dy: b, sx: c, sy: d)
}

enum Salto {
  static let cuadros: [Mov] = [
    C(+0.0000,+0.0000,1.0000,1.0000), C(+0.0076,+0.0079,1.0075,0.9916), C(+0.0000,+0.0079,1.0148,0.9916), C(+0.0076,+0.0157,1.0222,0.9831),
    C(+0.0076,+0.0157,1.0222,0.9831), C(+0.0076,+0.0157,1.0222,0.9831), C(+0.0076,+0.0079,1.0222,0.9916), C(+0.0153,-0.0236,1.0148,1.0085),
    C(+0.0153,-0.0866,0.9852,1.0255), C(+0.0229,-0.1732,0.9630,1.0509), C(+0.0229,-0.2362,0.9482,1.0848), C(+0.0229,-0.2756,0.9333,1.1102),
    C(+0.0229,-0.2913,0.9186,1.1271), C(+0.0229,-0.2913,0.9186,1.1271), C(+0.0229,-0.2913,0.9186,1.1271), C(+0.0229,-0.2992,0.9186,1.1187),
    C(+0.0153,-0.3150,0.9260,1.1017), C(+0.0153,-0.2992,0.9260,1.0678), C(+0.0153,-0.2677,0.9408,1.0339), C(+0.0153,-0.2205,0.9556,1.0000),
    C(+0.0153,-0.1417,0.9852,0.9661), C(+0.0153,-0.0236,1.0297,0.9407), C(+0.0076,+0.0709,1.0519,0.9238), C(+0.0000,+0.0866,1.0593,0.9238),
    C(+0.0076,+0.0236,0.9926,1.0085), C(+0.0076,-0.0236,0.9482,1.0424), C(+0.0076,-0.0630,0.9333,1.0678), C(+0.0076,-0.0945,0.9186,1.0848),
    C(+0.0153,-0.1260,0.9111,1.0848), C(+0.0153,-0.1575,0.9260,1.0678), C(+0.0076,-0.1890,0.9482,1.0509), C(+0.0153,-0.2047,0.9556,1.0339),
    C(+0.0153,-0.2205,0.9704,1.0170), C(+0.0153,-0.1890,0.9704,1.0170), C(+0.0076,-0.1339,0.9778,1.0255), C(+0.0153,-0.0866,0.9852,1.0424),
    C(+0.0153,-0.0394,0.9852,1.0594), C(+0.0153,-0.0236,0.9852,1.0594), C(+0.0229,-0.0236,0.9778,1.0594), C(+0.0076,-0.0315,0.9778,1.0678),
    C(+0.0000,-0.0394,0.9704,1.0763), C(+0.0000,-0.0551,0.9704,1.0932), C(+0.0000,-0.0551,0.9704,1.0932), C(-0.0076,-0.0630,0.9630,1.1017),
    C(-0.0076,-0.0630,0.9630,1.1017), C(-0.0076,-0.0630,0.9630,1.1017), C(-0.0076,-0.0630,0.9630,1.1017), C(-0.0076,-0.0630,0.9630,1.1017),
  ]

  static let fps: Double = 30
  static var duracion: Double { Double(cuadros.count) / fps }

  /// Tramo en el AIRE, en fracción de la secuencia. Sale de los datos: el
  /// despegue está por el fotograma 7 y el aterrizaje por el 24 (dy pasa de
  /// -0,315 a +0,087). Es la ventana donde la mortal tiene sentido: girar con
  /// el orbe tocando suelo se ve como un patinazo, no como una vuelta.
  static let aire = (inicio: 7.0 / 48.0, fin: 24.0 / 48.0)

  /// Muestrea el movimiento en el instante `dt` (segundos desde que empezó).
  ///
  /// Los datos medidos NO acaban en reposo (quedan en dy=-0,063, sy=1,10), así
  /// que se aplica una envolvente que aterriza en el último 35%. Sin ella el
  /// orbe da un tirón al terminar.
  static func en(_ dt: Double) -> Mov {
    guard dt >= 0, dt < duracion else { return Mov(dx: 0, dy: 0, sx: 1, sy: 1) }
    let f = dt * fps
    let i0 = min(Int(f), cuadros.count - 1)
    let i1 = min(i0 + 1, cuadros.count - 1)
    let k = f - Double(i0)
    let a = cuadros[i0], b = cuadros[i1]

    let p = dt / duracion
    let cierre = p < 0.65 ? 1.0 : 1.0 - (p - 0.65) / 0.35
    let suave = cierre * cierre * (3 - 2 * cierre)

    return Mov(dx: (a.dx + (b.dx - a.dx) * k) * suave,
               dy: (a.dy + (b.dy - a.dy) * k) * suave,
               sx: 1 + ((a.sx + (b.sx - a.sx) * k) - 1) * suave,
               sy: 1 + ((a.sy + (b.sy - a.sy) * k) - 1) * suave)
  }
}
