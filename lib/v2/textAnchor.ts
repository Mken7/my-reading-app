/**
 * Unicode text anchors are immutable code-point offsets into one book chunk.
 * React may split the text into spans and JS DOM ranges use UTF-16 positions.
 */
export type TextAnchor = { start: number; end: number };
export type TextNodeOffset = { segmentIndex: number; utf16Offset: number };
export type PlainRect = { left: number; top: number; width: number; height: number };

export function validTextAnchor(anchor: TextAnchor, codePointCount: number): boolean {
  return Number.isInteger(anchor.start) && Number.isInteger(anchor.end) &&
    anchor.start >= 0 && anchor.end > anchor.start &&
    anchor.end <= codePointCount;
}

/** Locate a code-point offset in a list of text nodes, returning UTF-16. */
export function locateTextOffset(
  segments: string[], offset: number,
): TextNodeOffset | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let consumed = 0;
  for (let i=0; i<segments.length; i++) {
    const points=Array.from(segments[i]);
    if (offset <= consumed+points.length) {
      return {
        segmentIndex: i,
        utf16Offset: points.slice(0,offset-consumed).join("").length,
      };
    }
    consumed += points.length;
  }
  return null;
}

/** Keep room for pen strokes beyond the letter's visible bounding rectangle. */
export function paddedTextRect(
  selection: PlainRect, container: PlainRect, padding = 8,
): PlainRect | null {
  if (![selection.left,selection.top,selection.width,selection.height,
      container.left,container.top,container.width,container.height,padding]
      .every(Number.isFinite) ||
      selection.width <= 0 || selection.height <= 0 ||
      container.width <= 0 || container.height <= 0 || padding < 0) return null;
  return {
    left: selection.left-container.left-padding,
    top: selection.top-container.top-padding,
    width: selection.width+padding*2,
    height: selection.height+padding*2,
  };
}
