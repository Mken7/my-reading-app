import type { ReactNode } from "react";
import type { Highlight } from "./types";

type Props = {
  text: string;
  activeHighlights: Highlight[];
  onHighlightClick?: (e: React.MouseEvent, highlightId: string) => void;
};

// --- 新增：智能亮度检测函数 ---
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

  return activeHighlights.reduceRight<ReactNode>((child, h, index) => {
    const color = h.userColor;
    
    // 判断颜色是否过浅
    const isLightColor = getLuminance(color) > 0.75;

    let borderStyle: string;
    switch (h.lineStyle) {
      case "solid":
        borderStyle = "solid";
        break;
      case "dashed":
        borderStyle = "dashed";
        break;
      default:
        borderStyle = "wavy";
    }

    return (
      <span
        key={h.id}
        className="select-text"
        data-highlight-id={h.id}
        style={{
          borderBottom: `2px ${borderStyle} ${color}`,
          paddingBottom: "1px",
          background: "transparent",
          // --- 新增：如果颜色太浅，加上极细的深色阴影增强辨识度 ---
          textShadow: isLightColor ? "0px 0px 1px rgba(0,0,0,0.4)" : "none",
        }}
        onClick={(e) => onHighlightClick?.(e, h.id)}
      >
        {child}
      </span>
    );
  }, text);
}