"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { getV2StagingClient, v2StagingConfigured } from "@/lib/v2/staging";
import { V2ProtectedBook } from "./V2ProtectedBook";
import {authEventView,recoveryReturnUrl,validNewPassword,type AuthView} from "@/lib/v2/authSafety";

type RoomRow = {
  id: string;
  owner_id: string;
  title: string;
  state: "active" | "archived" | "closed";
  created_at: string;
};

type JoinRequestRow = {
  id: string;
  room_id: string;
  requester_id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requested_at: string;
};
type OwnRequest = {
  room_id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requested_at: string;
  reviewed_at: string | null;
};
function isOwnRequest(value:unknown):value is OwnRequest {
  if(!value || typeof value!=="object")return false;
  const r=value as Record<string,unknown>;
  return typeof r.room_id==="string" &&
    ["pending","approved","rejected","cancelled"].includes(String(r.status)) &&
    typeof r.requested_at==="string" &&
    (r.reviewed_at===null || typeof r.reviewed_at==="string");
}

const fieldClass =
  "w-full rounded-lg border border-[#cfc4b3] bg-white px-3 py-2 text-sm outline-none focus:border-[#6c4e39]";
const buttonClass =
  "rounded-lg bg-[#342e29] px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass =
  "rounded-lg border border-[#cfc4b3] px-3 py-2 text-sm disabled:opacity-50";

function readableMessage(value: unknown): string {
  return typeof value === "string" ? value : "操作未完成，请稍后再试。";
}

