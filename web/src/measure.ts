// Text measurement with the board's fonts, so shapes can be sized to their labels.

export interface Font {
  /** Excalidraw's fontFamily id. */
  family: number;
  /** CSS font-family name the page loads. */
  css: string;
  /** Excalidraw's line height for this font, as a multiple of the font size. */
  lineHeight: number;
}

export const HAND_FONT: Font = { family: 5, css: "Excalifont", lineHeight: 1.25 };
export const CLEAN_FONT: Font = { family: 6, css: "Nunito", lineHeight: 1.35 };

let context: CanvasRenderingContext2D | null = null;

export function textWidth(text: string, fontSize: number, font: Font = HAND_FONT): number {
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return text.length * fontSize * 0.55;
  context.font = `${fontSize}px ${font.css}, Xiaolai, sans-serif`;
  return context.measureText(text).width;
}

/** Wrap text at word boundaries so no line is wider than `maxWidth` (unless a single word is). */
export function wrapText(text: string, fontSize: number, maxWidth: number, font: Font = HAND_FONT): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, fontSize, font) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Size of (already wrapped) text. */
export function textSize(text: string, fontSize: number, font: Font = HAND_FONT): { width: number; height: number } {
  const lines = text.split("\n");
  return {
    width: Math.max(0, ...lines.map((line) => textWidth(line, fontSize, font))),
    height: lines.length * fontSize * font.lineHeight,
  };
}
