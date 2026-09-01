import AVFoundation

/// Lee en voz alta la RESPUESTA, no los pasos.
///
/// Los pasos ("Leyó…", "Ejecutó…") son andamiaje: se ven mientras trabaja y
/// desaparecen. Narrarlos convertiría cada consulta en un monólogo. Se habla
/// solo lo que el usuario se llevaría si apartara la vista.
///
/// LA VOZ DE SIRI NO SE PUEDE USAR: Apple la reserva al sistema a propósito
/// —una app podría hacerse pasar por Siri para sacar datos—, y no hay API que
/// la exponga. Lo más cercano es elegir la mejor voz masculina en español que
/// tenga el reloj instalada, prefiriendo `premium` sobre `enhanced` sobre la
/// de serie. Si el usuario baja la voz premium en Ajustes, esto la usa sola.
final class Voz: NSObject {
  static let compartida = Voz()

  private let sintetizador = AVSpeechSynthesizer()
  private var pendiente = ""

  private lazy var voz: AVSpeechSynthesisVoice? = Self.mejor()

  private static func mejor() -> AVSpeechSynthesisVoice? {
    let es = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("es") }
    // El orden importa: premium es notablemente mejor y suele estar sin
    // descargar, así que hay que caer con gracia hasta la de serie.
    for calidad in [AVSpeechSynthesisVoiceQuality.premium, .enhanced, .default] {
      if let v = es.first(where: { $0.quality == calidad && $0.gender == .male }) { return v }
    }
    // Respaldo explícito: si el reloj no lista ninguna voz en español,
    // pedirla por idioma suele devolver la del sistema igualmente. Dejar
    // `voice` en nil no siempre habla.
    return es.first(where: { $0.gender == .male })
      ?? es.first
      ?? AVSpeechSynthesisVoice(language: "es-ES")
      ?? AVSpeechSynthesisVoice(language: Locale.current.identifier)
  }

  private override init() {
    // LA CLAVE de que sonara: con `usesApplicationAudioSession = true` (el
    // valor por defecto) la app tiene que activar la sesión de audio ella
    // misma, y en watchOS eso falla EN SILENCIO — no lanza, no avisa,
    // simplemente no sale sonido por el altavoz. Delegándolo al sistema, él
    // activa y desactiva la sesión, resuelve el enrutado al altavoz o a los
    // auriculares, y gestiona las interrupciones.
    //
    // Y trae de regalo lo que se pedía: al ser audio del sistema, el DIAL
    // controla el volumen con la barra nativa del reloj. No hace falta —ni
    // conviene— pintar otra.
    sintetizador.usesApplicationAudioSession = false
    super.init()
  }

  /// Habla por FRASES según van llegando, no al final.
  ///
  /// Esperar al final añadiría el tiempo entero de la respuesta antes de la
  /// primera palabra hablada, justo lo que costó tanto quitar. El sintetizador
  /// encola las frases, así que suena continuo.
  func alLlegar(_ texto: String) {
    pendiente += texto
    while let corte = pendiente.rangeOfCharacter(from: CharacterSet(charactersIn: ".!?…\n")) {
      let frase = String(pendiente[..<corte.upperBound])
      pendiente = String(pendiente[corte.upperBound...])
      decir(frase)
    }
  }

  /// Cierra: dice lo que quedó sin terminador de frase.
  func cerrar() {
    let resto = pendiente.trimmingCharacters(in: .whitespacesAndNewlines)
    pendiente = ""
    if !resto.isEmpty { decir(resto) }
  }

  func callar() {
    pendiente = ""
    sintetizador.stopSpeaking(at: .immediate)
  }

  private func decir(_ t: String) {
    let limpio = t.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !limpio.isEmpty else { return }
    let u = AVSpeechUtterance(string: limpio)
    u.voice = voz
    // Un pelo por encima del ritmo por defecto: en un reloj la respuesta es
    // corta y el ritmo de serie se arrastra.
    u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.05
    // Al máximo, siempre.
    //
    // OJO con lo que esto significa de verdad: `volume` es un MULTIPLICADOR
    // sobre el volumen del sistema, no un valor absoluto. 1.0 es "no atenúes
    // nada", que es lo máximo que una app puede pedir — el nivel final lo pone
    // el volumen del reloj, y NO hay API para subirlo (solo el usuario, con el
    // dial mientras suena). Poner esto explícito evita que un cambio futuro lo
    // deje atenuado sin darse cuenta.
    u.volume = 1.0

    sintetizador.speak(u)
  }
}
