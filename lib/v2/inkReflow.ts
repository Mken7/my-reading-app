/**
 * Stable glyph-line anchoring for freehand drawings.
 *
 * Layout-independent text positions remain Unicode-codepoint start/end.
 * A drawing drawn on one visual line is rendered only while that immutable
 * text selection still occupies one visual line. Never stretch a user's
 * ellipse, stroke or arrow across newly wrapped lines.
 */
import { paddedTextRect, type PlainRect } from "./textAnchor.ts";

export type InkAnchorLayout = "bounding_v1" | "single_line_v2";

function healthy(rect: PlainRect): boolean {
  return [rect.left,rect.top,rect.width,rect.height].every(Number.isFinite) &&
    rect.width > 0 && rect.height > 0;
}

export function groupedVisualLines(rectangles: readonly PlainRect[]): PlainRect[] {
  const valid=rectangles.filter(healthy).slice().sort((a,b)=>a.top-b.top || a.left-b.left);
  const grouped: PlainRect[]=[];
  for(const rect of valid){
    const preceding=grouped.at(-1);
    // A single text line may be split into several client rects by inline
    // highlights. Combine only rects with matching top/bottom metrics.
    if(preceding && Math.abs(preceding.top-rect.top)<=4 &&
       Math.abs((preceding.top+preceding.height)-(rect.top+rect.height))<=6){
      const left=Math.min(preceding.left,rect.left);
      const top=Math.min(preceding.top,rect.top);
      const right=Math.max(preceding.left+preceding.width,rect.left+rect.width);
      const bottom=Math.max(preceding.top+preceding.height,rect.top+rect.height);
      grouped[grouped.length-1]={left,top,width:right-left,height:bottom-top};
    } else grouped.push({...rect});
  }
  return grouped;
}

/** Returns null for a selection that wraps; callers must not draw its saved
 * geometry on a different line or silently fall back to paragraph scaling.
 */
export function singleLineInkBounds(
  rectangles: readonly PlainRect[],container:PlainRect,
  padding=8,
): PlainRect | null {
  const lines=groupedVisualLines(rectangles);
  return lines.length===1 ? paddedTextRect(lines[0],container,padding) : null;
}
