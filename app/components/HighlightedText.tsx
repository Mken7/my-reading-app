import type { ReactNode } from "react";
import type { Highlight } from "./types";

type Props = {
  text: string;
  activeHighlights: Highlight[];
  onHighlightClick?: (e: React.MouseEvent, highlightId: string) => void;
};

export function renderHighlightedText(
  text: string,
  activeHighlights: Highlight[],
  onHighlightClick?: (e: React.MouseEvent, highlightId: string) => void,
): ReactNode {
  if (activeHighlights.length === 0) return text;

  return activeHighlights.reduceRight<ReactNode>((child, h, index) => {
    const color = h.userColor;

    // 使用 borderBottom 模拟下划线，兼容性更好（尤其手机端）
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
        style={{
          borderBottom: `2px ${borderStyle} ${color}`,
          paddingBottom: "1px",
          background: "transparent",
        }}
        onClick={(e) => onHighlightClick?.(e, h.id)}
      >
        {child}
      </span>
    );
  }, text);
}
