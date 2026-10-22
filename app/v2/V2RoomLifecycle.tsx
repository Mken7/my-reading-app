"use client";
import { useCallback,useEffect,useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { V2PersonalExport } from "./V2PersonalExport";

type History={room_id:string;book_title:string;role:"owner"|"partner";
 room_state:"active"|"archived"|"closed";left_at:string|null;my_purge_consent:boolean};
type Command="leave"|"close"|"erase"|"consent"|"purge";
const btn="rounded-lg border border-[#c1b1a0] bg-white px-3 py-2 text-xs disabled:opacity-50";
export function V2RoomLifecycle({client,userId,onRoomsChanged}:{
 client:SupabaseClient;userId:string;onRoomsChanged:()=>void;
}){
 const [rooms,setRooms]=useState<History[]>([]);
 const [busy,setBusy]=useState(false);
 const [notice,setNotice]=useState("");
 const [confirm,setConfirm]=useState<{id:string;cmd:Command}|null>(null);
 const [typed,setTyped]=useState("");
 const refresh=useCallback(async()=>{
  const {data,error}=await client.rpc("v2_my_room_history");
  if(error){setNotice("书房历史无法读取，请检查独立测试环境。");return;}
  setRooms((Array.isArray(data)?data:[]).filter((r:History)=>
   typeof r.room_id==="string"&&typeof r.book_title==="string"&&
   ["owner","partner"].includes(r.role)&&["active","archived","closed"].includes(r.room_state)));
 },[client]);
 useEffect(()=>{const t=window.setTimeout(()=>{void refresh();},0);
  return()=>window.clearTimeout(t);},[refresh,userId]);
 const select=(id:string,cmd:Command)=>{setConfirm({id,cmd});setTyped("");};
 async function send(id:string,cmd:Command|"archive"|"restore"){
  if(busy)return;setBusy(true);
  try{
   let data:unknown,error:unknown;
   if(cmd==="archive"||cmd==="restore"||cmd==="close")
    ({data,error}=await client.rpc("v2_change_room_state",{
     target_room:id,target_state:cmd==="archive"?"archived":cmd==="restore"?"active":"closed"}));
   else if(cmd==="leave")({data,error}=await client.rpc("v2_leave_reading_room",{target_room:id}));
   else if(cmd==="erase")({data,error}=await client.rpc("v2_erase_my_room_content",{target_room:id}));
   else if(cmd==="consent")({data,error}=await client.rpc("v2_consent_room_purge",{target_room:id}));
   else ({data,error}=await client.rpc("v2_purge_closed_room",{target_room:id}));
   if(error)setNotice("服务器未确认结果；请刷新核查，避免重复操作。");
   else if(cmd==="purge")setNotice(data==="purged"?"整房已清除":
      data==="waiting_for_consent"?"仍缺少历史成员的删除同意":
      data==="moderation_hold"?"举报审核记录须保留，当前不能清除":"无权执行清除");
   else if(cmd==="erase")setNotice(data?
     "已擦除本人内容；共同书籍、他人的回复及审计/账号记录不会随之删除。":"无法擦除本书房记录");
   else setNotice(data===true||data==="consented"?"操作已获服务器确认。":"操作未获批准。");
   await refresh();onRoomsChanged();setConfirm(null);setTyped("");
  }catch{setNotice("网络中断，结果尚不确定，请刷新确认。");}
  finally{setBusy(false);}
 }
 return <section className="rounded-2xl border border-[#d9d0c1] bg-white/80 p-5">
  <h2 className="font-serif text-xl">退出、归档与数据管理</h2>
  <p className="mt-2 text-xs leading-6 text-[#817668]">
   退出后仍可导出自己的历史记录；归档可恢复，关闭不能恢复。
   完全清除共享书房需要所有历史成员同意，且不能毁掉须保留的举报记录。
  </p>
  <div className="mt-3 space-y-3">
   {rooms.map(room=><article key={room.room_id}
     className="rounded-xl border border-[#e2d9cb] bg-[#faf8f4] p-3">
    <h3 className="font-medium">{room.book_title}</h3>
    <p className="my-2 text-xs text-[#817668]">{room.role==="owner"?"房主":"伙伴"} ·
     {room.room_state}{room.left_at?" · 已退出":""}
     {room.my_purge_consent?" · 已同意删除":""}</p>
    <div className="flex flex-wrap gap-2">
     {room.role==="owner"&&room.room_state==="active"&&
      <button className={btn} disabled={busy} onClick={()=>{void send(room.room_id,"archive");}}>归档</button>}
     {room.role==="owner"&&room.room_state==="archived"&&
      <button className={btn} disabled={busy} onClick={()=>{void send(room.room_id,"restore");}}>恢复</button>}
     {room.role==="owner"&&room.room_state!=="closed"&&
      <button className={btn} disabled={busy} onClick={()=>select(room.room_id,"close")}>永久关闭</button>}
     {room.role==="partner"&&room.room_state==="active"&&!room.left_at&&
      <button className={btn} disabled={busy} onClick={()=>select(room.room_id,"leave")}>退出</button>}
     <button className={btn} disabled={busy} onClick={()=>select(room.room_id,"erase")}>擦除我的内容</button>
     {room.room_state==="closed"&&!room.my_purge_consent&&
      <button className={btn} disabled={busy} onClick={()=>select(room.room_id,"consent")}>同意整房删除</button>}
     {room.room_state==="closed"&&room.role==="owner"&&
      <button className={btn} disabled={busy} onClick={()=>select(room.room_id,"purge")}>清除整房</button>}
    </div>
    {confirm?.id===room.room_id&&<div className="mt-3 rounded-lg border p-3">
     <p className="text-xs">不可逆操作：{confirm.cmd}。请先备份自己的资料。
       个人擦除不包含共享书籍、其他人内容和审计记录。</p>
     <label className="mt-2 block text-xs">输入编号前八位 {room.room_id.slice(0,8)} 确认
      <input className="mt-1 w-full rounded border p-2" value={typed}
       onChange={e=>setTyped(e.target.value)}/></label>
     <button className={btn} disabled={busy||typed!==room.room_id.slice(0,8)}
       onClick={()=>{void send(room.room_id,confirm.cmd);}}>确认操作</button>
     <button className={btn} disabled={busy} onClick={()=>setConfirm(null)}>取消</button>
    </div>}
    <details className="mt-3 text-sm"><summary>我的资料：按页 JSON 导出</summary>
     <V2PersonalExport client={client} roomId={room.room_id}/>
    </details>
   </article>)}
  </div>
  {notice&&<p role="status" className="mt-3 text-xs text-[#76563a]">{notice}</p>}
 </section>;
}
