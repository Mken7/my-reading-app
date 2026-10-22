/** Display model for simultaneous independent notes on the same text. */
export type V2HighlightRange = {
  id: string;
  author_id: string;
  start_index: number;
  end_index: number;
};
export type V2TextRun = {
  text: string;
  start: number;
  end: number;
  authorIds: string[];
  noteIds: string[];
};

/**
 * Split immutable paragraph text by ALL highlight boundaries.
 * Never suppress overlaps: every span carries all intersecting note IDs.
 * Offsets count Unicode code points (like Postgres char_length), not UTF-16.
 */
export function buildOverlappingRuns(
  body: string,
  highlights: V2HighlightRange[],
): V2TextRun[] {
  const points = Array.from(body);
  if (!points.length) return [];
  const valid = highlights.filter((h) =>
    Number.isInteger(h.start_index) && Number.isInteger(h.end_index) &&
    h.start_index >= 0 && h.end_index > h.start_index &&
    h.end_index <= points.length,
  );
  const boundaries = new Set<number>([0, points.length]);
  for (const h of valid) {
    boundaries.add(h.start_index);
    boundaries.add(h.end_index);
  }
  const offsets = [...boundaries].sort((a,b) => a-b);
  const runs: V2TextRun[] = [];
  for (let i = 0; i < offsets.length - 1; i++) {
    const start = offsets[i];
    const end = offsets[i+1];
    const active = valid.filter(
      (h) => h.start_index < end && h.end_index > start,
    );
    runs.push({
      text: points.slice(start,end).join(""),
      start,
      end,
      authorIds: [...new Set(active.map((h) => h.author_id))],
      noteIds: active.map((h) => h.id),
    });
  }
  return runs;
}
