/** Module 10, phase 1: canonical companion activity with no spoiler payload.
 * Pure decoding is deliberately independent of transport/browser APIs. */
export type CompanionPresence = "loading" | "alone" | "online" | "offline" | "unavailable";

export function classifyCompanionPresence(value: unknown): CompanionPresence {
  if (!Array.isArray(value) || value.length !== 1) return "unavailable";
  const row: unknown = value[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) return "unavailable";
  const record = row as Record<string, unknown>;
  if (typeof record.partner_joined !== "boolean" ||
      typeof record.partner_active !== "boolean" ||
      (!record.partner_joined && record.partner_active)) return "unavailable";
  if (!record.partner_joined) return "alone";
  return record.partner_active ? "online" : "offline";
}

export function companionPresenceMessage(view: CompanionPresence): string {
  switch (view) {
    case "loading": return "正在核对同伴阅读状态…";
    case "alone": return "目前只有你在这间书房；等待伙伴加入。";
    case "online": return "共读伙伴最近 90 秒内正在使用阅读器。";
    case "offline": return "共读伙伴暂未活跃，或已离开阅读器。";
    case "unavailable": return "目前无法确认同伴状态；不会显示任何阅读位置。";
  }
}
