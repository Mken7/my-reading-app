/** Revision-safe Unicode codepoint reading positions; no browser or I/O. */
export type ReadingLocation = { chunk_index: number; char_offset: number };
export type ReadingCursor = ReadingLocation & { revision: number };
export type CursorConflict = {
  desired: ReadingLocation;
  remote: ReadingCursor;
};
export type CursorReconciliation = {
  current: ReadingCursor | null;
  conflict: CursorConflict | null;
  changed: boolean;
};

export function validReadingLocation(value: unknown): value is ReadingLocation {
  if (!value || typeof value!=="object") return false;
  const r=value as Record<string,unknown>;
  return Number.isInteger(r.chunk_index) && Number.isInteger(r.char_offset) &&
    (r.chunk_index as number)>=0 && (r.chunk_index as number)<=1999 &&
    (r.char_offset as number)>=0 && (r.char_offset as number)<=3000;
}

export function validReadingCursor(value: unknown): value is ReadingCursor {
  if (!validReadingLocation(value)) return false;
  const r=value as unknown as Record<string,unknown>;
  return Number.isInteger(r.revision) && (r.revision as number)>0;
}

function samePosition(a:ReadingLocation,b:ReadingLocation):boolean {
  return a.chunk_index===b.chunk_index && a.char_offset===b.char_offset;
}

/** Accept newer server revisions, but never auto-navigate or overwrite the
 * reader's current position. Older network responses cannot downgrade state.
 */
export function reconcileCursor(
  current: ReadingCursor | null,
  remote: ReadingCursor | null,
  viewed: ReadingLocation | null,
  unresolved: CursorConflict | null,
): CursorReconciliation {
  if (!remote || (current && remote.revision<=current.revision)){
    return {current,conflict:unresolved,changed:false};
  }
  if (unresolved) {
    return {current:remote,conflict:{desired:unresolved.desired,remote},changed:true};
  }
  const conflict=viewed!==null && !samePosition(viewed,remote)
    ? {desired:viewed,remote} : null;
  return {current:remote,conflict,changed:true};
}

/** CAS against the server version observed BEFORE an asynchronous page read. */
export function expectedCursorRevision(cursor: ReadingCursor | null):number {
  return cursor?.revision??0;
}
