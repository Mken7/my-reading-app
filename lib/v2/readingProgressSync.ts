/** Rules for independent, versioned per-reader cursors.
 * This module contains no I/O or browser dependencies so that no stale
 * client state can silently overwrite a newer server cursor.
 */
export type ReadingCursor = { chunk_index: number; revision: number };
export type CursorConflict = {
  desired: number;
  remote: ReadingCursor;
};
export type CursorReconciliation = {
  current: ReadingCursor | null;
  conflict: CursorConflict | null;
  changed: boolean;
};

export function validReadingCursor(value: unknown): value is ReadingCursor {
  if (!value || typeof value!=="object") return false;
  const r=value as Record<string,unknown>;
  return Number.isInteger(r.chunk_index) &&
    Number.isInteger(r.revision) &&
    (r.chunk_index as number)>=0 && (r.chunk_index as number)<=1999 &&
    (r.revision as number)>0;
}

/** Receive a remote revision only if it is strictly newer. Never jump the
 * reading viewport and never silently overwrite an unresolved local choice.
 */
export function reconcileCursor(
  current: ReadingCursor | null,
  remote: ReadingCursor | null,
  viewed: number | null,
  unresolved: CursorConflict | null,
): CursorReconciliation {
  if (!remote || (current && remote.revision<=current.revision)) {
    return {current,conflict:unresolved,changed:false};
  }
  if (unresolved) {
    return {current:remote,conflict:{desired:unresolved.desired,remote},changed:true};
  }
  const conflict=viewed!==null && viewed!==remote.chunk_index
    ? {desired:viewed,remote} : null;
  return {current:remote,conflict,changed:true};
}

/** CAS compares only against the version observed before navigation.
 * A background refresh cannot turn an old in-flight navigation into a valid
 * write against newer server state. */
export function expectedCursorRevision(cursor: ReadingCursor | null): number {
  return cursor?.revision ?? 0;
}
