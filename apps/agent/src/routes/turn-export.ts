/**
 * Exporta turnos a DOCX o Markdown.
 * Depende de librería 'docx' (npm install docx).
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import type { ChatTurn } from "../agent/chat-turns.js";
import { env } from "../env.js";

/** URL de descarga de un archivo generado (ver routes/files.ts). Si no hay
 *  PUBLIC_URL configurado, cae al id pelado — mejor que nada en un export
 *  offline que igual se puede pegar luego. */
function fileUrl(id: string): string {
  return env.PUBLIC_URL ? `${env.PUBLIC_URL}/files/download?id=${id}` : `(id: ${id})`;
}

export async function turnToDocx(turn: ChatTurn): Promise<Buffer> {
  const sections: Paragraph[] = [
    new Paragraph({
      text: "Exportación de turno",
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    }),
    new Paragraph({
      text: `ID: ${turn.id}`,
      spacing: { after: 100 },
    }),
    new Paragraph({
      text: `Proyecto: ${turn.project}`,
      spacing: { after: 100 },
    }),
    new Paragraph({
      text: `Estado: ${turn.status}`,
      spacing: { after: 400 },
    }),
    new Paragraph({
      text: "Pregunta",
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 200 },
    }),
    new Paragraph({
      text: turn.prompt || "(sin pregunta)",
      spacing: { after: 400 },
    }),
    new Paragraph({
      text: "Respuesta",
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 200 },
    }),
    new Paragraph({
      text: turn.text || "(sin respuesta)",
      spacing: { after: 400 },
    }),
  ];

  if (turn.files?.length) {
    sections.push(
      new Paragraph({
        text: "Archivos generados",
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 },
      })
    );

    turn.files.forEach((f) => {
      sections.push(
        new Paragraph({
          children: [
            new TextRun({ text: f.name, bold: true }),
            new TextRun({ text: ": " }),
            new TextRun({ text: fileUrl(f.id) }),
          ],
          spacing: { after: 100 },
        })
      );
    });
  }

  const doc = new Document({ sections: [{ children: sections }] });
  return await Packer.toBuffer(doc);
}

export function turnToMarkdown(turn: ChatTurn): string {
  const lines = [
    `# Turno ${turn.id}`,
    `**Proyecto:** ${turn.project}`,
    `**Estado:** ${turn.status}`,
    ``,
    `## Pregunta`,
    ``,
    turn.prompt || "(sin pregunta)",
    ``,
    `## Respuesta`,
    ``,
    turn.text || "(sin respuesta)",
  ];

  if (turn.files?.length) {
    lines.push(``, `## Archivos generados`, ``);
    turn.files.forEach((f) => {
      lines.push(`- **${f.name}**: ${fileUrl(f.id)}`);
    });
  }

  return lines.join("\n");
}

export async function exportTurn(
  turn: ChatTurn,
  format: "docx" | "md" = "md"
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const timestamp = new Date().toISOString().split("T")[0];
  const safeId = turn.id.slice(0, 8);

  if (format === "docx") {
    const buffer = await turnToDocx(turn);
    return {
      buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: `turno-${safeId}-${timestamp}.docx`,
    };
  } else {
    const md = turnToMarkdown(turn);
    const buffer = Buffer.from(md, "utf-8");
    return {
      buffer,
      mimeType: "text/markdown",
      filename: `turno-${safeId}-${timestamp}.md`,
    };
  }
}
