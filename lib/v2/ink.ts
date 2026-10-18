/** Independent shapes on immutable book paragraphs. */
export type InkKind = "stroke" | "ellipse" | "arrow";
export type InkPoint = { x: number; y: number };
export type InkShape = {
  id: string;
  author_id: string;
  kind: InkKind;
  points: InkPoint[];
  visibility: "private" | "shared";
};
export const MAX_INK_POINTS = 128;

export function normalizedInkPoint(
  clientX: number, clientY: number,
  left: number, top: number, width: number, height: number,
): InkPoint {
  if (![clientX,clientY,left,top,width,height].every(Number.isFinite) ||
      width <= 0 || height <= 0) {
    throw new Error("Drawing surface is not measurable");
  }
  return {
    x: Math.round(Math.min(1000,Math.max(0,(clientX-left)/width*1000))),
    y: Math.round(Math.min(1000,Math.max(0,(clientY-top)/height*1000))),
  };
}

export function addInkPoint(points: InkPoint[], next: InkPoint): InkPoint[] {
  if (points.length >= MAX_INK_POINTS) return points;
  const last = points.at(-1);
  if (last && last.x === next.x && last.y === next.y) return points;
  return [...points,next];
}

export function isValidInkShape(shape: Pick<InkShape,"kind" | "points">): boolean {
  if (!["stroke","ellipse","arrow"].includes(shape.kind) ||
      shape.points.length < 2 || shape.points.length > MAX_INK_POINTS ||
      (shape.kind !== "stroke" && shape.points.length !== 2)) return false;
  if (!shape.points.every(({x,y}) =>
      Number.isInteger(x) && Number.isInteger(y) &&
      x >= 0 && x <= 1000 && y >= 0 && y <= 1000)) return false;
  const first = shape.points[0];
  return shape.points.some(point => point.x !== first.x || point.y !== first.y);
}

/** Generate a plain SVG polyline value, never arbitrary HTML from users. */
export function inkArrowHead(start: InkPoint, end: InkPoint): string {
  const dx=end.x-start.x, dy=end.y-start.y;
  const distance=Math.hypot(dx,dy);
  if (!distance) return "";
  const ux=dx/distance,uy=dy/distance;
  const length=Math.min(36,Math.max(12,distance*0.18));
  const wing=length*0.5;
  const bx=end.x-ux*length,by=end.y-uy*length;
  return [
    (bx-uy*wing).toFixed(1)+","+(by+ux*wing).toFixed(1),
    end.x+","+end.y,
    (bx+uy*wing).toFixed(1)+","+(by-ux*wing).toFixed(1),
  ].join(" ");
}
