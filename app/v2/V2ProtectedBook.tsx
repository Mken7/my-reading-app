"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { V2TxtImporter } from "./V2TxtImporter";
import { V2Annotations } from "./V2Annotations";
import { V2GlassDock } from "./V2GlassDock";
import { useCompanionPresence } from "./useCompanionPresence";
import { useSharedActivity } from "./useSharedActivity";
import { companionPresenceMessage } from "@/lib/v2/companionPresence";
import {checkedReaderPages,readingPageIndex,spreadSize,READER_SPREAD_QUERY} from "@/lib/v2/readerLayout";
import { reconcileCursor,validReadingCursor,expectedCursorRevision,
  type ReadingCursor,type ReadingLocation,type CursorConflict } from "@/lib/v2/readingProgressSync";

type ProtectedChunk = { chunk_index: number; body: string };
type Chapter = { chapter_position: number; title: string; start_chunk: number };
type Progress = ReadingCursor;
type Conflict = CursorConflict;
type SavedBookmark = { chunk_index: number; label: string; created_at: string };
function isBookmark(raw:unknown):raw is SavedBookmark {
  if(!raw || typeof raw!=="object") return false;
  const r=raw as Record<string,unknown>;
  return Number.isInteger(r.chunk_index) && (r.chunk_index as number)>=0 &&
    (r.chunk_index as number)<=1999 && typeof r.label==="string" &&
    r.label.length<=80 && typeof r.created_at==="string";
}
function isChapter(value: unknown): value is Chapter {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.chapter_position) && Number.isInteger(row.start_chunk) &&
    typeof row.title === "string";
}

type Props = {
  client: SupabaseClient;
  roomId: string;
  owner: boolean;
  userId: string;
};

const inputClass =
  "w-full rounded-lg border border-[#cfc4b3] bg-white px-3 py-2 text-sm outline-none focus:border-[#6c4e39]";
const buttonClass =
  "rounded-lg border border-[#cfc4b3] px-3 py-2 text-sm disabled:opacity-50";

