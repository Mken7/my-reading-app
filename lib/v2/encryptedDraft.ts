/**
 * Opt-in encrypted LOCAL backup for V2 *unsent* drafts only.
 *
 * The passphrase is never persisted, logged, or sent to the server.
 * No automatic plaintext storage: browser storage contains authenticated
 * ciphertext, random salt/IV and generic version metadata only.
 * This is not multi-device sync or protection from malicious browser scripts.
 */
export type DraftKind = "highlight" | "reply";
export type DraftScope = {
  userId: string;
  roomId: string;
  kind: DraftKind;
  targetId: string; // chunk number for highlights, note UUID for replies
};

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "reading-v2-encrypted-draft-v1:";
const ITERATIONS = 310000;
const MAX_PLAINTEXT_BYTES = 8192;
const MAX_ENVELOPE_CHARS = 16000;
const coder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type Envelope = { v: 1; iterations: number; salt: string; iv: string; ciphertext: string };

function assertScope(scope: DraftScope) {
  if (!scope || !["highlight","reply"].includes(scope.kind) ||
      [scope.userId, scope.roomId, scope.targetId].some(
        value => typeof value !== "string" || value.length < 1 || value.length > 150
      )) throw new Error("草稿位置不正确");
}

function scopeBytes(scope: DraftScope): Uint8Array {
  assertScope(scope);
  return coder.encode(JSON.stringify([
    "reading-v2",scope.userId,scope.roomId,scope.kind,scope.targetId,
  ]));
}

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64ToBytes(base64: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("本地密文格式无效");
  }
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function keyFor(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 128) {
    throw new Error("解锁口令需要 12–128 个字符");
  }
  const material = await crypto.subtle.importKey(
    "raw",coder.encode(passphrase),"PBKDF2",false,["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name:"PBKDF2",salt:Uint8Array.from(salt),iterations:ITERATIONS,hash:"SHA-256" },
    material,{ name:"AES-GCM",length:256 },false,["encrypt","decrypt"],
  );
}

export async function encryptedDraftKey(scope: DraftScope): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256",scopeBytes(scope)));
  return PREFIX + bytesToBase64(hash).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}

export async function hasEncryptedDraft(
  storage: DraftStorage,scope: DraftScope,
): Promise<boolean> {
  return storage.getItem(await encryptedDraftKey(scope)) !== null;
}

export async function saveEncryptedDraft(
  storage: DraftStorage,scope: DraftScope,plainText: string,passphrase: string,
): Promise<void> {
  const bytes = coder.encode(plainText);
  if (!bytes.length || bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("草稿内容为空或超过加密备份上限");
  }
  const keyId = await encryptedDraftKey(scope);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(passphrase,salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name:"AES-GCM",iv,additionalData:scopeBytes(scope) },key,bytes,
  ));
  const record: Envelope = {
    v:1,iterations:ITERATIONS,
    salt:bytesToBase64(salt),
    iv:bytesToBase64(iv),
    ciphertext:bytesToBase64(encrypted),
  };
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_ENVELOPE_CHARS) throw new Error("加密数据超过存储上限");
  storage.setItem(keyId,serialized);
}

export async function recoverEncryptedDraft(
  storage: DraftStorage,scope: DraftScope,passphrase: string,
): Promise<string | null> {
  const record = storage.getItem(await encryptedDraftKey(scope));
  if (record === null) return null;
  if (record.length > MAX_ENVELOPE_CHARS) throw new Error("本地密文过大");
  let parsed: unknown;
  try { parsed = JSON.parse(record); }
  catch { throw new Error("本地密文已损坏"); }
  if (!parsed || typeof parsed !== "object") throw new Error("本地密文格式无效");
  const r = parsed as Record<string,unknown>;
  if (r.v !== 1 || r.iterations !== ITERATIONS ||
    typeof r.salt !== "string" || typeof r.iv !== "string" ||
    typeof r.ciphertext !== "string") throw new Error("本地密文版本无效");
  const salt = base64ToBytes(r.salt);
  const iv = base64ToBytes(r.iv);
  const cipher = base64ToBytes(r.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 ||
      cipher.length < 17 || cipher.length > MAX_PLAINTEXT_BYTES + 16) {
    throw new Error("本地密文长度无效");
  }
  try {
    const key = await keyFor(passphrase,salt);
    const value = await crypto.subtle.decrypt(
      {name:"AES-GCM",iv:Uint8Array.from(iv),additionalData:scopeBytes(scope)},
      key,Uint8Array.from(cipher),
    );
    return decoder.decode(value);
  } catch {
    throw new Error("解锁失败：口令错误、草稿位置不匹配或密文损坏");
  }
}

export async function removeEncryptedDraft(
  storage: DraftStorage,scope: DraftScope,
): Promise<void> {
  storage.removeItem(await encryptedDraftKey(scope));
}
