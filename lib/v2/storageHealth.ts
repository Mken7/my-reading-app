/**
 * Browser storage diagnostic for opt-in encrypted offline drafts.
 * "persistent" means the browser agreed to reduce eviction risk, NOT that
 * files survive clear-site-data, uninstall, disk failure or private mode.
 */
export type DraftStorageHealth = {
  databaseWritable: boolean;
  persistence: "granted" | "best-effort" | "unknown";
  usedPercent: number | null;
  warning: string | null;
};

export type StorageManagerSubset = {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
};

export function estimatedStoragePercent(
  usage: number | undefined, quota: number | undefined,
): number | null {
  if (typeof usage !== "number" || typeof quota !== "number" ||
    !Number.isFinite(usage) || !Number.isFinite(quota) ||
    usage < 0 || quota <= 0) return null;
  return Math.min(100,Math.max(0,Math.round(usage / quota * 100)));
}

export async function inspectDraftStorage(
  probe: () => Promise<void>,
  manager?: StorageManagerSubset,
): Promise<DraftStorageHealth> {
  const base: DraftStorageHealth = {
    databaseWritable:false,persistence:"unknown",usedPercent:null,warning:null,
  };
  try {
    await probe();
    base.databaseWritable=true;
  } catch {
    base.warning="浏览器无法完成 IndexedDB 写入与清理测试，不应依赖本机草稿备份。";
    return base;
  }

  if (manager?.persisted) {
    try {
      base.persistence=await manager.persisted() ? "granted" : "best-effort";
    } catch {
      base.persistence="unknown";
    }
  }
  if (manager?.estimate) {
    try {
      const estimate=await manager.estimate();
      base.usedPercent=estimatedStoragePercent(estimate.usage,estimate.quota);
    } catch {
      base.usedPercent=null;
    }
  }

  if (base.usedPercent!==null && base.usedPercent>=85) {
    base.warning="浏览器估算的站点存储占用较高；空间不足时草稿仍可能保存失败。";
  } else if (base.persistence==="best-effort") {
    base.warning="浏览器尚未承诺持久保留本站点数据，空间紧张时可能清理草稿。";
  } else if (base.persistence==="unknown") {
    base.warning="此浏览器无法报告持久存储状态，不能保证关闭或清理后草稿仍存在。";
  }
  return base;
}

/** Must be invoked by an explicit button click; browsers may deny the request. */
export async function requestDraftPersistence(
  manager?: StorageManagerSubset,
): Promise<"granted" | "denied" | "unsupported"> {
  if (!manager?.persist) return "unsupported";
  try {
    return await manager.persist() ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
