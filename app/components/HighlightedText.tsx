import type { ReactNode } from "react";
import type { Highlight } from "./types";

function getLuminance(hex: string) {
  if (!hex || !hex.startsWith('#')) return 0;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function renderHighlightedText(
  text: string,
  activeHighlights: Highlight[],
  onHighlightClick?: (e: React.MouseEvent, highlightId: string) => void,
): ReactNode {
  if (activeHighlights.length === 0) return text;

  return activeHighlights.reduceRight<ReactNode>((child, h) => {
    const color = h.userColor;
    const isLight = getLuminance(color) > 0.75;

    let decoration: string;
    switch (h.lineStyle) {
      case "solid": decoration = "underline"; break;
      case "dashed": decoration = "underline dashed"; break;
      default: decoration = "underline wavy";
    }

    return (
      <span
        key={h.id}
        data-highlight-id={h.id}
        style={{
          textDecoration: decoration,
          textUnderlineOffset: "3px",
          textDecorationColor: color,
          textDecorationThickness: "2px",
          background: isLight ? "rgba(0,0,0,0.06)" : "transparent",
          cursor: "pointer",
        }}
        onClick={(e) => onHighlightClick?.(e, h.id)}
      >
        {child}
      </span>
    );
  }, text);
}
