import SwiftUI

/// Markdown al estilo Notion, con los tamaños del CSS del Laboratorio.
///
/// Se parte en BLOQUES a mano y lo de dentro de cada línea se deja a
/// `AttributedString(markdown:)`. Ese reparto es a propósito: lo inline
/// (negrita, cursiva, código, enlaces) lo resuelve el sistema mejor que
/// cualquier parser propio, y lo de bloque (títulos, listas, citas, vallas de
/// código) es justo lo que `AttributedString` NO sabe hacer — devuelve los
/// `#` y los `-` como texto literal.
///
/// Tamaños de `.lab-answer .md-*`: cuerpo 15/1,6 · h1 20 · h2 17 · h3 15 ·
/// código en #eb5757 sobre gris · enlaces #2563eb.
struct Markdown: View {
  let fuente: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(Self.partir(fuente).enumerated()), id: \.offset) { _, b in
        bloque(b)
      }
    }
  }

  // ── Bloques ───────────────────────────────────────────────────────────────
  enum Trozo {
    case titulo(nivel: Int, texto: String)
    case parrafo(String)
    case item(texto: String, ordinal: String?)
    case cita(String)
    case codigo(String)
    case regla
  }

  @ViewBuilder
  private func bloque(_ t: Trozo) -> some View {
    switch t {
    case .titulo(let n, let txt):
      Text(Self.inline(txt))
        .font(.system(size: n == 1 ? 20 : n == 2 ? 17 : 15, weight: .bold))
        .foregroundStyle(Color(hex: 0x1F1E1B))
        .padding(.top, n == 1 ? 3 : n == 2 ? 13 : 12)
        .padding(.bottom, n == 1 ? 6 : 5)

    case .parrafo(let txt):
      Text(Self.inline(txt))
        .font(.system(size: 15))
        .lineSpacing(6)                       // 1,6 del CSS
        .foregroundStyle(LabView.tinta)
        .padding(.vertical, 4)
        .textSelection(.enabled)

    case .item(let txt, let ordinal):
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        Text(ordinal ?? "•")
          .font(.system(size: 15))
          // #9b9a97: la viñeta va apagada para que no compita con el texto.
          .foregroundStyle(LabView.apagado)
        Text(Self.inline(txt))
          .font(.system(size: 15))
          .lineSpacing(6)
          .foregroundStyle(LabView.tinta)
      }
      .padding(.vertical, 2)

    case .cita(let txt):
      HStack(spacing: 10) {
        Rectangle().fill(LabView.tinta.opacity(0.25)).frame(width: 3)
        Text(Self.inline(txt))
          .font(.system(size: 15))
          .lineSpacing(6)
          .foregroundStyle(LabView.tinta)
      }
      .padding(.vertical, 5)

    case .codigo(let txt):
      ScrollView(.horizontal, showsIndicators: false) {
        Text(txt)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(LabView.tinta)
          .padding(12)
      }
      // #f7f6f3 como .md-pre. El scroll horizontal es obligatorio: una línea
      // larga de código sin él estira toda la conversación a lo ancho.
      .background(Color(hex: 0xF7F6F3))
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .padding(.vertical, 6)

    case .regla:
      Rectangle().fill(Color(hex: 0xEDEDEC)).frame(height: 1).padding(.vertical, 10)
    }
  }

  // ── Parser de bloques ─────────────────────────────────────────────────────
  static func partir(_ s: String) -> [Trozo] {
    var out: [Trozo] = []
    var parrafo: [String] = []
    var enCodigo = false
    var codigo: [String] = []

    func cerrarParrafo() {
      let t = parrafo.joined(separator: " ").trimmingCharacters(in: .whitespaces)
      if !t.isEmpty { out.append(.parrafo(t)) }
      parrafo = []
    }

    for linea in s.components(separatedBy: "\n") {
      let l = linea.trimmingCharacters(in: .whitespaces)

      if l.hasPrefix("```") {
        if enCodigo {
          out.append(.codigo(codigo.joined(separator: "\n")))
          codigo = []
          enCodigo = false
        } else {
          cerrarParrafo()
          enCodigo = true
        }
        continue
      }
      if enCodigo { codigo.append(linea); continue }

      if l.isEmpty { cerrarParrafo(); continue }
      if l == "---" || l == "***" || l == "___" {
        cerrarParrafo(); out.append(.regla); continue
      }
      if l.hasPrefix("### ") {
        cerrarParrafo(); out.append(.titulo(nivel: 3, texto: String(l.dropFirst(4)))); continue
      }
      if l.hasPrefix("## ") {
        cerrarParrafo(); out.append(.titulo(nivel: 2, texto: String(l.dropFirst(3)))); continue
      }
      if l.hasPrefix("# ") {
        cerrarParrafo(); out.append(.titulo(nivel: 1, texto: String(l.dropFirst(2)))); continue
      }
      if l.hasPrefix("> ") {
        cerrarParrafo(); out.append(.cita(String(l.dropFirst(2)))); continue
      }
      if l.hasPrefix("- ") || l.hasPrefix("* ") {
        cerrarParrafo(); out.append(.item(texto: String(l.dropFirst(2)), ordinal: nil)); continue
      }
      // Lista numerada: "1. algo"
      if let p = l.firstIndex(of: "."), l.distance(from: l.startIndex, to: p) <= 2,
         Int(l[l.startIndex..<p]) != nil, l.index(after: p) < l.endIndex {
        cerrarParrafo()
        let n = String(l[l.startIndex...p])
        let resto = String(l[l.index(after: p)...]).trimmingCharacters(in: .whitespaces)
        out.append(.item(texto: resto, ordinal: n))
        continue
      }
      parrafo.append(l)
    }
    if enCodigo, !codigo.isEmpty { out.append(.codigo(codigo.joined(separator: "\n"))) }
    cerrarParrafo()
    return out
  }

  /// Negrita, cursiva, código y enlaces: se los deja al sistema.
  ///
  /// Con `.inlineOnlyPreservingWhitespace` no se le pide que entienda bloques
  /// (no sabe) y no se come los espacios, que es lo que hace la opción por
  /// defecto y deja el texto pegado.
  static func inline(_ s: String) -> AttributedString {
    (try? AttributedString(
      markdown: s,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(s)
  }
}
