"use client";

import { useCallback, useEffect, useState } from "react";
import {
  hasEncryptedDraft, recoverEncryptedDraft, removeEncryptedDraft,
  saveEncryptedDraft, type DraftScope,
} from "@/lib/v2/encryptedDraft";
import {
  addEncryptedPending,listEncryptedPending,recoverEncryptedPending,
  removeEncryptedPending,
} from "@/lib/v2/draftQueue";

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
  const [confirmRemove,setConfirmRemove] = useState<string | null>(null);

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
  }, [userId,roomId,kind,targetId]);

  useEffect(() => {
    const id=window.setTimeout(()=>{ void check(); },0);
    return ()=>window.clearTimeout(id);
  },[check,refreshToken]);

  async function enqueue() {
    if (busy || disabled || !draftValue || password.length < 12) return;
    setBusy(true);
    try {
      await addEncryptedPending(window.localStorage,scope,draftValue,password);
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
      await removeEncryptedPending(window.localStorage,scope,id);
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
      onToggle={(event)=>setExpanded(event.currentTarget.open)}
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
            onClick={()=>{void enqueue();}}>加入加密待发送队列</button>
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
          <p className="text-xs font-medium">本机待发送：{pendingIds.length} / 10</p>
          <p className="mt-1 text-xs text-[#817668]">
            只展示序号，不预览未解密的私人内容。恢复后请检查隐私范围并自行发送。
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
