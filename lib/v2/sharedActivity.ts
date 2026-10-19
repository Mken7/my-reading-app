/** Content-free server activity sequencing. Never accept text or positions. */
export function nextSharedRevision(current: number, input: unknown): number {
  if (!Number.isSafeInteger(current) || current<0) return 0;
  if (typeof input !== "number" || !Number.isSafeInteger(input) ||
      input<=0 || input<=current) return current;
  return input;
}