export function V2Preview() {
  const client = getV2StagingClient();
  const [session, setSession] = useState<Session | null>(null);
  // Invalidate pending room/approval responses when the authenticated user
  // changes, and invalidate superseded refresh requests within a session.
  const authEpochRef=useRef(0);
  const loadEpochRef=useRef(0);
  const currentUserRef=useRef<string | null>(null);
  const recoveryActiveRef=useRef(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [mode, setMode] = useState<AuthView>("login");
  const [recoveryActive,setRecoveryActive] = useState(false);
  const [newPassword,setNewPassword] = useState("");
  const [repeatPassword,setRepeatPassword] = useState("");
  const [recoveryPasswordChanged,setRecoveryPasswordChanged] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [requests, setRequests] = useState<JoinRequestRow[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [ownRequests,setOwnRequests] = useState<OwnRequest[]>([]);
  const [memberCounts,setMemberCounts] = useState<Record<string,number>>({});
  const [confirmRevoke,setConfirmRevoke] = useState<string | null>(null);
  const [roomTitle, setRoomTitle] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [visibleInvites, setVisibleInvites] = useState<Record<string, string>>({});
  const [openReaderRoomId, setOpenReaderRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const initialEpoch=authEpochRef.current;
    void client.auth.getSession().then(({ data, error }) => {
      if (!active || initialEpoch!==authEpochRef.current) return;
      if (error) setStatus("读取登录状态失败，请刷新测试页面。");
      currentUserRef.current=data.session?.user.id??null;
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: { subscription } } = client.auth.onAuthStateChange(
      (event, nextSession) => {
        if (!active) return;
        const outcome=authEventView(event,recoveryActiveRef.current);
        if(outcome==="password_reset"){
          recoveryActiveRef.current=true;
          setRecoveryActive(true);
          setPassword("");
          setNewPassword("");
          setRepeatPassword("");
          setRecoveryPasswordChanged(false);
          setStatus("已验证找回密码链接。请设置新密码；不会直接打开书房。");
        }else if(outcome==="signed_out"){
          recoveryActiveRef.current=false;
          setRecoveryActive(false);
          setNewPassword("");
          setRepeatPassword("");
          setRecoveryPasswordChanged(false);
        }
        const nextUser=nextSession?.user.id??null;
        if(currentUserRef.current!==nextUser){
          authEpochRef.current++;
          loadEpochRef.current++;
          currentUserRef.current=nextUser;
          setRooms([]);
          setRequests([]);
          setOwnRequests([]);
          setMemberCounts({});
          setConfirmRevoke(null);
          setEmail("");
          setPassword("");
          setVisibleInvites({});
          setOpenReaderRoomId(null);
        }
        setSession(nextSession);
        setAuthChecked(true);
      },
    );
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  const loadRooms = useCallback(async () => {
    if (!client || !session) return;
    const authEpoch=authEpochRef.current;
    const loadEpoch=++loadEpochRef.current;
    const stillCurrent=()=>authEpoch===authEpochRef.current &&
      loadEpoch===loadEpochRef.current &&
      currentUserRef.current===session.user.id;
    setLoadingRooms(true);
    const { data, error } = await client
      .from("reading_rooms_v2")
      .select("id,owner_id,title,state,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if(!stillCurrent())return;
    if (error) {
      setRooms([]);
      setRequests([]);
      setOwnRequests([]);
      setMemberCounts({});
      setStatus("读取失败：请先在独立测试项目安装 V2 数据库迁移，并检查 RLS。");
      setLoadingRooms(false);
      return;
    }
    const nextRooms = (data ?? []) as RoomRow[];
    setRooms(nextRooms);
    // Each request is scoped to auth.uid() inside a SECURITY DEFINER RPC;
    // never expose an invitation code, applicant email or invite secret.
    const personal = await client.rpc("v2_my_join_requests");
    if(!stillCurrent())return;
    if(personal.error){
      setOwnRequests([]);
      setStatus("申请记录暂时无法同步，请检查 V2 数据库迁移或网络。");
    }else{
      setOwnRequests((Array.isArray(personal.data)?personal.data:[]).filter(isOwnRequest));
    }
    if(nextRooms.length){
      const membership=await client.from("reading_members_v2")
        .select("room_id,role").in("room_id",nextRooms.map(room=>room.id))
        .is("left_at",null).limit(200);
      if(!stillCurrent())return;
      if(membership.error){
        setMemberCounts({});
        setStatus("房间成员数量暂时不可用。");
      }else{
        const counts:Record<string,number>={};
        for(const member of membership.data??[]){
          if(typeof member.room_id==="string" &&
            (member.role==="owner" || member.role==="partner")){
            counts[member.room_id]=(counts[member.room_id]??0)+1;
          }
        }
        setMemberCounts(counts);
      }
    }else setMemberCounts({});
    const mine = nextRooms.filter((r) => r.owner_id === session.user.id).map((r) => r.id);
    if (mine.length) {
      const response = await client
        .from("reading_join_requests_v2")
        .select("id,room_id,requester_id,status,requested_at")
        .in("room_id", mine)
        .eq("status", "pending")
        .order("requested_at", { ascending: true });
      if(!stillCurrent())return;
      if (response.error) {
        setStatus("获取待审批请求失败，请检查测试项目权限。");
      }
      setRequests((response.data ?? []) as JoinRequestRow[]);
    } else {
      setRequests([]);
    }
    setLoadingRooms(false);
  }, [client, session]);

  useEffect(() => {
    if (!client || !session) return;
    const timer = window.setTimeout(() => { void loadRooms(); }, 0);
    return () => window.clearTimeout(timer);
  }, [client, session, loadRooms]);

  useEffect(()=>{
    if(!client || !session)return;
    const onReturn=()=>{
      if(!document.hidden)void loadRooms();
    };
    window.addEventListener("focus",onReturn);
    document.addEventListener("visibilitychange",onReturn);
    return ()=>{
      window.removeEventListener("focus",onReturn);
      document.removeEventListener("visibilitychange",onReturn);
    };
  },[client,session,loadRooms]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const safeEmail=email.trim();
      if(mode==="reset"){
        const redirectTo=recoveryReturnUrl(window.location.href);
        if(!redirectTo){
          setStatus("找回密码链接只能返回当前 V2 测试页面，请从正确的预览地址进入。");
          return;
        }
        // Always give the same response for registered and unknown emails.
        const {error}=await client.auth.resetPasswordForEmail(safeEmail,{
          redirectTo,
        });
        setStatus(error
          ?"暂时无法提交找回请求，请稍后再试。"
          :"如果该邮箱已注册，请按邮件中的说明重设密码。若未收到，请检查垃圾邮件。");
      } else if(mode==="signup"){
        if(!validNewPassword(password)){
          setStatus("注册密码需 12—128 个字符，请重新设置。");
          return;
        }
        const redirectTo=recoveryReturnUrl(window.location.href);
        if(!redirectTo){
          setStatus("确认邮箱邮件只能返回当前 V2 测试页面。");
          return;
        }
        const {data,error}=await client.auth.signUp({
          email:safeEmail,password,options:{emailRedirectTo:redirectTo},
        });
        setStatus(error
          ?"注册请求未完成。请检查密码规则、网络或邮箱配置。"
          :data.session?"已登录独立测试环境。"
          :"如果此邮箱可以注册，请检查收件箱并验证邮件后登录。");
      } else {
        const {error}=await client.auth.signInWithPassword({
          email:safeEmail,password,
        });
        setStatus(error
          ?"登录失败，请检查邮箱、密码或邮件验证状态。"
          :"已登录测试书房。");
      }
    } catch {
      setStatus("身份服务暂时无法连接，请检查网络后重试。");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function resendVerification(){
    if(!client || busy || !email.trim())return;
    setBusy(true);
    try{
      const redirectTo=recoveryReturnUrl(window.location.href);
      if(!redirectTo){
        setStatus("请从正确的 V2 测试预览路径申请验证邮件。");
        return;
      }
      const {error}=await client.auth.resend({
        type:"signup",email:email.trim(),options:{emailRedirectTo:redirectTo},
      });
      setStatus(error
        ?"验证邮件请求未完成，请稍后再试。"
        :"如果该邮箱有待验证的注册申请，请检查收件箱或垃圾邮件。");
    }catch{
      setStatus("身份服务暂时不可达，请稍后重试。");
    }finally{
      setBusy(false);
    }
  }

  async function finishRecovery(event: FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!client || busy || !session || !recoveryActiveRef.current)return;
    if(!recoveryPasswordChanged &&
       (!validNewPassword(newPassword) || newPassword!==repeatPassword)){
      setStatus("新密码需 12—128 字符，且两次输入一致。");
      return;
    }
    setBusy(true);
    try{
      if(!recoveryPasswordChanged){
        const {error}=await client.auth.updateUser({password:newPassword});
        if(error){
          setStatus("密码更新失败：链接可能过期，或测试项目要求更严格的密码。请重试。");
          return;
        }
        setRecoveryPasswordChanged(true);
      }
      // Preserve the reset-only screen until sign-out is confirmed.
      // The Supabase Auth provider, not client UI, enforces token lifetimes.
      const {error:signOutError}=await client.auth.signOut({scope:"global"});
      if(signOutError){
        setStatus("密码已更新，但未能退出所有会话。请点击“重试退出”，不要进入书房。");
        return;
      }
      recoveryActiveRef.current=false;
      setRecoveryActive(false);
      setRecoveryPasswordChanged(false);
      setMode("login");
      setStatus("密码已更新，已请求退出所有设备。请用新密码重新登录；部分旧访问令牌可能直至到期才失效。");
    }catch{
      setStatus(recoveryPasswordChanged
        ?"密码已修改，但退出请求未确认。请重试退出，不要重复修改密码。"
        :"网络异常，密码变更结果尚不确定。请检查邮件并重新登录核实。");
    }finally{
      setNewPassword("");
      setRepeatPassword("");
      setBusy(false);
    }
  }

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy) return;
    const title = roomTitle.trim();
    if (!title || title.length > 200) return;
    setBusy(true);
    const { error } = await client.rpc("v2_create_reading_room", { book_title: title });
    setStatus(error ? "创建失败：请检查测试项目迁移与配额。" : "测试书房已创建。");
    if (!error) {
      setRoomTitle("");
      await loadRooms();
    }
    setBusy(false);
  }

  async function createInvite(roomId: string) {
    if (!client || busy) return;
    setBusy(true);
    const { data, error } = await client.rpc("v2_create_room_invite", { target_room: roomId });
    if (!error && typeof data === "string") {
      setConfirmRevoke(null);
      setVisibleInvites((current) => ({ ...current, [roomId]: data }));
      setStatus("邀请码只在本页面临时显示。离开后需重新生成。");
    } else {
      setStatus("邀请码生成失败；请检查房主权限、成员人数及测试项目配置。");
    }
    setBusy(false);
  }

  async function revokeInvite(roomId:string) {
    if(!client || busy || confirmRevoke!==roomId)return;
    setBusy(true);
    const {data,error}=await client.rpc("v2_revoke_room_invite",{
      target_room:roomId,
    });
    setConfirmRevoke(null);
    setVisibleInvites(current=>{
      const next={...current};
      delete next[roomId];
      return next;
    });
    setStatus(!error && data===true
      ?"邀请码已撤销；相关待审批申请自动失效。"
      :"邀请码可能已过期或被使用，请刷新后确认。");
    await loadRooms();
    setBusy(false);
  }

  async function withdrawRequest(roomId:string) {
    if(!client || busy)return;
    setBusy(true);
    const {data,error}=await client.rpc("v2_withdraw_room_join",{
      target_room:roomId,
    });
    setStatus(!error && data===true
      ?"申请已撤回；不会自动加入书房。"
      :"未能撤回：可能已经获批或被房主处理，请刷新状态。");
    await loadRooms();
    setBusy(false);
  }

  async function requestJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy) return;
    const code = inviteInput.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      setStatus("请输入正确格式的 6 位邀请码。");
      return;
    }
    setBusy(true);
    const { data, error } = await client.rpc("v2_request_room_join", { invite_code: code });
    if (error) {
      setStatus("提交失败，请稍后再试。");
    } else {
      const response = readableMessage(data);
      setStatus(
        response === "submitted" ? "已发送加入申请，等待房主批准。" :
        response === "rate_limited" ? "尝试次数过多，请稍后再试。" :
        "邀请码无效、已过期，或房间已满。",
      );
      setInviteInput("");
      await loadRooms();
    }
    setBusy(false);
  }

  async function reviewJoin(roomId: string, requesterId: string, approve: boolean) {
    if (!client || busy) return;
    setBusy(true);
    const { data, error } = await client.rpc("v2_review_room_join", {
      target_room: roomId,
      requester: requesterId,
      approve,
    });
    setStatus(
      error || data !== true
        ? "审批未完成。请求可能已失效，或该书房已经有两名成员。"
        : approve ? "已批准加入。" : "已拒绝加入。",
    );
    if(approve && !error && data===true){
      setVisibleInvites(current=>{
        const next={...current};
        delete next[roomId];
        return next;
      });
    }
    await loadRooms();
    setBusy(false);
  }

  async function logout() {
    if (!client || busy) return;
    setBusy(true);
    try{
      const {error}=await client.auth.signOut({scope:"global"});
      setStatus(error
        ?"退出请求失败，请检查网络后重试。"
        :"已请求退出所有登录会话。其他设备的既有访问令牌可能继续有效至过期。");
    }catch{
      setStatus("连接失败，退出结果未确认，请重试。");
    }finally{
      setBusy(false);
    }
  }

  if (!v2StagingConfigured || !client) {
    return (
      <section className="rounded-2xl border border-[#d9d0c1] bg-white/75 p-6">
        <h2 className="font-serif text-xl">V2 预览默认关闭</h2>
        <p className="mt-3 text-sm leading-7 text-[#6b6560]">
          为防误连正式 Supabase，必须使用独立的测试项目，并在构建时显式开启
          NEXT_PUBLIC_ENABLE_V2_PREVIEW。这里不会调用旧版账号和数据库。
        </p>
      </section>
    );
  }

  if (!authChecked) {
    return <p role="status" className="text-sm">正在确认测试环境的登录状态…</p>;
  }

  if (!session) {
    return (
      <section className="max-w-md rounded-2xl border border-[#d9d0c1] bg-white/80 p-6 shadow-sm">
        <h2 className="font-serif text-xl">
          {mode==="signup"?"注册测试账号":mode==="reset"?"找回测试账号密码":"邮箱登录"}
        </h2>
        <form onSubmit={(event) => { void submitAuth(event); }} className="mt-5 space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>测试邮箱</span>
            <input className={fieldClass} type="email" autoComplete="email"
              required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {mode!=="reset" && (
            <label className="block space-y-1.5 text-sm">
              <span>{mode==="signup"?"设置密码（至少 12 字符）":"密码"}</span>
              <input className={fieldClass} type="password" maxLength={128}
                autoComplete={mode==="login"?"current-password":"new-password"}
                required minLength={mode==="signup"?12:undefined}
                value={password} onChange={(e)=>setPassword(e.target.value)}/>
            </label>
          )}
          <button className={buttonClass} type="submit" disabled={busy}>
            {busy?"请稍候…":mode==="signup"?"注册并发送验证邮件":
             mode==="reset"?"发送找回密码邮件":"登录测试账号"}
          </button>
        </form>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          {mode!=="login" && (
            <button type="button" className="underline" disabled={busy}
              onClick={()=>{setMode("login");setPassword("");setStatus("");}}>
              返回登录
            </button>
          )}
          {mode!=="signup" && (
            <button type="button" className="underline" disabled={busy}
              onClick={()=>{setMode("signup");setPassword("");setStatus("");}}>
              注册新账号
            </button>
          )}
          {mode!=="reset" && (
            <button type="button" className="underline" disabled={busy}
              onClick={()=>{setMode("reset");setPassword("");setStatus("");}}>
              忘记密码
            </button>
          )}
        </div>
        {(mode==="signup" || mode==="login") && (
          <button type="button" className="mt-3 text-xs underline"
            disabled={busy || !email.trim()}
            onClick={()=>{void resendVerification();}}>
            未收到邮箱验证邮件？重新请求发送
          </button>
        )}
        {status && <p role="status" className="mt-4 text-sm text-[#76563a]">{status}</p>}
        <p className="mt-5 text-xs leading-6 text-[#817668]">
          此预览只接受独立测试 Supabase 账号，不要填写正式账号密码。
          找回或确认邮件返回当前 V2 页面，不接受外部回跳网址。
          邮件发送速度和账号频率限制由测试身份服务配置决定。
        </p>
      </section>
    );
  }

  if(recoveryActive){
    return (
      <section className="max-w-md rounded-2xl border border-[#d9d0c1] bg-white/80 p-6 shadow-sm">
        <h2 className="font-serif text-xl">重设测试账号密码</h2>
        <p className="mt-2 text-xs leading-6 text-[#817668]">
          已从密码恢复邮件进入受保护会话。完成前不会展示书房；
          不要向任何人转发邮件中的重置链接。
        </p>
        <form onSubmit={(event)=>{void finishRecovery(event);}} className="mt-4 space-y-3">
          {!recoveryPasswordChanged && <><label className="block text-sm">新密码（12—128 字符）
            <input className={fieldClass} type="password" autoComplete="new-password"
              minLength={12} maxLength={128} required
              value={newPassword} onChange={event=>setNewPassword(event.target.value)}/>
          </label>
          <label className="block text-sm">再次输入新密码
            <input className={fieldClass} type="password" autoComplete="new-password"
              minLength={12} maxLength={128} required
              value={repeatPassword} onChange={event=>setRepeatPassword(event.target.value)}/>
          </label>
          </>}
          <button type="submit" className={buttonClass} disabled={busy}>
            {busy?"正在处理…":recoveryPasswordChanged?"重试退出所有设备":"设置新密码并退出其他设备"}
          </button>
        </form>
        <button type="button" className="mt-3 text-sm underline" disabled={busy}
          onClick={()=>{void logout();}}>
          放弃重设并退出
        </button>
        {status && <p role="status" className="mt-4 text-sm text-[#76563a]">{status}</p>}
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#d9d0c1] bg-white/80 p-5">
        <div>
          <p className="text-xs text-[#817668]">已连接测试账号</p>
          <p className="mt-1 break-all text-sm font-medium">{session.user.email ?? "已登录用户"}</p>
        </div>
        <button type="button" className={secondaryButtonClass} disabled={busy}
          onClick={() => { void logout(); }}>退出</button>
      </section>
      {status && <p role="status" className="rounded-lg bg-[#e8dfcf] px-4 py-3 text-sm">{status}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-[#d9d0c1] bg-white/80 p-5">
          <h2 className="font-serif text-lg">创建双人书房</h2>
          <form onSubmit={(event) => { void createRoom(event); }} className="mt-4 flex flex-col gap-3">
            <input className={fieldClass} placeholder="输入书房标题" maxLength={200}
              required value={roomTitle} onChange={(e) => setRoomTitle(e.target.value)} />
            <button className={buttonClass} type="submit" disabled={busy}>创建测试书房</button>
          </form>
        </section>
        <section className="rounded-2xl border border-[#d9d0c1] bg-white/80 p-5">
          <h2 className="font-serif text-lg">申请加入书房</h2>
          <form onSubmit={(event) => { void requestJoin(event); }} className="mt-4 flex flex-col gap-3">
            <input className={fieldClass} placeholder="6 位邀请码" maxLength={6}
              autoCapitalize="characters" required value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value.toUpperCase())} />
            <button className={buttonClass} type="submit" disabled={busy}>发送加入申请</button>
          </form>
        </section>
      </div>
      <section className="rounded-2xl border border-[#d9d0c1] bg-white/80 p-5">
        <h2 className="font-serif text-lg">我的加入申请</h2>
        <p className="mt-1 text-xs text-[#817668]">
          每一条只能由当前账号查询。申请不会自动加入，房主必须批准；已撤销的邀请码无法继续使用。
        </p>
        {ownRequests.length===0 && (
          <p className="mt-3 text-sm text-[#817668]">暂无申请记录。</p>
        )}
        <div className="mt-3 space-y-2">
          {ownRequests.map(request=>(
            <div key={request.room_id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-[#e2d9cb] p-3">
              <span className="mr-auto text-xs">
                书房编号 {request.room_id.slice(0,8)}…
              </span>
              <span className="text-xs" role="status">
                {request.status==="pending"?"等待房主审批（邀请码若过期，房主无法批准）":
                 request.status==="approved"?"已获批准":
                 request.status==="rejected"?"未通过或邀请码已撤销":"已自行撤回"}
              </span>
              {request.status==="pending" && (
                <button type="button" className={secondaryButtonClass}
                  disabled={busy} onClick={()=>{void withdrawRequest(request.room_id);}}>
                  撤回申请
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-2xl border border-[#d9d0c1] bg-white/80 p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-serif text-xl">我的测试书房</h2>
          <button type="button" className={secondaryButtonClass}
            disabled={busy || loadingRooms} onClick={() => { void loadRooms(); }}>
            {loadingRooms ? "读取中…" : "刷新"}
          </button>
        </div>
        {rooms.length === 0 && <p className="text-sm text-[#817668]">暂无可访问的书房。</p>}
        <div className="space-y-4">
          {rooms.map((room) => {
            const isOwner = room.owner_id === session.user.id;
            const pending = requests.filter((r) => r.room_id === room.id);
            return (
              <article key={room.id} className="rounded-xl border border-[#e2d9cb] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">{room.title}</h3>
                  <span className="text-xs text-[#817668]">
                    {isOwner ? "房主" : "共读伙伴"} ·
                    {room.state==="active"?"开放阅读":room.state==="archived"?"已归档":"已关闭"}
                    {memberCounts[room.id]!==undefined
                      ? " · "+memberCounts[room.id]+"/2 位成员":""}
                  </span>
                </div>
                {isOwner && room.state === "active" && (
                  <div className="mt-4 space-y-2">
                    <button type="button" className={secondaryButtonClass} disabled={busy}
                      onClick={() => { void createInvite(room.id); }}>生成或更换邀请码</button>
                    {visibleInvites[room.id] && (
                      <div className="space-y-2 rounded-lg border border-[#e2d9cb] p-3">
                        <p className="text-sm">当前生成的邀请码：
                          <strong className="ml-2 select-all tracking-[0.18em]">{visibleInvites[room.id]}</strong>
                        </p>
                        <p className="text-xs text-[#817668]">
                          有效期最长 24 小时；批准一位伙伴后立即作废。
                          仅将邀请码交给信任的人，发送邀请码本身不会自动批准加入。
                        </p>
                        <button type="button" className={secondaryButtonClass}
                          disabled={busy} onClick={()=>{
                            setVisibleInvites(current=>{
                              const next={...current};
                              delete next[room.id];
                              return next;
                            });
                          }}>
                          隐藏本页邀请码
                        </button>
                      </div>
                    )}
                    {confirmRevoke===room.id ? (
                      <div className="flex flex-wrap items-center gap-2" role="group"
                        aria-label="确认撤销当前邀请码和待审批请求">
                        <span className="text-xs">撤销后，当前邀请码和待审批申请均会失效。</span>
                        <button type="button" className={secondaryButtonClass} disabled={busy}
                          onClick={()=>{void revokeInvite(room.id);}}>确定撤销</button>
                        <button type="button" className={secondaryButtonClass} disabled={busy}
                          onClick={()=>setConfirmRevoke(null)}>取消</button>
                      </div>
                    ) : (
                      <button type="button" className={secondaryButtonClass} disabled={busy}
                        onClick={()=>setConfirmRevoke(room.id)}>撤销当前邀请码</button>
                    )}
                    {pending.length===0 && (
                      <p className="text-xs text-[#817668]">
                        暂无待审批申请。任何邀请码都不会绕过房主审核。
                      </p>
                    )}
                    {pending.map((request) => (
                      <div key={request.id} className="flex flex-wrap items-center gap-2 border-t border-[#e2d9cb] pt-3">
                        <p className="mr-auto break-all text-xs">待审核账号：{request.requester_id}</p>
                        <button type="button" className={buttonClass} disabled={busy}
                          onClick={() => { void reviewJoin(room.id, request.requester_id, true); }}>允许</button>
                        <button type="button" className={secondaryButtonClass} disabled={busy}
                          onClick={() => { void reviewJoin(room.id, request.requester_id, false); }}>拒绝</button>
                      </div>
                    ))}
                  </div>
                )}
                {room.state === "active" && (
                  <div className="mt-4">
                    <button type="button" className={secondaryButtonClass}
                      aria-expanded={openReaderRoomId === room.id}
                      onClick={() => setOpenReaderRoomId((current) => current === room.id ? null : room.id)}>
                      {openReaderRoomId === room.id ? "离开阅读界面" : "进入这本书"}
                    </button>
                    {openReaderRoomId === room.id && (
                      <V2ProtectedBook key={session.user.id + ":" + room.id}
                        client={client} roomId={room.id}
                        owner={isOwner} userId={session.user.id} />
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
      <p className="text-xs leading-6 text-[#817668]">
        本预览接入独立 V2 书房、受保护的章节正文与私人/共享批注。
        邀请码不可代替房主批准；私人书签和草稿不会因加入申请而向申请人公开。
        这是独立测试环境预览，不代表安全功能已在正式站点启用。
      </p>
    </div>
  );
}
