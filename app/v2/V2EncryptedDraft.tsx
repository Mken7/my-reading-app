"use client";

import { useCallback, useEffect, useState } from "react";
import {
  hasEncryptedDraft, recoverEncryptedDraft, removeEncryptedDraft,
  saveEncryptedDraft, type DraftScope,
} from "@/lib/v2/encryptedDraft";

type Props = {
  scope: DraftScope;
  draftValue: string;
  onRestore: (value: string) => boolean;
  disabled?: boolean;
};

/**
 * No autosave: only intentional user actions persist encrypted ciphertext.
 * Password is kept in this ephemeral React component state, never in storage.
 */
export function V2EncryptedDraft({
  scope,draftValue,onRestore,disabled = false,
}: Props) {
  const [expanded,setExpanded] = useState(false);
  const [password,setPassword] = useState("");
  const [hasBackup,setHasBackup] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");

  const { userId, roomId, kind, targetId } = scope;
  const check = useCallback(async () => {
    try {
      setHasBackup(await hasEncryptedDraft(window.localStorage,{
        userId,roomId,kind,targetId,
      }));
    } catch {
      setMessage("浏览器本地存储不可用，请勿依赖离线备份。");
    }
  }, [userId,roomId,kind,targetId]);

  useEffect(() => {
    const id=window.setTimeout(()=>{ void check(); },0);
    return ()=>window.clearTimeout(id);
  },[check]);

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
          本功能不支持跨设备同步，也不能抵御恶意浏览器扩展。
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
            onClick={()=>{void backup();}}>加密保存当前草稿</button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
            type="button" disabled={busy || disabled || password.length < 12 || !hasBackup}
            onClick={()=>{void restore();}}>输入口令并恢复</button>
          <button className="rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50"
            type="button" disabled={busy || disabled || !hasBackup}
            onClick={()=>{void discard();}}>清除本机备份</button>
        </div>
        {message && <p role="status" className="text-xs text-[#76563a]">{message}</p>}
      </div>
    </details>
  );
}
