"use client";
import {useCallback,useEffect,useState} from "react";
import type {SupabaseClient} from "@supabase/supabase-js";

type Receipt={report_id:string;reason:string;status:string;created_at:string};
type Case={report_id:string;reason:string;details:string;status:string;created_at:string};
const button="rounded-lg border border-[#bdaea0] bg-white px-3 py-2 text-xs disabled:opacity-50";
export function V2SafetyConsole({client,userId,roomIds}:{
 client:SupabaseClient;userId:string;roomIds:string[];
}){
 const [mine,setMine]=useState<Receipt[]>([]);
 const [cases,setCases]=useState<Case[]>([]);
 const [notice,setNotice]=useState("");
 const [checking,setChecking]=useState(false);
 const [reason,setReason]=useState("");
 const [selected,setSelected]=useState("");
 const [integrity,setIntegrity]=useState<Record<string,string>>({});
 const refresh=useCallback(async()=>{
  try{
   const [own,queue]=await Promise.all([
    client.rpc("v2_my_report_receipts"),client.rpc("v2_review_queue"),
   ]);
   if(own.error||queue.error){setNotice("举报状态或审核服务暂不可用。");return;}
   setMine((Array.isArray(own.data)?own.data:[])
     .filter((x:Receipt)=>typeof x.report_id==="string"&&
       typeof x.status==="string"&&typeof x.reason==="string"));
   setCases((Array.isArray(queue.data)?queue.data:[])
     .filter((x:Case)=>typeof x.report_id==="string"&&
       typeof x.status==="string"&&typeof x.details==="string"));
  }catch{setNotice("网络暂不可用，请稍后刷新。");}
 },[client]);
 useEffect(()=>{
  const timer=window.setTimeout(()=>{void refresh();},0);
  return()=>window.clearTimeout(timer);
 },[refresh,userId]);

 async function review(id:string,status:"reviewed"|"closed"){
  if(checking||reason.trim().length<8)return;
  setChecking(true);
  try{
   const {data,error}=await client.rpc("v2_decide_report",{
    target_report:id,next_status:status,reasoning:reason.trim(),
   });
   setNotice(!error&&data===true?"审核处理已写入受保护的操作记录。":
     "审核未完成：可能尚未获授审核角色，或当前状态不允许操作。");
   if(!error&&data===true){setReason("");setSelected("");await refresh();}
  }catch{setNotice("提交失败，服务器结果未确认。");}
  finally{setChecking(false);}
 }
 async function verify(roomId:string){
  if(checking)return;
  setChecking(true);
  try{
   const {data,error}=await client.rpc("v2_verify_room_audit",{target_room:roomId});
   const r=data as {valid?:boolean;checked_events?:number;head_hash?:string}|null;
   if(error||!r||typeof r.valid!=="boolean"){
    setIntegrity(p=>({...p,[roomId]:"未授权或校验服务不可用"}));
   }else{
    const phrase=r.valid?"数据库内审计链连贯":"检测到审计链异常，请停止信任此记录";
    setIntegrity(p=>({...p,[roomId]:phrase+" · 事件数："+String(r.checked_events??0)+
      "；尚未完成外部独立签名校验"}));
   }
  }catch{setIntegrity(p=>({...p,[roomId]:"校验网络失败"}));}
  finally{setChecking(false);}
 }
 return <section className="rounded-2xl border border-[#d9d0c1] bg-white/80 p-5">
  <h2 className="font-serif text-xl">安全记录与举报处理</h2>
  <p className="mt-2 text-xs leading-6 text-[#817668]">
   举报只显示本人提交的状态。审核详情仅可由服务端事先指定的受信审核人查询。
   审计哈希不是版权凭证，数据库内校验也不等于外部独立审计。
  </p>
  <h3 className="mt-4 text-sm font-medium">我提交的举报</h3>
  {mine.length===0&&<p className="mt-1 text-xs text-[#817668]">暂无记录。</p>}
  {mine.map(r=><p key={r.report_id} className="mt-1 text-xs">
   {r.reason} · {r.status==="pending"?"等待审核":r.status==="reviewed"?"正在处理":"已结案"}
   {" · "}编号 {r.report_id.slice(0,8)}…
  </p>)}
  {cases.length>0&&<div className="mt-5 rounded-lg border border-[#ded3c8] p-3">
   <h3 className="text-sm font-medium">受信审核人工作台</h3>
   <p className="text-xs text-[#817668]">仅显示有服务端权限的审核队列；每次决定必须记录处理理由。</p>
   {cases.map(c=><div key={c.report_id} className="mt-2 border-t pt-2 text-xs">
    <strong>{c.reason} · {c.status} · {c.report_id.slice(0,8)}…</strong>
    <p className="my-2 whitespace-pre-wrap break-words">{c.details}</p>
    {c.status!=="closed"&&<button className={button} disabled={checking}
      onClick={()=>setSelected(c.report_id)} type="button">处理此案</button>}
   </div>)}
   {selected&&<div className="mt-2 space-y-2">
    <label className="block text-xs">处理理由（至少 8 字）
     <textarea className="mt-1 w-full rounded border p-2" maxLength={500}
       value={reason} onChange={e=>setReason(e.target.value)} />
    </label>
    <div className="flex gap-2">
     <button className={button} disabled={checking||reason.trim().length<8}
       onClick={()=>{void review(selected,"reviewed");}}>记录为已审核</button>
     <button className={button} disabled={checking||reason.trim().length<8}
       onClick={()=>{void review(selected,"closed");}}>申请结案</button>
    </div>
   </div>}
  </div>}
  <h3 className="mt-4 text-sm font-medium">书房审计链检查</h3>
  {roomIds.map(id=><div key={id} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
   <span>{id.slice(0,8)}…</span>
   <button className={button} disabled={checking}
    onClick={()=>{void verify(id);}}>校验审计链</button>
   {integrity[id]&&<span role="status">{integrity[id]}</span>}
  </div>)}
  {notice&&<p role="status" className="mt-3 text-xs text-[#76563a]">{notice}</p>}
 </section>;
}
