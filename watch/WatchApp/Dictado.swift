import WatchKit

/// Dictado del sistema.
///
/// POR QUÉ ASÍ Y NO CON Speech
/// El framework `Speech` (SFSpeechRecognizer) **no existe en watchOS** — se
/// comprobó contra el SDK. La única transcripción disponible es la del
/// sistema, que se presenta con `presentTextInputController`.
///
/// Pasar `withSuggestions: nil` es lo que lo lleva DIRECTO al dictado: con una
/// lista de sugerencias abriría primero el selector de frases.
///
/// `TextFieldLink` sería la vía SwiftUI, pero solo se dispara al tocar SU
/// etiqueta, y aquí el dictado tiene que abrirse cuando TERMINA el salto — no
/// en el instante del toque. De ahí el rodeo por WatchKit.
enum Dictado {
  static func pedir(_ alTerminar: @escaping (String?) -> Void) {
    guard let ic = WKApplication.shared().visibleInterfaceController else {
      alTerminar(nil)
      return
    }
    ic.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) { resultados in
      let texto = (resultados?.first as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      // Cadena vacía = el usuario canceló; se trata igual que un nil para que
      // la vista no entre en el modo texto con nada dentro.
      alTerminar((texto?.isEmpty ?? true) ? nil : texto)
    }
  }
}
