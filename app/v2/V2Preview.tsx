"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { getV2StagingClient, v2StagingConfigured } from "@/lib/v2/staging";
import { V2ProtectedBook } from "./V2ProtectedBook";

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
  status: "pending" | "approved" | "rejected";
  requested_at: string;
};

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
  const [authChecked, setAuthChecked] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [requests, setRequests] = useState<JoinRequestRow[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [roomTitle, setRoomTitle] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [visibleInvites, setVisibleInvites] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setStatus("读取登录状态失败，请刷新测试页面。");
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: { subscription } } = client.auth.onAuthStateChange(
      (_event, nextSession) => {
        if (!active) return;
        setSession(nextSession);
        if (!nextSession) {
          setRooms([]);
          setRequests([]);
          setVisibleInvites({});
        }
      },
    );
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  const loadRooms = useCallback(async () => {
    if (!client || !session) return;
    setLoadingRooms(true);
    const { data, error } = await client
      .from("reading_rooms_v2")
      .select("id,owner_id,title,state,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      setRooms([]);
      setRequests([]);
      setStatus("读取失败：请先在独立测试项目安装 V2 数据库迁移，并检查 RLS。");
      setLoadingRooms(false);
      return;
    }
    const nextRooms = (data ?? []) as RoomRow[];
    setRooms(nextRooms);
    const mine = nextRooms.filter((r) => r.owner_id === session.user.id).map((r) => r.id);
    if (mine.length) {
      const response = await client
        .from("reading_join_requests_v2")
        .select("id,room_id,requester_id,status,requested_at")
        .in("room_id", mine)
        .eq("status", "pending")
        .order("requested_at", { ascending: true });
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

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true);
    setStatus("");
    const credentials = { email: email.trim(), password };
    if (mode === "signup") {
      const { data, error } = await client.auth.signUp(credentials);
      if (error) {
        setStatus("注册未完成，请检查邮箱、密码及测试项目的注册配置。");
      } else if (!data.session) {
        setStatus("注册请求已受理。如果测试项目开启邮箱验证，请前往邮箱确认后登录。");
      } else {
        setStatus("测试账号已登录。");
      }
    } else {
      const { error } = await client.auth.signInWithPassword(credentials);
      setStatus(error ? "登录失败，请核对邮箱、密码及邮箱验证状态。" : "已登录测试书房。");
    }
    setPassword("");
    setBusy(false);
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
      setVisibleInvites((current) => ({ ...current, [roomId]: data }));
      setStatus("邀请码只在本页面临时显示。离开后需重新生成。");
    } else {
      setStatus("邀请码生成失败；请检查房主权限、成员人数及测试项目配置。");
    }
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
    await loadRooms();
    setBusy(false);
  }

  async function logout() {
    if (!client || busy) return;
    setBusy(true);
    const { error } = await client.auth.signOut();
    setStatus(error ? "退出失败，请重试。" : "已退出测试账号。");
    setBusy(false);
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
        <h2 className="font-serif text-xl">{mode === "login" ? "邮箱登录" : "注册测试账号"}</h2>
        <form onSubmit={(event) => { void submitAuth(event); }} className="mt-5 space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>邮箱</span>
            <input className={fieldClass} type="email" autoComplete="email"
              required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>密码</span>
            <input className={fieldClass} type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required minLength={mode === "signup" ? 8 : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className={buttonClass} type="submit" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录测试账号" : "注册测试账号"}
          </button>
        </form>
        <button type="button" className="mt-4 text-sm underline"
          onClick={() => { setMode(mode === "login" ? "signup" : "login"); setPassword(""); setStatus(""); }}>
          {mode === "login" ? "还没有测试账号？注册" : "已有测试账号？登录"}
        </button>
        {status && <p role="status" className="mt-4 text-sm text-[#76563a]">{status}</p>}
        <p className="mt-5 text-xs leading-6 text-[#817668]">
          此预览只能使用测试账号，不要填写正式账号密码。真实上线前还需验证邮箱确认、密码恢复及注册防滥用。
        </p>
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
                    {isOwner ? "房主" : "共读伙伴"} · {room.state}
                  </span>
                </div>
                {isOwner && room.state === "active" && (
                  <div className="mt-4 space-y-2">
                    <button type="button" className={secondaryButtonClass} disabled={busy}
                      onClick={() => { void createInvite(room.id); }}>生成或更换邀请码</button>
                    {visibleInvites[room.id] && (
                      <p className="text-sm">一次性邀请码：
                        <strong className="ml-2 tracking-[0.18em]">{visibleInvites[room.id]}</strong>
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
                <V2ProtectedBook key={`${session.user.id}:${room.id}`} client={client} roomId={room.id} owner={isOwner} />
              </article>
            );
          })}
        </div>
      </section>
      <p className="text-xs leading-6 text-[#817668]">
        当前仅验证登录、受 RLS 保护的书房列表、邀请码与加入审批。不加载真实书籍正文或原版批注。
        这是独立测试环境预览，不代表安全功能已在正式站点启用。
      </p>
    </div>
  );
}
