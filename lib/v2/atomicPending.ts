/**
 * IndexedDB queue: each encrypted record is one atomic object-store row.
 * No separate localStorage index to become inconsistent after a crash.
 * No automatic plaintext persistence, network send, or legacy deletion.
 */
import {
  encryptedDraftKey, recoverEncryptedDraft, saveEncryptedDraft,
  type DraftScope, type DraftStorage,
} from "./encryptedDraft.ts";
import { MAX_PENDING_PER_TARGET, pendingOperationId } from "./draftQueue.ts";

export type EncryptedPendingRow = {
  id: string;       // opaque scope hash + UUID, no readable user/room
  scope: string;    // opaque target hash for index
  operation: string; // random submission UUID only
  envelope: string; // authenticated ciphertext, no plaintext metadata
};

export interface AtomicPendingStore {
  list(scope: string): Promise<EncryptedPendingRow[]>;
  get(id: string): Promise<EncryptedPendingRow | undefined>;
  /** A single serializable DB transaction enforces unique id + quota. */
  insert(row: EncryptedPendingRow, limit: number): Promise<void>;
  remove(id: string): Promise<void>;
}

const MATCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function operationScope(scope: DraftScope,operation: string): DraftScope {
  if (!MATCH_UUID.test(operation)) throw new Error("待发送编号格式不正确");
  return {...scope,targetId:scope.targetId+"|idb:"+operation.toLowerCase()};
}

async function keys(scope: DraftScope,operation: string) {
  const digest=await encryptedDraftKey({...scope,targetId:scope.targetId+"|idb-scope"});
  const normalized=operation.toLowerCase();
  return {scopeKey:digest,id:digest+"|"+normalized,operation:normalized};
}

/** Reuses the audited AES-GCM implementation without writing to localStorage. */
async function encryptedEnvelope(
  scope: DraftScope,plaintext: string,password: string,
): Promise<string> {
  let ciphertext: string | null=null;
  const memory: DraftStorage={
    getItem:()=>ciphertext,
    setItem:(_,value)=>{ciphertext=value;},
    removeItem:()=>{ciphertext=null;},
  };
  await saveEncryptedDraft(memory,scope,plaintext,password);
  if (!ciphertext) throw new Error("草稿加密失败");
  return ciphertext;
}

async function decryptEnvelope(
  scope: DraftScope,envelope: string,password: string,
): Promise<string | null> {
  const memory: DraftStorage={
    getItem:()=>envelope,
    setItem:()=>{throw new Error("只允许解密");},
    removeItem:()=>{throw new Error("只允许解密");},
  };
  return recoverEncryptedDraft(memory,scope,password);
}

/** Metadata-only inspection: never decrypts, logs, or exposes note text. */
function plausibleEnvelope(value: unknown): boolean {
  if (typeof value!=="string" || value.length<60 || value.length>16000) return false;
  let data: unknown;
  try { data=JSON.parse(value); } catch { return false; }
  if (!data || typeof data!=="object") return false;
  const record=data as Record<string,unknown>;
  const base64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  return record.v===1 && record.iterations===310000 &&
    typeof record.salt==="string" && record.salt.length===24 && base64.test(record.salt) &&
    typeof record.iv==="string" && record.iv.length===16 && base64.test(record.iv) &&
    typeof record.ciphertext==="string" &&
    record.ciphertext.length>=24 && record.ciphertext.length<=12000 &&
    base64.test(record.ciphertext);
}

export type PendingInspection = {
  ids: string[];
  damagedIds: string[];
};

/**
 * A malformed ciphertext must never hide intact entries or be erased by a
 * background cleanup. It remains listed for explicit user-driven removal.
 * Malformed row identities are treated as a scope-integrity failure instead.
 */
export async function inspectAtomicPending(
  store: AtomicPendingStore,scope: DraftScope,
): Promise<PendingInspection> {
  const scoped=await keys(scope,"00000000-0000-4000-8000-000000000000");
  const rows=await store.list(scoped.scopeKey);
  if (rows.length>MAX_PENDING_PER_TARGET ||
      rows.some(r=>r.scope!==scoped.scopeKey ||
        !MATCH_UUID.test(r.operation) ||
        r.id!==scoped.scopeKey+"|"+r.operation) ||
      new Set(rows.map(r=>r.operation)).size!==rows.length) {
    throw new Error("本地待发送记录身份信息不完整或超过数量上限");
  }
  return {
    ids:rows.map(r=>r.operation),
    damagedIds:rows.filter(r=>!plausibleEnvelope(r.envelope)).map(r=>r.operation),
  };
}

export async function listAtomicPending(
  store: AtomicPendingStore,scope: DraftScope,
): Promise<string[]> {
  return (await inspectAtomicPending(store,scope)).ids;
}

/** Duplicate operation IDs fail closed; restore the original item instead. */
export async function addAtomicPending(
  store: AtomicPendingStore,scope: DraftScope,plaintext: string,password: string,
): Promise<string> {
  const operation=pendingOperationId(plaintext,scope.kind);
  const scoped=await keys(scope,operation);
  const envelope=await encryptedEnvelope(
    operationScope(scope,operation),plaintext,password,
  );
  await store.insert({
    id:scoped.id,scope:scoped.scopeKey,operation,envelope,
  },MAX_PENDING_PER_TARGET);
  return operation;
}

export async function recoverAtomicPending(
  store: AtomicPendingStore,scope: DraftScope,operation: string,password: string,
): Promise<string | null> {
  const scoped=await keys(scope,operation);
  const row=await store.get(scoped.id);
  if (!row) return null;
  if (row.scope!==scoped.scopeKey || row.operation!==scoped.operation ||
      row.id!==scoped.id || typeof row.envelope!=="string") {
    throw new Error("本地加密草稿记录校验失败");
  }
  const plaintext=await decryptEnvelope(
    operationScope(scope,scoped.operation),row.envelope,password,
  );
  if (!plaintext || pendingOperationId(plaintext,scope.kind)!==scoped.operation) {
    throw new Error("待发送正文或编号校验失败");
  }
  return plaintext;
}

export async function removeAtomicPending(
  store: AtomicPendingStore,scope: DraftScope,operation: string,
): Promise<void> {
  const scoped=await keys(scope,operation);
  const row=await store.get(scoped.id);
  if (!row) return;
  if (row.scope!==scoped.scopeKey || row.operation!==scoped.operation)
    throw new Error("本地草稿与账户范围不匹配");
  await store.remove(scoped.id);
}
