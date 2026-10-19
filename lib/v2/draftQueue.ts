/**
 * Multiple opt-in encrypted pending submissions at one reader target.
 *
 * Indexed metadata contains ONLY random operation UUIDs, never message text,
 * selected quotes, visibility or usernames. Payload and operation identity
 * are bound by AES-GCM AAD to user, room, kind, target and operation UUID.
 * This is a *manual* queue; nothing is transmitted until the author clicks
 * the regular send button after password recovery.
 */
import {
  encryptedDraftKey, recoverEncryptedDraft, removeEncryptedDraft,
  saveEncryptedDraft, type DraftScope, type DraftStorage,
} from "./encryptedDraft.ts";

export const MAX_PENDING_PER_TARGET = 10;

/**
 * A mutex must work across browser tabs for the SAME origin. The Web Locks
 * API provides that guarantee while localStorage alone does not. The queue
 * refuses mutations on browsers lacking Web Locks instead of risking loss.
 */
export type PendingMutex = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export const browserPendingMutex: PendingMutex = (name, run) => {
  if (typeof navigator === "undefined" || !navigator.locks?.request) {
    return Promise.reject(new Error(
      "当前浏览器不支持安全的多标签草稿编辑；可读取旧备份，但不能新增或清除队列项"
    ));
  }
  return navigator.locks.request(name, run);
};

async function withIndexLock<T>(
  scope: DraftScope, mutex: PendingMutex, run: () => Promise<T>,
): Promise<T> {
  const name = "reading-v2-queue-lock:" + await indexKey(scope);
  return mutex(name, run);
}
const INDEX_PREFIX = "reading-v2-pending-index-v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function pendingOperationId(plaintext: string, kind: DraftScope["kind"]): string {
  let obj: unknown;
  try { obj=JSON.parse(plaintext); }
  catch { throw new Error("待发送项不是受支持的 JSON 草稿"); }
  if (!obj || typeof obj!=="object") throw new Error("待发送项格式错误");
  const item=obj as Record<string,unknown>;
  if (item.v!==2 || typeof item.operationId!=="string" ||
      !UUID.test(item.operationId) ||
      typeof item.body!=="string" || !item.body.trim() ||
      item.body.length>2000) throw new Error("待发送项缺少有效正文或发送编号");
  if (kind==="highlight") {
    if ((item.visibility!=="private" && item.visibility!=="shared") ||
        !Number.isInteger(item.start) || !Number.isInteger(item.end) ||
        typeof item.start!=="number" || typeof item.end!=="number" ||
        item.start<0 || item.end<=item.start || item.end>3000) {
      throw new Error("待发送批注缺少有效选区或隐私状态");
    }
  }
  return item.operationId.toLowerCase();
}

function itemScope(scope: DraftScope,id: string): DraftScope {
  if (!UUID.test(id)) throw new Error("待发送编号无效");
  return {...scope,targetId:scope.targetId+"|pending:"+id.toLowerCase()};
}

async function indexKey(scope: DraftScope): Promise<string> {
  return INDEX_PREFIX+(await encryptedDraftKey({
    ...scope,targetId:scope.targetId+"|pending-index"
  })).split(":").at(-1);
}

async function readIndex(storage: DraftStorage,scope: DraftScope): Promise<string[]> {
  const raw=storage.getItem(await indexKey(scope));
  if (raw===null) return [];
  if (raw.length>550) throw new Error("本机待发送目录长度异常");
  let value: unknown;
  try { value=JSON.parse(raw); }
  catch { throw new Error("本机待发送目录已损坏"); }
  if (!value || typeof value!=="object") throw new Error("本机待发送目录格式无效");
  const record=value as Record<string,unknown>;
  if (record.v!==1 || !Array.isArray(record.ids) ||
      record.ids.length>MAX_PENDING_PER_TARGET ||
      !record.ids.every((id:unknown)=>typeof id==="string" && UUID.test(id)) ||
      new Set(record.ids).size!==record.ids.length) {
    throw new Error("本机待发送目录格式无效");
  }
  return record.ids as string[];
}

async function writeIndex(storage: DraftStorage,scope: DraftScope,ids: string[]) {
  const key=await indexKey(scope);
  if (ids.length===0) storage.removeItem(key);
  else storage.setItem(key,JSON.stringify({v:1,ids}));
}

export async function listEncryptedPending(
  storage: DraftStorage,scope: DraftScope,
): Promise<string[]> {
  return readIndex(storage,scope);
}

/**
 * One unique UUID per intended submission. Never overwrite an existing
 * operation with different content or private/shared visibility.
 */
export async function addEncryptedPending(
  storage: DraftStorage,scope: DraftScope,plaintext: string,passphrase: string,
  mutex: PendingMutex,
): Promise<string> {
  // Read, quota-check, encrypt and publish while holding the SAME origin-wide
  // lock. Without it two tabs can both read the old index and lose one item.
  return withIndexLock(scope,mutex,async () => {
    const id=pendingOperationId(plaintext,scope.kind);
    const existing=await readIndex(storage,scope);
    if (existing.includes(id)) {
      const saved=await recoverEncryptedDraft(storage,itemScope(scope,id),passphrase);
      if (saved!==plaintext) throw new Error("同一发送编号已有不同内容，不能覆盖原待发送项");
      return id;
    }
    if (existing.length>=MAX_PENDING_PER_TARGET) {
      throw new Error("此位置最多保留 10 条加密待发送项，请先处理旧记录");
    }
    const item=itemScope(scope,id);
    // Encryption/storage must finish before the index publishes the new item.
    await saveEncryptedDraft(storage,item,plaintext,passphrase);
    try {
      await writeIndex(storage,scope,[...existing,id]);
    } catch {
      try { await removeEncryptedDraft(storage,item); } catch { /* best effort */ }
      throw new Error("待发送目录更新失败；草稿可能未保存，请检查浏览器容量");
    }
    return id;
  });
}

export async function recoverEncryptedPending(
  storage: DraftStorage,scope: DraftScope,id: string,passphrase: string,
): Promise<string | null> {
  const normalized=id.toLowerCase();
  if (!(await readIndex(storage,scope)).includes(normalized)) return null;
  const text=await recoverEncryptedDraft(storage,itemScope(scope,normalized),passphrase);
  if (text===null) throw new Error("待发送项密文丢失，请手动清理损坏的本机记录");
  if (pendingOperationId(text,scope.kind)!==normalized) {
    throw new Error("待发送项发送编号不匹配");
  }
  return text;
}

export async function removeEncryptedPending(
  storage: DraftStorage,scope: DraftScope,id: string,
  mutex: PendingMutex,
): Promise<void> {
  return withIndexLock(scope,mutex,async () => {
    const normalized=id.toLowerCase();
    const items=await readIndex(storage,scope);
    if (!items.includes(normalized)) return;
    // Keep removal and index rewrite under one cross-tab lock. Remove the
    // ciphertext first to avoid leaving a decryptable orphan after failure.
    await removeEncryptedDraft(storage,itemScope(scope,normalized));
    await writeIndex(storage,scope,items.filter(item=>item!==normalized));
  });
}
