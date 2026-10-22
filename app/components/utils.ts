import type {
  DbNoteReply,
  DbNoteRow,
  DbRoomMemberRow,
  LineStyle,
} from "@/lib/supabase";
import type { Highlight, Note, TextRun } from "./types";

export const DEFAULT_PEN_COLOR = "#2563eb";
export const JOIN_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const GAP_BETWEEN_CARDS = 10;
export const RENAME_COOLDOWN_DAYS = 365;

export const LINE_STYLE_OPTIONS: { value: LineStyle; label: string }[] = [
  { value: "wavy", label: "波浪" },
  { value: "solid", label: "直线" },
  { value: "dashed", label: "虚线" },
];

/* ─── 工具函数 ─── */

export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.txt$/i, "").trim() || "未命名书籍";
}

export function normalizeColor(color: string | null | undefined): string {
  if (!color?.trim()) return DEFAULT_PEN_COLOR;
  return color.trim();
}

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)]!;
  }
  return code;
}

export function normalizeJoinCodeInput(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6);
}

export function generateUserId(): string {
  return crypto.randomUUID();
}

export function penComboKey(color: string, lineStyle: LineStyle): string {
  return `${normalizeColor(color).toLowerCase()}:${lineStyle}`;
}

export function canRenameProfile(lastNameChangeDate: string | null): boolean {
  if (!lastNameChangeDate) return true;
  const last = new Date(lastNameChangeDate).getTime();
  const elapsed = Date.now() - last;
  return elapsed >= RENAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
}

export function daysUntilRenameAllowed(lastNameChangeDate: string | null): number {
  if (!lastNameChangeDate) return 0;
  const last = new Date(lastNameChangeDate).getTime();
  const next = last + RENAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((next - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function parseReplies(raw: unknown): DbNoteReply[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as DbNoteReply[]) : [];
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw as DbNoteReply[];
}

export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function buildStyleMapFromMembers(
  members: DbRoomMemberRow[],
): Map<string, { color: string; lineStyle: LineStyle }> {
  const map = new Map<string, { color: string; lineStyle: LineStyle }>();
  for (const m of members) {
    map.set(m.user_name, {
      color: normalizeColor(m.color),
      lineStyle: m.line_style,
    });
  }
  return map;
}

export function mapRowsToState(
  rows: DbNoteRow[],
  bookText: string,
  styleByUserName: Map<string, { color: string; lineStyle: LineStyle }>,
): { highlights: Highlight[]; notes: Note[] } {
  const highlights: Highlight[] = [];
  const notes: Note[] = [];

  for (const row of rows) {
    const id = String(row.id);
    const startOffset = row.start_index;
    const endOffset = row.end_index;
    const style = styleByUserName.get(row.user_name);
    const userColor = normalizeColor(row.user_color ?? style?.color);
    const lineStyle = row.line_style ?? style?.lineStyle ?? "wavy";
    const quote =
      row.quote?.trim() || bookText.slice(startOffset, endOffset) || "";

    highlights.push({
      id,
      startOffset,
      endOffset,
      text: quote,
      userName: row.user_name,
      userColor,
      lineStyle,
    });

    notes.push({
      id,
      highlightId: id,
      author: row.user_name,
      userColor,
      lineStyle,
      content: row.content,
      quote,
      createdAt: new Date(row.created_at).getTime(),
      replies: parseReplies(row.replies),
    });
  }

  return { highlights, notes };
}

export function buildTextRuns(text: string, highlights: Highlight[]): TextRun[] {
  if (!text.length) return [];

  const boundaries = new Set<number>([0, text.length]);
  for (const h of highlights) {
    boundaries.add(Math.max(0, Math.min(h.startOffset, text.length)));
    boundaries.add(Math.max(0, Math.min(h.endOffset, text.length)));
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const runs: TextRun[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (start >= end) continue;

    const activeHighlights = highlights.filter(
      (h) => h.startOffset < end && h.endOffset > start,
    );

    runs.push({
      start,
      end,
      text: text.slice(start, end),
      highlightIds: activeHighlights.map((h) => h.id),
      activeHighlights,
    });
  }

  return runs;
}

export function textDecorationForStyle(style: LineStyle): string {
  switch (style) {
    case "solid":
      return "underline solid";
    case "dashed":
      return "underline dashed";
    default:
      return "underline wavy";
  }
}

export function getOffsetWithin(root: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

export function stackCardTops(
  items: { id: string; anchorY: number }[],
  heights: Record<string, number>,
  gap: number,
): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.anchorY - b.anchorY);
  const tops: Record<string, number> = {};
  const occupied: { top: number; bottom: number }[] = [];

  for (const item of sorted) {
    const h = heights[item.id] ?? 72;
    let top = item.anchorY;

    const collides = (t: number) =>
      occupied.some((o) => t < o.bottom && t + h > o.top);

    while (collides(top)) {
      const blockers = occupied.filter((o) => top < o.bottom && top + h > o.top);
      top = Math.max(...blockers.map((o) => o.bottom)) + gap;
    }

    tops[item.id] = top;
    occupied.push({ top, bottom: top + h });
    occupied.sort((a, b) => a.top - b.top);
  }

  return tops;
}
