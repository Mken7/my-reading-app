"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  hasEncryptedDraft, recoverEncryptedDraft, removeEncryptedDraft,
  saveEncryptedDraft, type DraftScope,
} from "@/lib/v2/encryptedDraft";
import {
  addEncryptedPending,listEncryptedPending,recoverEncryptedPending,
  removeEncryptedPending,browserPendingMutex,
} from "@/lib/v2/draftQueue";
import { addAtomicPending,inspectAtomicPending,recoverAtomicPending,removeAtomicPending } from "@/lib/v2/atomicPending";
import { browserAtomicPendingStore,probeBrowserDraftDatabase } from "@/lib/v2/browserAtomicPending";
import { exportEncryptedPendingBundle,importEncryptedPendingBundle } from "@/lib/v2/portablePending";
import {
  inspectDraftStorage, requestDraftPersistence,
  type DraftStorageHealth,
} from "@/lib/v2/storageHealth";

type Props = {
  scope: DraftScope;
  draftValue: string;
  onRestore: (value: string) => boolean;
  disabled?: boolean;
  refreshToken?: number;
};

/**
 * No autosave: only intentional user actions persist encrypted ciphertext.
 * Password is kept in this ephemeral React component state, never in storage.
 */
export function V2EncryptedDraft({
  scope,draftValue,onRestore,disabled = false,refreshToken = 0,
}: Props) {
  const [expanded,setExpanded] = useState(false);
  const [password,setPassword] = useState("");
  const [hasBackup,setHasBackup] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const [pendingIds,setPendingIds] = useState<string[]>([]);
  const [durableIds,setDurableIds] = useState<string[]>([]);
  const [damagedIds,setDamagedIds] = useState<string[]>([]);
  const [confirmRemove,setConfirmRemove] = useState<string | null>(null);
  const [health,setHealth] = useState<DraftStorageHealth | null>(null);
  const [healthBusy,setHealthBusy] = useState(false);

  const { userId, roomId, kind, targetId } = scope;
  const check = useCallback(async () => {
    try {
      const currentScope={userId,roomId,kind,targetId};
      const [legacy,queued]=await Promise.all([
        hasEncryptedDraft(window.localStorage,currentScope),
        listEncryptedPending(window.localStorage,currentScope),
      ]);
      setHasBackup(legacy);
      setPendingIds(queued);
    } catch {
      setMessage("浏览器本地存储不可用，请勿依赖离线备份。");
    }
    try {
      const inventory=await inspectAtomicPending(browserAtomicPendingStore,{
        userId,roomId,kind,targetId,
      });
      setDurableIds(inventory.ids);
      setDamagedIds(inventory.damagedIds);
    } catch {
      setMessage("IndexedDB 暂不可用。旧版加密备份仍可单独恢复；请勿清理网站数据。");
    }
  }, [userId,roomId,kind,targetId]);

  useEffect(() => {
    const id=window.setTimeout(()=>{ void check(); },0);
    return ()=>window.clearTimeout(id);
  },[check,refreshToken]);

  // Changes from ANOTHER tab do not trigger React state in this tab.
  // Re-read only the current reader's queue when its hashed index changes.
  useEffect(() => {
    const refreshOnFocus=()=>{void check();};
    window.addEventListener("focus",refreshOnFocus);
    return ()=>window.removeEventListener("focus",refreshOnFocus);
  },[check]);

  useEffect(() => {
    const refreshFromOtherTab=(event:StorageEvent) => {
      if (event.storageArea===window.localStorage &&
          (event.key===null || event.key.startsWith("reading-v2-pending-index-v1:"))) {
        void check();
      }
    };
    window.addEventListener("storage",refreshFromOtherTab);
    return ()=>window.removeEventListener("storage",refreshFromOtherTab);
  },[check]);

  async function inspectStorage() {
    if (healthBusy) return;
    setHealthBusy(true);
    try {
      const result=await inspectDraftStorage(
        probeBrowserDraftDatabase,
        typeof navigator!=="undefined" ? navigator.storage : undefined,
      );
      setHealth(result);
      if (!result.databaseWritable) {
        setMessage("本机 IndexedDB 写入检查失败。旧草稿不会被主动删除。");
      }
    } finally {
      setHealthBusy(false);
    }
  }

  async function askForPersistence() {
    if (healthBusy) return;
    setHealthBusy(true);
    try {
      const result=await requestDraftPersistence(
        typeof navigator!=="undefined" ? navigator.storage : undefined,
      );
      setMessage(result==="granted"
        ? "浏览器已允许持久存储，但清理网站数据、卸载或设备损坏仍会使草稿丢失。"
        : result==="denied"
        ? "浏览器未授予持久存储；已保存的草稿不会因此被主动清除。"
        : "当前浏览器未提供持久存储申请接口。");
      setHealth(await inspectDraftStorage(
        probeBrowserDraftDatabase,
        typeof navigator!=="undefined" ? navigator.storage : undefined,
      ));
    } finally {
      setHealthBusy(false);
    }
  }

  async function exportPortable() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const content=await exportEncryptedPendingBundle(browserAtomicPendingStore,scope);
      const blob=new Blob([content],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const link=document.createElement("a");
      link.href=url;
      link.download="reading-v2-encrypted-backup.json";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(()=>URL.revokeObjectURL(url),2000);
      setMessage("已生成加密备份文件。文件含密文和随机编号；请安全保存并另行记住解锁口令。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "导出加密备份失败");
    } finally {setBusy(false);}
  }

  async function importPortable(event:ChangeEvent<HTMLInputElement>) {
    const input=event.currentTarget;
    const file=input.files?.[0];
    input.value="";
    if (!file || busy || disabled) return;
    if (password.length<12) {
      setMessage("导入前请先输入至少 12 字符的解锁口令，以验证文件密文属于当前书房。");
      return;
    }
    setBusy(true);
    try {
      if (file.size>175000) throw new Error("文件过大，已拒绝导入");
      const content=await file.text();
      const added=await importEncryptedPendingBundle(
        browserAtomicPendingStore,scope,content,password,
      );
      const report=await inspectAtomicPending(browserAtomicPendingStore,scope);
      setDurableIds(report.ids);
      setDamagedIds(report.damagedIds);
      setMessage("成功验证并导入 "+added+" 条加密草稿；没有自动发送任何内容。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "导入失败；未提交任何新记录");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function enqueueDurable() {
    if (busy || disabled || !draftValue || password.length<12) return;
    setBusy(true);
    try {
      await addAtomicPending(browserAtomicPendingStore,scope,draftValue,password);
      const inventory=await inspectAtomicPending(browserAtomicPendingStore,scope);
      setDurableIds(inventory.ids);
      setDamagedIds(inventory.damagedIds);
      setMessage("已加密写入 IndexedDB；恢复后仍需要亲自确认发送。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "IndexedDB 加密写入失败");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function restoreDurable(id: string) {
    if (busy || disabled || password.length<12) return;
    setBusy(true);
    try {
      const text=await recoverAtomicPending(browserAtomicPendingStore,scope,id,password);
      if(text===null) setMessage("这条 IndexedDB 草稿不存在，可能已在另一标签页清除。");
      else if(onRestore(text)) setMessage("已从 IndexedDB 解密恢复，请检查隐私设置后自行发送。");
      else setMessage("现有编辑内容不同，未覆盖编辑框。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "无法解密 IndexedDB 草稿");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function discardDurable(id: string) {
    if (busy || disabled || confirmRemove!==id) return;
    setBusy(true);
    try {
      await removeAtomicPending(browserAtomicPendingStore,scope,id);
      const inventory=await inspectAtomicPending(browserAtomicPendingStore,scope);
      setDurableIds(inventory.ids);
      setDamagedIds(inventory.damagedIds);
      setMessage("已删除选中的 IndexedDB 草稿，其余记录不受影响。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "删除本机草稿失败");
    } finally {
      setConfirmRemove(null);
      setBusy(false);
    }
  }

  async function enqueue() {
    if (busy || disabled || !draftValue || password.length < 12) return;
    setBusy(true);
    try {
      await addEncryptedPending(window.localStorage,scope,draftValue,password,browserPendingMutex);
      setPendingIds(await listEncryptedPending(window.localStorage,scope));
      setMessage("此条待发送内容已加密加入本机队列。恢复后必须手动确认发送。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "加入本机队列失败");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function restorePending(id: string) {
    if (busy || disabled || password.length < 12) return;
    setBusy(true);
    try {
      const text=await recoverEncryptedPending(window.localStorage,scope,id,password);
      if (text===null) setMessage("这条本机待发送记录已不存在。");
      else if (onRestore(text)) setMessage("已将此条记录恢复到编辑框。请确认正文和可见性，再手动发送。");
      else setMessage("当前编辑框有其他内容或记录不匹配，未覆盖现有编辑。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "无法解锁此条待发送记录");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function discardPending(id: string) {
    if (busy || disabled || confirmRemove!==id) return;
    setBusy(true);
    try {
      await removeEncryptedPending(window.localStorage,scope,id,browserPendingMutex);
      setPendingIds(await listEncryptedPending(window.localStorage,scope));
      setMessage("该条本机密文已清除，不影响服务器上已经发送的笔记。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "清理该条待发送记录失败");
    } finally {
      setConfirmRemove(null);
      setBusy(false);
    }
  }

  async function backup() {
    if (busy || disabled || !draftValue || password.length < 12) return;
    setBusy(true);
    try {
      await saveEncryptedDraft(window.localStorage,scope,draftValue,password);
      setHasBackup(true);
      setMessage("已加密保存在本机。换设备不会自动同步；忘记口令无法恢复。");
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "加密备份失败");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function restore() {
    if (busy || disabled || password.length < 12) return;
    setBusy(true);
    try {
      const text=await recoverEncryptedDraft(window.localStorage,scope,password);
      if (text === null) {
        setMessage("此位置没有已保存的本地加密草稿。");
      } else if (onRestore(text)) {
        setMessage("草稿已解密恢复到编辑框，尚未上传到服务器。");
      } else {
        setMessage("草稿与当前正文或格式不匹配，未覆盖现有输入。");
      }
    } catch(error) {
      setMessage(error instanceof Error ? error.message : "解锁失败");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function discard() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await removeEncryptedDraft(window.localStorage,scope);
      setHasBackup(false);
      setMessage("本机加密备份已清除，不影响服务器上已保存的内容。");
    } catch {
      setMessage("本机清除失败，请检查浏览器存储权限。");
    } finally { setBusy(false); }
  }

  return (
    <details open={expanded}
      onToggle={(event)=>{
        setExpanded(event.currentTarget.open);
        if (!event.currentTarget.open) setPassword("");
      }}
      className="mt-2 rounded-lg border border-[#d7d0c5] bg-white/70 p-2">
      <summary className="cursor-pointer text-xs">
        本机加密草稿 {hasBackup ? "· 有备份" : "· 未备份"}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs leading-5 text-[#746b60]">
          只有点击“加密保存”才会写入本机。请设置独立于登录密码的口令
          （至少 12 字符）；不上传口令，忘记后无法恢复。
          队列中的每条密文仅可在本设备恢复，不能跨设备同步；
          也不能抵御恶意浏览器扩展。
        </p>
        <div className="rounded-lg border border-[#ded5ca] bg-[#f8f7f3] p-3">
          <p className="text-xs font-medium">本机存储状态（手动检测）</p>
          <p className="mt-1 text-xs leading-5 text-[#746b60]">
            检测只写入并清理一条随机临时记录，不读取笔记正文。
            存储健康不等于永久保留，清理浏览器数据仍会丢失密文。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={healthBusy || busy || disabled}
              className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
              onClick={()=>{void inspectStorage();}}>
              {healthBusy ? "检测中…" : "检查本机存储"}
            </button>
            <button type="button" disabled={healthBusy || busy || disabled ||
              typeof navigator==="undefined" || !navigator.storage?.persist}
              className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
              onClick={()=>{void askForPersistence();}}>
              申请减少浏览器自动清理
            </button>
          </div>
          {health && <div role="status" className="mt-2 space-y-1 text-xs">
            <p>IndexedDB 写入：{health.databaseWritable ? "测试通过" : "不可用"}</p>
            <p>数据保留模式：{health.persistence==="granted" ? "浏览器已授予持久存储" :
              health.persistence==="best-effort" ? "浏览器可按需回收" : "未知"}</p>
            <p>站点存储估算占用：{health.usedPercent===null
              ? "浏览器未提供有效估算" : health.usedPercent+"%"}</p>
            {health.warning && <p className="text-[#9a512d]">{health.warning}</p>}
          </div>}
        </div>
        <label className="block text-xs">
          加密口令
          <input type="password" minLength={12} maxLength={128}
            autoComplete="new-password" spellCheck={false}
            value={password} disabled={busy || disabled}
            onChange={(event)=>setPassword(event.target.value)}
            className="mt-1 w-full rounded-lg border border-[#cfc4b3] bg-white p-2 text-sm"
            placeholder="仅在本次操作时使用"/>
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
            type="button" disabled={busy || disabled || password.length < 12 || !draftValue}
            onClick={()=>{void enqueueDurable();}}>加密加入可靠队列（IndexedDB）</button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
            type="button" disabled={busy || disabled || password.length<12 || !draftValue}
            onClick={()=>{void enqueue();}}>加入旧版队列</button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
            type="button" disabled={busy || disabled || password.length < 12 || !draftValue}
            onClick={()=>{void backup();}}>覆盖旧版单份备份</button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
            type="button" disabled={busy || disabled || password.length < 12 || !hasBackup}
            onClick={()=>{void restore();}}>输入口令并恢复</button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
            type="button" disabled={busy || disabled || !hasBackup}
            onClick={()=>{void discard();}}>清除本机备份</button>
        </div>
        <div className="mt-3 rounded-lg border border-[#ded5ca] bg-[#faf8f3] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium">可靠待发送队列：{durableIds.length} / 10</p>
            <button type="button" className="text-xs underline" disabled={busy}
              onClick={()=>{void check();}}>刷新列表</button>
          </div>
          <p className="mt-1 text-xs text-[#817668]">
            IndexedDB 原子存储，只展示序号；密文需要口令才能解锁。
            浏览器清理网站数据仍会丢失草稿。
            检测出受损密文时不会自动清除，也不会隐藏其它正常草稿。
          </p>
          {damagedIds.length>0 && <p role="status"
            className="mt-2 text-xs text-[#9a512d]">
            检测到 {damagedIds.length} 条密文格式异常，已保留供手动确认清除；
            其它草稿仍可尝试恢复。
          </p>}
          <div className="mt-2 rounded-lg border border-[#d7d0c5] p-2">
            <p className="text-xs font-medium">跨设备手动迁移（仅加密文件）</p>
            <p className="my-1 text-xs text-[#817668]">
              导出只包含密文和随机编号。另一台设备须用同一个阅读账号、
              同一个书房及笔记位置，并输入原口令才能导入。
              导入验证通过后仍需要逐条手动发送。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy || disabled || durableIds.length===0}
                className="rounded-lg border px-2 py-1 text-xs disabled:opacity-50"
                onClick={()=>{void exportPortable();}}>
                导出加密备份文件
              </button>
              <label className="cursor-pointer rounded-lg border px-2 py-1 text-xs">
                验证口令并导入文件
                <input type="file" className="sr-only" accept=".json,application/json"
                  disabled={busy || disabled}
                  onChange={(event)=>{void importPortable(event);}}/>
              </label>
            </div>
          </div>
          {durableIds.length===0 && <p className="mt-2 text-xs">暂无可靠待发送记录。</p>}
          <div className="mt-2 space-y-2">
            {durableIds.map((id,index)=>(
              <div key={id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#ddd6cd] p-2">
                <span className="mr-auto text-xs">
                  可靠草稿 {index+1}{damagedIds.includes(id) ? " · 密文异常" : ""}
                </span>
                <button type="button" className="rounded-lg border px-2 py-1 text-xs disabled:opacity-50"
                  disabled={busy || disabled || password.length<12}
                  onClick={()=>{void restoreDurable(id);}}>输入口令恢复</button>
                {confirmRemove===id ? (
                  <>
                    <button type="button" disabled={busy || disabled}
                      className="rounded-lg border px-2 py-1 text-xs"
                      onClick={()=>{void discardDurable(id);}}>确认清除</button>
                    <button type="button" disabled={busy || disabled}
                      className="rounded-lg border px-2 py-1 text-xs"
                      onClick={()=>setConfirmRemove(null)}>取消</button>
                  </>
                ) : (
                  <button type="button" disabled={busy || disabled}
                    className="rounded-lg border px-2 py-1 text-xs"
                    onClick={()=>setConfirmRemove(id)}>清除</button>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-[#ded5ca] bg-[#faf8f3] p-2">
          <p className="text-xs font-medium">旧版 localStorage 待发送：{pendingIds.length} / 10</p>
          <p className="mt-1 text-xs text-[#817668]">
            只展示序号，不预览未解密的私人内容。恢复后请检查隐私范围并自行发送。
            多标签页安全修改需要浏览器支持 Web Locks；不支持时会阻止队列修改。
          </p>
          {pendingIds.length===0 && <p className="mt-2 text-xs">暂无待发送记录。</p>}
          <div className="mt-2 space-y-2">
            {pendingIds.map((id,index)=>(
              <div key={id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#ddd6cd] p-2">
                <span className="mr-auto text-xs">待发送项 {index+1}</span>
                <button type="button" disabled={busy || disabled || password.length<12}
                  className="rounded-lg border px-2 py-1 text-xs disabled:opacity-50"
                  onClick={()=>{void restorePending(id);}}>
                  解密恢复
                </button>
                {confirmRemove===id ? (
                  <>
                    <button type="button" disabled={busy || disabled}
                      className="rounded-lg border px-2 py-1 text-xs"
                      onClick={()=>{void discardPending(id);}}>确认清除</button>
                    <button type="button" disabled={busy || disabled}
                      className="rounded-lg border px-2 py-1 text-xs"
                      onClick={()=>setConfirmRemove(null)}>取消</button>
                  </>
                ) : (
                  <button type="button" disabled={busy || disabled}
                    className="rounded-lg border px-2 py-1 text-xs"
                    onClick={()=>setConfirmRemove(id)}>清除本机项</button>
                )}
              </div>
            ))}
          </div>
        </div>
        {message && <p role="status" className="text-xs text-[#76563a]">{message}</p>}
      </div>
    </details>
  );
}
