"use client";

import type { AtomicPendingStore, EncryptedPendingRow } from "./atomicPending.ts";

const DATABASE="reading-v2-encrypted-pending";
const VERSION=1;
const STORE="pending";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB==="undefined")
    return Promise.reject(new Error("当前浏览器不支持 IndexedDB，本机队列没有启用"));
  return new Promise((resolve,reject)=>{
    let settled=false;
    const request=indexedDB.open(DATABASE,VERSION);
    const fail=(error:Error)=>{
      if (!settled) { settled=true; reject(error); }
    };
    request.onupgradeneeded=()=>{
      const db=request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const entries=db.createObjectStore(STORE,{keyPath:"id"});
        entries.createIndex("byScope","scope",{unique:false});
      }
    };
    request.onblocked=()=>fail(new Error("另一个标签页阻止本地数据库升级，请关闭旧标签页后重试"));
    request.onerror=()=>fail(new Error("无法打开本机草稿数据库"));
    request.onsuccess=()=>{
      if (settled) {request.result.close();return;}
      settled=true;
      const db=request.result;
      db.onversionchange=()=>db.close();
      resolve(db);
    };
  });
}

function transact<T>(
  db:IDBDatabase,mode:IDBTransactionMode,
  issue:(store:IDBObjectStore,set:(result:T)=>void,abort:(why:string)=>void)=>void,
):Promise<T> {
  return new Promise((resolve,reject)=>{
    let result:T;
    let failure:string | null=null;
    let done=false;
    let tx:IDBTransaction;
    try { tx=db.transaction(STORE,mode); }
    catch {reject(new Error("本机数据库事务无法启动"));return;}
    const abort=(why:string)=>{
      failure=why;
      try {tx.abort();} catch { /* transaction may have already failed */ }
    };
    tx.oncomplete=()=>{
      if (!done) {done=true;resolve(result);}
    };
    tx.onabort=()=>{
      if (!done) {done=true;reject(new Error(failure ?? "本机数据库写入中断，原有草稿不会被主动删除"));}
    };
    tx.onerror=()=>{
      if (!done) { /* onabort fires after onerror */ }
    };
    try {issue(tx.objectStore(STORE),(value)=>{result=value;},abort);}
    catch {abort("本机草稿操作失败");}
  });
}

/**
 * IndexedDB readwrite transactions serialize overlapping writes, including
 * independent tabs of the same origin. One row per draft means no second
 * plaintext or non-atomic index has to be updated after a successful write.
 */
export const browserAtomicPendingStore: AtomicPendingStore={
  async list(scope) {
    const db=await openDatabase();
    try {
      return await transact<EncryptedPendingRow[]>(db,"readonly",(store,set,abort)=>{
        const request=store.index("byScope").getAll(scope);
        request.onsuccess=()=>set(request.result as EncryptedPendingRow[]);
        request.onerror=()=>abort("读取本机草稿列表失败");
      });
    } finally {db.close();}
  },
  async get(id) {
    const db=await openDatabase();
    try {
      return await transact<EncryptedPendingRow | undefined>(db,"readonly",(store,set,abort)=>{
        const request=store.get(id);
        request.onsuccess=()=>set(request.result as EncryptedPendingRow | undefined);
        request.onerror=()=>abort("读取本机草稿失败");
      });
    } finally {db.close();}
  },
  async insert(row,limit) {
    const db=await openDatabase();
    try {
      await transact<void>(db,"readwrite",(store,set,abort)=>{
        const existing=store.get(row.id);
        existing.onerror=()=>abort("检查待发送编号失败");
        existing.onsuccess=()=>{
          if (existing.result) {
            abort("这条发送编号已保存，请恢复原草稿，不能覆盖已加密内容");
            return;
          }
          const count=store.index("byScope").count(row.scope);
          count.onerror=()=>abort("检查本机草稿数量失败");
          count.onsuccess=()=>{
            if (count.result>=limit) {
              abort("此位置已达到 10 条待发送草稿上限");
              return;
            }
            const request=store.add(row);
            request.onsuccess=()=>set(undefined);
            request.onerror=()=>abort("本机草稿写入失败，可能是存储空间不足");
          };
        };
      });
    } finally {db.close();}
  },
  async remove(id) {
    const db=await openDatabase();
    try {
      await transact<void>(db,"readwrite",(store,set,abort)=>{
        const request=store.delete(id);
        request.onsuccess=()=>set(undefined);
        request.onerror=()=>abort("无法移除本机加密草稿");
      });
    } finally {db.close();}
  },
};
