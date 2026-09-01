import AVFoundation
import Speech
import SwiftUI

/// Dictado con las barras de nivel, como `.lab-mic-bars` de la web.
///
/// En iOS SÍ existe el framework `Speech` (en watchOS no, ahí hubo que usar el
/// dictado del sistema). Eso permite el mismo comportamiento que la web:
/// transcripción EN VIVO que se va escribiendo en el campo mientras hablas, con
/// las barras moviéndose según el volumen, y no una pantalla modal aparte.
@MainActor
final class Dictado: ObservableObject {
  @Published var grabando = false
  @Published var nivel: Float = 0
  @Published var error: String?

  private let motor = AVAudioEngine()
  private var pedido: SFSpeechAudioBufferRecognitionRequest?
  private var tarea: SFSpeechRecognitionTask?
  private let reconocedor = SFSpeechRecognizer(locale: Locale(identifier: "es-CO"))
    ?? SFSpeechRecognizer(locale: Locale(identifier: "es-ES"))

  /// Texto que había ANTES de empezar a dictar.
  ///
  /// El reconocedor reescribe su hipótesis entera en cada actualización, así
  /// que lo dictado tiene que reemplazar solo su propio tramo. Sin esta base,
  /// cada corrección duplicaba lo que ya estaba escrito.
  private var base = ""

  func alternar(_ destino: Binding<String>) {
    if grabando { parar() } else { arrancar(destino) }
  }

  private func arrancar(_ destino: Binding<String>) {
    error = nil
    SFSpeechRecognizer.requestAuthorization { [weak self] estado in
      Task { @MainActor in
        guard let self else { return }
        guard estado == .authorized else {
          self.error = "Sin permiso para dictar"
          return
        }
        do { try self.abrir(destino) } catch {
          self.error = "No se pudo abrir el micrófono"
          self.parar()
        }
      }
    }
  }

  private func abrir(_ destino: Binding<String>) throws {
    guard let reconocedor, reconocedor.isAvailable else {
      error = "Dictado no disponible"
      return
    }
    let sesion = AVAudioSession.sharedInstance()
    try sesion.setCategory(.record, mode: .measurement, options: .duckOthers)
    try sesion.setActive(true, options: .notifyOthersOnDeactivation)

    base = destino.wrappedValue.isEmpty ? "" : destino.wrappedValue + " "
    let p = SFSpeechAudioBufferRecognitionRequest()
    p.shouldReportPartialResults = true
    pedido = p

    tarea = reconocedor.recognitionTask(with: p) { [weak self] res, err in
      Task { @MainActor in
        guard let self else { return }
        if let res {
          destino.wrappedValue = self.base + res.bestTranscription.formattedString
        }
        if err != nil || (res?.isFinal ?? false) { self.parar() }
      }
    }

    let entrada = motor.inputNode
    let formato = entrada.outputFormat(forBus: 0)
    entrada.installTap(onBus: 0, bufferSize: 1024, format: formato) { [weak self] buf, _ in
      p.append(buf)
      // Nivel para las barras: RMS del bloque. Se calcula aquí y se publica
      // ya suavizado, para no repintar la pantalla en cada buffer.
      guard let datos = buf.floatChannelData?[0] else { return }
      let n = Int(buf.frameLength)
      var suma: Float = 0
      for i in 0..<n { suma += datos[i] * datos[i] }
      let rms = (suma / Float(max(n, 1))).squareRoot()
      Task { @MainActor in
        self?.nivel = min(1, max(self?.nivel ?? 0 * 0.6, rms * 12))
      }
    }
    motor.prepare()
    try motor.start()
    grabando = true
  }

  func parar() {
    if motor.isRunning {
      motor.stop()
      motor.inputNode.removeTap(onBus: 0)
    }
    pedido?.endAudio()
    tarea?.cancel()
    pedido = nil
    tarea = nil
    grabando = false
    nivel = 0
    try? AVAudioSession.sharedInstance().setActive(false)
  }
}

/// Las barras del micrófono mientras dicta.
struct BarrasMic: View {
  let nivel: Float

  var body: some View {
    TimelineView(.animation) { t in
      let s = t.date.timeIntervalSinceReferenceDate
      HStack(spacing: 2) {
        ForEach(0..<4, id: \.self) { i in
          Capsule()
            .fill(LabView.tinta)
            .frame(width: 2.5, height: Self.alto(nivel: nivel, i: i, s: s))
        }
      }
      .frame(height: 18)
    }
  }

  /// Alto de una barra. Va aparte porque en línea el compilador de SwiftUI no
  /// termina de inferir tipos en un tiempo razonable.
  ///
  /// Cada barra lleva su propia fase: todas en fase se leen como una sola
  /// barra gorda y deja de parecer sonido.
  private static func alto(nivel: Float, i: Int, s: Double) -> CGFloat {
    let onda = 0.5 + 0.5 * abs(sin(s * 6 + Double(i)))
    let a = 4.0 + Double(nivel) * 12.0 * onda
    return CGFloat(max(4.0, a))
  }
}