export function V2ProtectedBook({ client, roomId, owner, userId }: Props) {
  const companionPresence = useCompanionPresence(client, roomId, userId);
  const activityRevision = useSharedActivity(client, roomId, userId);
  const [draft, setDraft] = useState("");
  const [rightsBasis,setRightsBasis]=useState<"original"|"public_domain"|"licensed">("original");
  const [rightsConfirmed,setRightsConfirmed]=useState(false);
  const [rightsBusy,setRightsBusy]=useState(false);
  useEffect(()=>{
    if(!owner)return;
    let active=true;
    void Promise.resolve(client.rpc("v2_my_book_rights",{target_room:roomId}))
      .then(({data,error})=>{
        if(!active||error||!Array.isArray(data)||data.length<1)return;
        const stored=data[0]?.rights_basis;
        if(stored==="original"||stored==="public_domain"||stored==="licensed"){
          setRightsBasis(stored);
          setRightsConfirmed(true);
        }
      }).catch(()=>{/* Access to upload stays closed if rights cannot be verified. */});
    return ()=>{active=false;};
  },[client,roomId,owner]);
  const [uploadIndex, setUploadIndex] = useState(0);
  const [readIndex, setReadIndex] = useState(0);
  const [pageStart,setPageStart] = useState(0);
  const [wideSpread,setWideSpread] = useState(false);
  const attemptedCompanionRef=useRef<number | null>(null);
  const [chunks, setChunks] = useState<ProtectedChunk[]>([]);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [savedPins,setSavedPins] = useState<SavedBookmark[]>([]);
  const [pinLabel,setPinLabel] = useState("");
  const [confirmUnpin,setConfirmUnpin] = useState<number | null>(null);
  const [pinWorking,setPinWorking] = useState(false);
  const [pinMessage,setPinMessage] = useState("");
  // Refs are updated with every remote revision, so an in-flight chunk read
  // cannot accidentally use a newly refreshed revision for an older write.
  const progressRef=useRef<Progress | null>(null);
  const conflictRef=useRef<Conflict | null>(null);
  const viewedRef=useRef<ReadingLocation | null>(null);
  const [readingAnchor,setReadingAnchor]=useState<ReadingLocation | null>(null);
  const refreshInFlightRef=useRef(false);
  const channelRef=useRef<BroadcastChannel | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [activePanel, setActivePanel] = useState<"companion" | "settings" | null>(null);
  const [annotationsShown, setAnnotationsShown] = useState(true);
  const [fontSize, setFontSize] = useState(16);
  const [lineHeight, setLineHeight] = useState(1.9);
  const [readerTheme, setReaderTheme] = useState<"paper" | "white" | "mist">("paper");
  const [memberRoles, setMemberRoles] = useState<string[]>([]);
  const [memberError, setMemberError] = useState("");
  const bookmarkRef = useRef<HTMLDetailsElement>(null);
  const catalogRef = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pagesRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{
    const media=window.matchMedia(READER_SPREAD_QUERY);
    const update=()=>setWideSpread(media.matches);
    update();
    media.addEventListener("change",update);
    return ()=>media.removeEventListener("change",update);
  },[]);

  // When the viewport expands, fetch only the right-hand page. Never save
  // another cursor revision or discard the left page's editor state.
  useEffect(()=>{
    if(!wideSpread || chunks.length!==1 || chunks[0].chunk_index!==pageStart ||
       attemptedCompanionRef.current===pageStart || pageStart>=1999)return;
    attemptedCompanionRef.current=pageStart;
    let active=true;
    void Promise.resolve(client.rpc("v2_read_book_chunks",{
      target_room:roomId,from_index:pageStart+1,requested_count:1,
    })).then(async ({data,error})=>{
      if(!active || error)return;
      const right=checkedReaderPages(data,pageStart+1,false)[0];
      if(!right)return;
      const acknowledgement=await client.rpc("v2_acknowledge_read_chunk",{
        target_room:roomId,target_chunk:right.chunk_index,
      });
      if(!active || acknowledgement.error || acknowledgement.data!==true)return;
      setChunks(previous=>previous.length===1 &&
        previous[0].chunk_index===pageStart?[previous[0],right]:previous);
    }).catch(()=>{/* A failed companion page never alters the loaded left page. */});
    return ()=>{active=false;};
  },[wideSpread,chunks,pageStart,client,roomId]);

  const textBackground = readerTheme === "paper" ? "#faf7f0" :
    readerTheme === "white" ? "#ffffff" : "#e9eeef";

  useEffect(() => {
    if (!activePanel) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePanel]);

  useEffect(() => {
    if (activePanel !== "companion") return;
    let cancelled = false;
    void client.from("reading_members_v2")
      .select("role,left_at")
      .eq("room_id", roomId)
      .is("left_at", null).limit(2)
      .then(({ data, error }) => {
        if (cancelled) return;
        setMemberError(error ? "无法读取书房成员，请检查测试数据库权限。" : "");
        setMemberRoles((data ?? []).map((r) => r.role).filter(
          (role): role is string => typeof role === "string",
        ));
      });
    return () => { cancelled = true; };
  }, [activePanel, client, roomId]);

  function recordProgress(next: Progress | null) {
    progressRef.current=next;
    setProgress(next);
  }
  function recordConflict(next: Conflict | null) {
    conflictRef.current=next;
    setConflict(next);
  }

  // This RPC discloses only the current logged-in reader's personal cursor.
  // Refreshes do not navigate, save or overwrite unsaved local reading choices.
  const refreshCursor=useCallback(async (manual=false) => {
    if(refreshInFlightRef.current) return;
    refreshInFlightRef.current=true;
    try {
      const {data,error}=await client.rpc("v2_get_reading_position",{
        target_room:roomId,
      });
      if(error){
        if(manual) setMessage("无法获取书签，请检查网络和书房权限。");
        return;
      }
      const row=Array.isArray(data)?data[0]:null;
      const remote=validReadingCursor(row)?row:null;
      const result=reconcileCursor(
        progressRef.current,remote,viewedRef.current,conflictRef.current,
      );
      if(result.changed){
        progressRef.current=result.current;
        conflictRef.current=result.conflict;
        setProgress(result.current);
        setConflict(result.conflict);
        if(result.conflict) {
          setMessage("另一设备更新了我的书签；当前位置未被覆盖，请选择保留哪一个。");
        } else if(manual){
          setMessage("书签已同步（不会自动跳转正文）。");
        }
      } else if(manual) setMessage("书签已是最新版本。");
    } catch {
      if(manual) setMessage("无法连接书签服务，当前阅读位置仍会保留在屏幕上。");
    } finally {refreshInFlightRef.current=false;}
  },[client,roomId]);

  const refreshPins=useCallback(async () => {
    try {
      const {data,error}=await client.rpc("v2_list_saved_bookmarks",{
        target_room:roomId,
      });
      if(error) {
        setPinMessage("无法同步私人标记书签，请检查数据库迁移及网络。");
        return;
      }
      setSavedPins((Array.isArray(data)?data:[]).filter(isBookmark));
    } catch {
      setPinMessage("网络异常，暂时无法更新书签列表。");
    }
  },[client,roomId]);

  const refreshMetadata=useCallback(async () => {
    setMetaLoading(true);
    const directory=await client.from("reading_chapters_v2")
      .select("chapter_position,title,start_chunk")
      .eq("room_id",roomId).order("chapter_position").limit(200);
    if(directory.error) setMessage("章节同步失败，请检查测试数据库权限。");
    else setChapters((directory.data??[]).filter(isChapter));
    await Promise.all([refreshCursor(true),refreshPins()]);
    setMetaLoading(false);
  },[client,roomId,refreshCursor,refreshPins]);

  useEffect(() => {
    const timer=window.setTimeout(()=>{void refreshMetadata();},0);
    return ()=>window.clearTimeout(timer);
  },[refreshMetadata]);

  // Metadata-only, non-realtime synchronization. Different devices share
  // one server cursor via revision CAS but never share reading-presence data.
  useEffect(() => {
    const refreshIfVisible=() => {
      if(!document.hidden) {
        void refreshCursor();
        void refreshPins();
      }
    };
    const channel=typeof BroadcastChannel!=="undefined"
      ? new BroadcastChannel("reading-v2-cursor:"+roomId+":"+userId) : null;
    channelRef.current=channel;
    if(channel) channel.onmessage=refreshIfVisible;
    window.addEventListener("focus",refreshIfVisible);
    document.addEventListener("visibilitychange",refreshIfVisible);
    const interval=window.setInterval(refreshIfVisible,45000);
    return ()=>{
      window.removeEventListener("focus",refreshIfVisible);
      document.removeEventListener("visibilitychange",refreshIfVisible);
      window.clearInterval(interval);
      channel?.close();
      if(channelRef.current===channel)channelRef.current=null;
    };
  },[roomId,userId,refreshCursor,refreshPins]);

  async function saveBookmark(index:number,offset:number,expectedRevision:number){
    try {
      const {data,error}=await client.rpc("v2_save_reading_position",{
        target_room:roomId,target_chunk:index,target_offset:offset,
        expected_revision:expectedRevision,
      });
      const row=Array.isArray(data)?data[0]:null;
      if(error || !row || typeof row.saved!=="boolean" ||
         !Number.isInteger(row.revision)){
        setMessage("正文已读取，但书签同步失败。请稍后手动同步。");
        return;
      }
      if(row.saved && validReadingCursor(row)){
        if(!progressRef.current || row.revision>=progressRef.current.revision){
          recordProgress(row);
        }
        recordConflict(null);
        channelRef.current?.postMessage("bookmark-updated");
        setMessage("已保存我的阅读进度。");
      } else if(validReadingCursor(row)){
        recordProgress(row);
        recordConflict({desired:{chunk_index:index,char_offset:offset},remote:row});
        setMessage("其他设备保存了更新的书签，当前段落未覆盖新版本。");
      } else {
        setMessage("书签服务器拒绝了旧版本；请先同步并选择书签位置。");
        void refreshCursor(true);
      }
    }catch{
      setMessage("书签写入网络异常。服务器是否已保存尚不确定，请刷新确认。");
    }
  }

  async function saveExactPosition(chunkIndex:number,offset:number){
    const current=chunks.find(chunk=>chunk.chunk_index===chunkIndex);
    if(!current || working || !Number.isInteger(offset) || offset<0 ||
       offset>Array.from(current.body).length)return;
    const revisionBeforeSave=expectedCursorRevision(progressRef.current);
    setWorking(true);
    viewedRef.current={chunk_index:chunkIndex,char_offset:offset};
    await saveBookmark(current.chunk_index,offset,revisionBeforeSave);
    setReadingAnchor({chunk_index:chunkIndex,char_offset:offset});
    setWorking(false);
  }

  async function addPin(index?:number){
    const current=index??chunks[0]?.chunk_index;
    if(current===undefined || pinWorking)return;
    setPinWorking(true);
    try{
      const {data,error}=await client.rpc("v2_put_saved_bookmark",{
        target_room:roomId,target_chunk:current,target_label:pinLabel.trim(),
      });
      if(error || data!==true){
        setPinMessage("私人标记未保存：可能超过 20 条或无写入权限。");
      }else{
        setPinLabel("");
        setPinMessage("已保存本人的私人段落标记。");
        await refreshPins();
        channelRef.current?.postMessage("pins-updated");
      }
    }catch{setPinMessage("网络异常，私人标记暂未确认保存。");}
    finally{setPinWorking(false);}
  }

  async function removePin(chunk:number){
    if(pinWorking || confirmUnpin!==chunk)return;
    setPinWorking(true);
    try{
      const {data,error}=await client.rpc("v2_remove_saved_bookmark",{
        target_room:roomId,target_chunk:chunk,
      });
      if(error || data!==true){
        setPinMessage("无法移除这个私人标记，可能已在其他设备移除。");
      }else{
        setPinMessage("该私人标记已移除，不影响书房伙伴的记录。");
        await refreshPins();
        channelRef.current?.postMessage("pins-updated");
      }
    }catch{setPinMessage("标记删除失败，请稍后重试。");}
    finally{setConfirmUnpin(null);setPinWorking(false);}
  }

  async function confirmRights(){
    if(!owner||rightsBusy)return;
    setRightsBusy(true);
    try{
      const {data,error}=await client.rpc("v2_confirm_book_rights",{
        target_room:roomId,rights_basis:rightsBasis,
      });
      setRightsConfirmed(!error&&data===true);
      setMessage(!error&&data===true
        ?"仅确认你声明拥有相应使用权；并不代表平台已经审核版权证明。"
        :"版权声明未被服务器接受，请检查书房权限及测试迁移。");
    }catch{setRightsConfirmed(false);setMessage("版权声明未确认；不能上传。");}
    finally{setRightsBusy(false);}
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!owner || !rightsConfirmed || working || !draft || draft.length > 3000) return;
    setWorking(true);
    setMessage("");
    const { data, error } = await client.rpc("v2_upload_book_chunk", {
      target_room: roomId,
      target_index: uploadIndex,
      chunk_text: draft,
    });
    if (!error && data === true) {
      setMessage("测试文本块已写入受保护的数据库。");
      setDraft("");
      setUploadIndex((index) => Math.min(index + 1, 1999));
    } else {
      setMessage("上传未完成：可能是序号已存在、已达到测试配额，或没有写入权限。");
    }
    setWorking(false);
  }

  async function read(index: number, fromRemoteBookmark = false, restoreOffset = 0) {
    if (working || !Number.isInteger(index) || index < 0 || index > 1999) return;
    const revisionAtNavigationStart=expectedCursorRevision(progressRef.current);
    setWorking(true);
    setMessage("");
    try {
    const { data, error } = await client.rpc("v2_read_book_chunks", {
      target_room: roomId,
      from_index: index,
      requested_count: spreadSize(wideSpread),
    });
    if (error) {
      setMessage("读取失败；已打开的正文和未发送批注仍然保留。请检查网络和阅读权限。");
    } else if (!Array.isArray(data) || data.length === 0) {
      setMessage("当前段落不存在、你无权读取，或已达到每小时读取限额。");
    } else {
      const verified:ProtectedChunk[]=checkedReaderPages(data,index,wideSpread);
      if(verified.length){
        // Explicitly opening this chunk unlocks only already-viewable
        // shared annotation context; RLS still protects all later chunks.
        const lastLoaded=verified[verified.length-1].chunk_index;
        const acknowledgement=await client.rpc("v2_acknowledge_read_chunk",{
          target_room:roomId,target_chunk:lastLoaded,
        });
        if(acknowledgement.error || acknowledgement.data!==true){
          setMessage("正文已获取，但共享批注解锁失败；请检查测试数据库迁移。");
          return;
        }
        attemptedCompanionRef.current=null;
        setChunks(verified);
        setPageStart(index);
        setReadIndex(index);
      }
      if (verified.length) {
        const point=fromRemoteBookmark && restoreOffset>=0 &&
          restoreOffset<=Array.from(verified[0].body).length ? restoreOffset : 0;
        viewedRef.current={chunk_index:index,char_offset:point};
        setReadingAnchor(fromRemoteBookmark ? {chunk_index:index,char_offset:point} : null);
        if(fromRemoteBookmark) {
          recordConflict(null);
          setMessage("已恢复服务器上的阅读位置，不会重复覆盖书签。");
        } else {
          await saveBookmark(index,0,revisionAtNavigationStart);
        }
      } else setMessage("服务器返回的数据格式不正确。");
    }
    } catch {
      setMessage("读取连接失败。已打开的文字与尚未发送的批注不会被清空。");
    } finally {
      setWorking(false);
    }
  }

  async function turnPage(direction:-1|1,restoreFocus=false) {
    const next=readingPageIndex(pageStart,direction,wideSpread);
    if(next===pageStart || working)return;
    await read(next);
    if(restoreFocus)window.requestAnimationFrame(()=>{
      pagesRef.current?.querySelector<HTMLElement>(".v2-reader-page")?.focus();
    });
  }

  return (
    <section className="mt-4 rounded-lg border border-[#e0d9cc] p-4" style={{ backgroundColor: textBackground }}>
      <h4 className="font-serif text-base">受保护的正文 · 测试</h4>
      <p className="mt-1 text-xs leading-5 text-[#817668]">
        手机每次按需读取一段，宽屏最多读取相邻两段，每段不超过 3000 字。服务端核对成员资格，
        每位成员每书房每小时最多读取 60 段。
      </p>
      {owner && (
        <details className="mt-4 rounded-lg border border-[#ddd4c7] p-3">
          <summary className="cursor-pointer text-sm font-medium">
            房主上传与导入测试文本（需要时展开）
          </summary>
        <div className="mt-4 space-y-2 rounded-lg border border-[#e0d9cc] p-3">
          <p className="text-xs leading-6">上传须先由房主向服务器明确声明作品来源：原创、已进入公有领域，或已获授权。声明不等于平台已验证版权；不确定权利时请勿上传。</p>
          <label className="block text-xs">选择使用依据
            <select className={inputClass+" mt-1"} value={rightsBasis} disabled={rightsBusy}
              onChange={e=>{setRightsBasis(e.target.value as typeof rightsBasis);setRightsConfirmed(false);}}>
              <option value="original">我创作的原创文字</option>
              <option value="public_domain">已确认进入公有领域</option>
              <option value="licensed">拥有明确的上传及分享授权</option>
            </select>
          </label>
          <button type="button" className={buttonClass} disabled={rightsBusy}
            onClick={()=>{void confirmRights();}}>{rightsBusy?"确认中…":rightsConfirmed?"更改或重新确认版权声明":"向测试数据库确认版权声明"}</button>
          <p className="text-xs text-[#817668]">{rightsConfirmed?"当前会话已完成服务器确认。":"未确认前禁止上传；已存在的测试正文不受此按钮影响。"}</p>
        </div>
        <form onSubmit={(event) => { void upload(event); }} className="mt-4 space-y-2">
          <label className="block text-xs">
            测试段落序号（0—1999）
            <input type="number" className={inputClass} min={0} max={1999}
              value={uploadIndex} onChange={(e) => setUploadIndex(Number(e.target.value))} />
          </label>
          <label className="block text-xs">
            上传自己有权使用的短文本（不能覆盖已有段落）
            <textarea className={inputClass + " mt-1 min-h-28"} maxLength={3000}
              value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="仅上传测试文字，勿上传真实私人书籍…" />
          </label>
          <button type="submit" className={buttonClass}
            disabled={!rightsConfirmed || working || !draft.trim() || draft.length > 3000 ||
              uploadIndex < 0 || uploadIndex > 1999}>
            上传测试段落
          </button>
        </form>
        <V2TxtImporter client={client} roomId={roomId}
          rightsConfirmed={rightsConfirmed}
          onComplete={() => { void refreshMetadata(); }} />
        </details>
      )}
      <details ref={bookmarkRef} className="mt-4 rounded-lg border border-[#e2d9cb] bg-white/70 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          我的私人阅读进度、章节目录及标记
          {conflict?"（另一设备的书签需要确认）":""}
        </summary>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-sm font-medium">我的阅读书签</h5>
          <button type="button" className={buttonClass} disabled={metaLoading || working}
            onClick={() => { void refreshMetadata(); }}>
            {metaLoading ? "同步中…" : "同步目录与书签"}
          </button>
        </div>
        <p className="mt-2 text-xs text-[#817668]">
          {progress ? "我的云端进度：第 " + (progress.chunk_index + 1) +
            " 段 · 第 " + progress.char_offset + " 个 Unicode 字符之后（版本 " +
            progress.revision + "）" : "暂无云端进度。阅读后尝试同步。"}
        </p>
        <p className="mt-1 text-xs text-[#817668]">
          每 45 秒、窗口重新获得焦点时和同账号其他标签页操作后检查新版本。
          发现不同位置会提示确认，不会擅自跳转或覆盖。
          共读伙伴无法查看你的私人书签。
        </p>
        {progress && (
          <button type="button" className={buttonClass + " mt-2"} disabled={working}
            onClick={() => { void read(progress.chunk_index,true,progress.char_offset); }}>
            从我的书签继续
          </button>
        )}
        {conflict && (
          <div className="mt-3 rounded-lg border border-amber-300 p-3">
            <p className="text-xs leading-5">
              另一设备记录第 {conflict.remote.chunk_index + 1} 段，
              第 {conflict.remote.char_offset} 字之后。
              你的本地位置是第 {conflict.desired.chunk_index + 1} 段，
              第 {conflict.desired.char_offset} 字之后。
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={buttonClass} disabled={working}
                onClick={() => { void read(conflict.remote.chunk_index,true,conflict.remote.char_offset); }}>
                使用另一设备位置
              </button>
              <button type="button" className={buttonClass} disabled={working}
                onClick={() => {
                  setWorking(true);
                  void saveBookmark(conflict.desired.chunk_index,
                    conflict.desired.char_offset,conflict.remote.revision)
                    .finally(() => setWorking(false));
                }}>
                明确以当前段落覆盖书签
              </button>
            </div>
          </div>
        )}
        <div className="mt-3 border-t border-[#e3d9cc] pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h6 className="text-sm font-medium">我的私人标记（{savedPins.length} / 20）</h6>
            <button type="button" className={buttonClass} disabled={pinWorking}
              onClick={() => { void refreshPins(); }}>刷新标记</button>
          </div>
          <p className="mt-1 text-xs text-[#817668]">
            可以额外保存多处段落，不会共享给同一书房的伙伴。
          </p>
          {chunks.length>0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-xs">
                标记名称（可留空）
                <input type="text" maxLength={80}
                  className={inputClass + " mt-1"} value={pinLabel}
                  onChange={(event)=>setPinLabel(event.target.value)}
                  placeholder="例如：重要的对话"/>
              </label>
              <button type="button" className={buttonClass}
                disabled={pinWorking || (savedPins.length>=20 &&
                  !savedPins.some((pin)=>pin.chunk_index===chunks[0]?.chunk_index))}
                onClick={()=>{void addPin();}}>
                标记当前段落 {chunks[0].chunk_index + 1}
              </button>
            </div>
          )}
          {pinMessage && <p role="status" className="mt-2 text-xs text-[#76563a]">{pinMessage}</p>}
          <div className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto">
            {savedPins.length===0 && <p className="text-xs text-[#817668]">还没有保存过私人标记。</p>}
            {savedPins.map((pin)=>(
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e2d9cb] p-2"
                key={pin.chunk_index}>
                <span className="mr-auto text-xs">
                  第 {pin.chunk_index+1} 段
                  {pin.label ? " · "+pin.label : ""}
                </span>
                <button type="button" className={buttonClass} disabled={working}
                  onClick={()=>{void read(pin.chunk_index);}}>阅读</button>
                {confirmUnpin===pin.chunk_index ? (
                  <>
                    <button type="button" className={buttonClass} disabled={pinWorking}
                      onClick={()=>{void removePin(pin.chunk_index);}}>确认移除</button>
                    <button type="button" className={buttonClass} disabled={pinWorking}
                      onClick={()=>setConfirmUnpin(null)}>取消</button>
                  </>
                ) : (
                  <button type="button" className={buttonClass} disabled={pinWorking}
                    onClick={()=>setConfirmUnpin(pin.chunk_index)}>移除</button>
                )}
              </div>
            ))}
          </div>
        </div>
        <details ref={catalogRef} className="mt-3">
          <summary className="cursor-pointer text-sm">
            章节目录（展开可能显示后续章节名称）
          </summary>
          {chapters.length === 0
            ? <p className="mt-2 text-xs text-[#817668]">暂无已发布章节。</p>
            : <div className="mt-2 flex max-h-52 flex-col gap-2 overflow-auto">
                {chapters.map((chapter) => (
                  <button type="button" key={chapter.chapter_position}
                    disabled={working} className={buttonClass + " text-left"}
                    onClick={() => { void read(chapter.start_chunk); }}>
                    {chapter.title} · 第 {chapter.start_chunk + 1} 段
                  </button>
                ))}
              </div>}
        </details>
      </details>
      {activePanel && (
        <div ref={panelRef} className="mt-4 rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm">
          {activePanel === "settings" ? (
            <div className="space-y-4">
              <h5 className="font-serif text-base">阅读设置</h5>
              <label className="block text-sm">
                字号：{fontSize} px
                <input className="mt-2 w-full accent-[#7f93b7]" type="range"
                  min={14} max={24} step={2} value={fontSize}
                  onChange={(event) => setFontSize(Number(event.target.value))} />
              </label>
              <label className="block text-sm">
                行距：{lineHeight.toFixed(1)}
                <input className="mt-2 w-full accent-[#7f93b7]" type="range"
                  min={1.5} max={2.3} step={0.2} value={lineHeight}
                  onChange={(event) => setLineHeight(Number(event.target.value))} />
              </label>
              <label className="block text-sm">
                纸张色彩
                <select className="mt-2 block w-full rounded-xl border border-[#d7d0c5] bg-white p-2 text-sm"
                  value={readerTheme}
                  onChange={(event) => setReaderTheme(
                    event.target.value as "paper" | "white" | "mist",
                  )}>
                  <option value="paper">暖纸色</option>
                  <option value="white">浅白色</option>
                  <option value="mist">雾灰色</option>
                </select>
              </label>
              <p className="text-xs text-[#776b5e]">
                以上设置即时应用于当前阅读页面，不会向数据库写入个人偏好。
              </p>
            </div>
          ) : (
            <div>
              <h5 className="font-serif text-base">双人共读</h5>
              {memberError && <p role="status" className="mt-2 text-xs">{memberError}</p>}
              <p className="mt-2 text-sm">
                已加入成员：{memberRoles.length} / 2
              </p>
              <p className="mt-2 text-xs leading-6 text-[#6b6560]">
                {memberRoles.includes("owner") ? "房主已加入。" : "房主信息尚未加载。"}
                {memberRoles.includes("partner") ? " 共读伙伴已加入。" : " 暂无共读伙伴。"}
              </p>
              <p role="status" className="mt-2 text-xs text-[#817668]">
                {companionPresenceMessage(companionPresence)}
              </p>
              <p className="mt-2 text-xs text-[#817668]">
                只显示近 90 秒活跃提示；双方的阅读位置、选中文字和私人批注均不随在线信号传输。
              </p>
              <p className="mt-2 text-xs text-[#817668]">
                双方共享的当前页批注、手绘与已展开回复会自动检查更新；
                断线时可手动刷新，未来章节的笔记需要你先主动打开该章节才显示。
              </p>
            </div>
          )}
        </div>
      )}
      <nav aria-label="阅读翻页和段落导航" className="mt-4 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs">
          跳转到段落
          <input type="number" min={0} max={1999} value={readIndex}
            onChange={(e)=>setReadIndex(Number(e.target.value))}
            className="w-24 rounded-lg border border-[#cfc4b3] bg-white px-2 py-1.5"/>
        </label>
        <button type="button" className={buttonClass}
          disabled={working || !Number.isInteger(readIndex) || readIndex<0 || readIndex>1999}
          onClick={()=>{void read(readIndex);}}>跳转</button>
        <button type="button" className={buttonClass}
          disabled={working || !chunks.length || pageStart===0}
          onClick={()=>{void turnPage(-1);}}>
          上一{wideSpread?"组":"页"}
        </button>
        <button type="button" className={buttonClass}
          disabled={working || !chunks.length || pageStart>=1999}
          onClick={()=>{void turnPage(1);}}>
          下一{wideSpread?"组":"页"}
        </button>
        <p className="text-xs text-[#776b5e]" role="status">
          {wideSpread?"电脑双页":"手机单页"} ·
          {chunks.length ? " 当前第 "+(pageStart+1)+" 段起" : " 尚未打开正文"}
        </p>
      </nav>
      {message && <p role="status" className="mt-3 text-xs text-[#76563a]">{message}</p>}
      {chunks.length>0 && (
        <div ref={pagesRef} className="v2-reader-pages" aria-label="正文阅读区域">
          {chunks.slice(0,spreadSize(wideSpread)).map((chunk,pageNumber)=>(
            <article key={roomId+":"+chunk.chunk_index}
              className="v2-reader-page"
              style={{backgroundColor:textBackground}}
              role="region" aria-label={
                "阅读第 "+(chunk.chunk_index+1)+" 段"+(pageNumber===0?"，左页或单页":"，右页")
              }
              tabIndex={0}
              onKeyDown={(event)=>{
                // Only the focused page surface uses arrow shortcuts.
                // Text selection, links, menus and editors retain native keys.
                if(event.target!==event.currentTarget || event.altKey ||
                   event.ctrlKey || event.metaKey || event.shiftKey ||
                   !["ArrowLeft","ArrowRight"].includes(event.key))return;
                event.preventDefault();
                const direction=event.key==="ArrowRight"?1:-1;
                if(!working)void turnPage(direction,true);
              }}>
              <div className="v2-reader-folio">
                <span>{pageNumber===0?"Ⅰ":"Ⅱ"}</span>
                <span>段落 {chunk.chunk_index+1}</span>
                <button type="button" className="rounded-md border border-[#bbaea0] px-2 py-1 text-xs"
                  disabled={working || pinWorking}
                  title={"仅自己可见的第 "+(chunk.chunk_index+1)+" 段书签"}
                  onClick={()=>{void addPin(chunk.chunk_index);}}>
                  私人书签
                </button>
              </div>
              <V2Annotations client={client} roomId={roomId} userId={userId}
                activityRevision={activityRevision}
                chunkIndex={chunk.chunk_index} body={chunk.body}
                fontSize={fontSize} lineHeight={lineHeight}
                showAnnotations={annotationsShown}
                readingAnchor={readingAnchor?.chunk_index===chunk.chunk_index
                  ? readingAnchor.char_offset : null}
                onSetReadingPosition={(offset)=>{
                  void saveExactPosition(chunk.chunk_index,offset);
                }}/>
            </article>
          ))}
          {wideSpread && chunks.length===1 && (
            <div className="v2-reader-page v2-reader-page-empty"
              role="note" aria-label="右页没有可读取的下一段">
              <p>下一段暂不可读</p>
              <p className="mt-2 text-xs">可能尚未上传，或本次读取额度已用完。</p>
            </div>
          )}
        </div>
      )}
      <V2GlassDock
        annotationsShown={annotationsShown}
        activePanel={activePanel}
        disabled={working}
        onCatalog={() => {
          if(bookmarkRef.current)bookmarkRef.current.open=true;
          if (catalogRef.current) {
            catalogRef.current.open = true;
            catalogRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }}
        onBookmark={() => {
          if(bookmarkRef.current)bookmarkRef.current.open=true;
          bookmarkRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }}
        onAnnotations={() => setAnnotationsShown((current) => !current)}
        onCompanion={() => setActivePanel((current) =>
          current === "companion" ? null : "companion")}
        onSettings={() => setActivePanel((current) =>
          current === "settings" ? null : "settings")}
      />
    </section>
  );
}
