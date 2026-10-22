/**
 * A user-initiated, encrypted, portable backup of ONE V2 pending draft target.
 * It never decrypts or synchronizes drafts automatically. The portable file
 * contains only random operation UUIDs, opaque scope identifiers and AES-GCM
 * envelopes. Import verifies every row with the author's passphrase before
 * writing the whole batch atomically (all-or-nothing).
 */
import {
  inspectAtomicPending, recoverAtomicPending, type AtomicPendingStore,
  type EncryptedPendingRow,
} from "./atomicPending.ts";
import { encryptedDraftKey, type DraftScope } from "./encryptedDraft.ts";
import { MAX_PENDING_PER_TARGET } from "./draftQueue.ts";

const FORMAT="reading-v2-encrypted-pending";
const MAX_FILE_CHARACTERS=175000;
const OPERATION=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type PortableBundle={
  format:typeof FORMAT;
  version:1;
  scope:string;
  records:EncryptedPendingRow[];
};

async function scopedKey(scope:DraftScope):Promise<string>{
  return encryptedDraftKey({...scope,targetId:scope.targetId+"|idb-scope"});
}

function strictBundle(value:unknown,expectedScope:string):PortableBundle{
  if (!value || typeof value!=="object" || Array.isArray(value))
    throw new Error("加密备份不是有效对象");
  const bundle=value as Record<string,unknown>;
  if (bundle.format!==FORMAT || bundle.version!==1 ||
      bundle.scope!==expectedScope || !Array.isArray(bundle.records) ||
      bundle.records.length<1 || bundle.records.length>MAX_PENDING_PER_TARGET)
    throw new Error("备份版本、目标书房或容量不正确");
  const seen=new Set<string>();
  const records:EncryptedPendingRow[]=[];
  for (const unknownRow of bundle.records){
    if(!unknownRow || typeof unknownRow!=="object" || Array.isArray(unknownRow))
      throw new Error("备份中的加密记录格式无效");
    const item=unknownRow as Record<string,unknown>;
    if (typeof item.operation!=="string" || !OPERATION.test(item.operation) ||
        typeof item.id!=="string" || item.id!==expectedScope+"|"+item.operation ||
        item.scope!==expectedScope || typeof item.envelope!=="string" ||
        item.envelope.length<60 || item.envelope.length>16000 ||
        seen.has(item.operation)) throw new Error("备份记录标识或密文无效");
    seen.add(item.operation);
    records.push({
      id:item.id,scope:item.scope,operation:item.operation,envelope:item.envelope,
    });
  }
  return {format:FORMAT,version:1,scope:expectedScope,records};
}

export async function exportEncryptedPendingBundle(
  store:AtomicPendingStore,scope:DraftScope,
):Promise<string>{
  const report=await inspectAtomicPending(store,scope);
  if (report.ids.length===0) throw new Error("此位置暂无可导出的待发送草稿");
  if (report.damagedIds.length>0) throw new Error("本地存在受损密文，请先处理异常草稿");
  const key=await scopedKey(scope);
  const records=await store.list(key);
  const bundle:PortableBundle={format:FORMAT,version:1,scope:key,records};
  const serialized=JSON.stringify(strictBundle(bundle,key));
  if (serialized.length>MAX_FILE_CHARACTERS) throw new Error("加密备份文件超出上限");
  return serialized;
}

export async function importEncryptedPendingBundle(
  store:AtomicPendingStore,scope:DraftScope,
  serialized:string,passphrase:string,
):Promise<number>{
  if (typeof serialized!=="string" || serialized.length>MAX_FILE_CHARACTERS ||
      serialized.length<40) throw new Error("加密备份文件大小无效");
  let parsed:unknown;
  try{ parsed=JSON.parse(serialized); }
  catch{ throw new Error("加密备份不是有效 JSON 文件"); }
  const bundle=strictBundle(parsed,await scopedKey(scope));
  // Check entire contents with AES-GCM AAD before touching IndexedDB.
  // A copied file from another user, room, note or another password fails.
  const source:AtomicPendingStore={
    async list(){return bundle.records;},
    async get(id){return bundle.records.find(record=>record.id===id);},
    async insert(){throw new Error("导入校验期间不能写入");},
    async insertMany(){throw new Error("导入校验期间不能写入");},
    async remove(){throw new Error("导入校验期间不能删除");},
  };
  for (const row of bundle.records){
    const body=await recoverAtomicPending(source,scope,row.operation,passphrase);
    if(body===null) throw new Error("备份的某条密文缺失");
  }
  // DB adapter guarantees the quota + duplicate check + inserts are in one
  // IndexedDB readwrite transaction, including among independent tabs.
  await store.insertMany(bundle.records,MAX_PENDING_PER_TARGET);
  return bundle.records.length;
}
