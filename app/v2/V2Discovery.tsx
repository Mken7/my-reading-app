"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

type Room={id:string;owner_id:string;state:string};
type Card={room_id:string;public_title:string;public_about:string};
type Listing=Card&{listed:boolean};
type Request={room_id:string;status:"pending"|"approved"|"rejected"|"withdrawn";requested_at:string};
type Applicant={room_id:string;requester_id:string;requested_at:string};
type Block={blocked_id:string};
type Draft={title:string;about:string};

const button="rounded-lg border border-[#bcb0a2] bg-white px-3 py-2 text-xs disabled:opacity-50";
const field="w-full rounded-lg border border-[#cabfae] bg-white px-3 py-2 text-sm";
const validCard=(raw:unknown):raw is Card=>{
 if(!raw||typeof raw!=="object")return false;
 const x=raw as Record<string,unknown>;
 return typeof x.room_id==="string" && typeof x.public_title==="string" &&
 typeof x.public_about==="string" && x.public_title.length<=80 && x.public_about.length<=240;
};
const validListing=(raw:unknown):raw is Listing=>
 validCard(raw) && typeof (raw as Listing).listed==="boolean";
const validRequest=(raw:unknown):raw is Request=>{
 if(!raw||typeof raw!=="object")return false;
 const x=raw as Record<string,unknown>;
 return typeof x.room_id==="string" && typeof x.requested_at==="string" &&
 ["pending","approved","rejected","withdrawn"].includes(String(x.status));
};
const validApplicant=(raw:unknown):raw is Applicant=>{
 if(!raw||typeof raw!=="object")return false;
 const x=raw as Record<string,unknown>;
 return typeof x.room_id==="string" && typeof x.requester_id==="string" &&
 typeof x.requested_at==="string";
};
const validBlock=(raw:unknown):raw is Block=>
 !!raw&&typeof raw==="object"&&typeof (raw as Block).blocked_id==="string";
const requestLabel:Record<Request["status"],string>={
 pending:"等待房主审核",approved:"已获批准",rejected:"已拒绝或失效",withdrawn:"已撤回",
};

export function V2Discovery({client,userId,rooms,onRoomsChanged}:{
 client:SupabaseClient;userId:string;rooms:Room[];onRoomsChanged:()=>void;
}){
 const [found,setFound]=useState<Card[]>([]);
 const [listings,setListings]=useState<Listing[]>([]);
 const [requests,setRequests]=useState<Request[]>([]);
 const [inbox,setInbox]=useState<Applicant[]>([]);
 const [blocks,setBlocks]=useState<Block[]>([]);
 const [drafts,setDrafts]=useState<Record<string,Draft>>({});
 const [search,setSearch]=useState("");
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [notice,setNotice]=useState("");
 const [reportTarget,setReportTarget]=useState<string|null>(null);
 const [reportReason,setReportReason]=useState("spam");
 const [reportDetails,setReportDetails]=useState("");
 const [confirmBlock,setConfirmBlock]=useState<string|null>(null);
 const [confirmApplicant,setConfirmApplicant]=useState<string|null>(null);
 const epochRef=useRef(0);

 const refresh=useCallback(async (query="")=>{
  const epoch=++epochRef.current;
  setLoading(true);
  try{
   const [directory,myListings,mine,applications,blocked]=await Promise.all([
    client.rpc("v2_discover_reading_rooms",{query_text:query,page_limit:12}),
    client.rpc("v2_my_room_listings"),
    client.rpc("v2_my_discovery_requests"),
    client.rpc("v2_discovery_inbox"),
    client.rpc("v2_my_discovery_blocks"),
   ]);
   if(epoch!==epochRef.current)return;
   if([directory,myListings,mine,applications,blocked].some(r=>r.error)){
    setNotice("发现及审核数据暂不可用：请先安装第 11 模块的隔离测试迁移。");
    setFound([]);setListings([]);setRequests([]);setInbox([]);setBlocks([]);
    return;
   }
   setFound((Array.isArray(directory.data)?directory.data:[]).filter(validCard));
   const rows:Listing[]=(Array.isArray(myListings.data)?myListings.data:[]).filter(validListing);
   setListings(rows);
   setRequests((Array.isArray(mine.data)?mine.data:[]).filter(validRequest));
   setInbox((Array.isArray(applications.data)?applications.data:[]).filter(validApplicant));
   setBlocks((Array.isArray(blocked.data)?blocked.data:[]).filter(validBlock));
   setDrafts(existing=>{
    const next={...existing};
    for(const row of rows)if(!next[row.room_id])
      next[row.room_id]={title:row.public_title,about:row.public_about};
    return next;
   });
  }catch{
   if(epoch===epochRef.current)setNotice("无法连接发现服务，请检查网络或稍后重试。");
  }finally{
   if(epoch===epochRef.current)setLoading(false);
  }
 },[client]);

 useEffect(()=>{
  const epochCounter=epochRef;
  const handle=window.setTimeout(()=>{void refresh();},0);
  return ()=>{window.clearTimeout(handle);epochCounter.current++;};
 },[refresh,userId]);

 const action=async(run:()=>PromiseLike<{data:unknown;error:unknown}>,success:string,after=false)=>{
  if(busy)return false;
  setBusy(true);
  try{
   const {data,error}=await run();
   if(error){setNotice("操作未完成，请检查账号权限、书房状态及网络。");return false;}
   if(data===false||data==="unavailable"||data==="denied"||data==="rate_limited"){
    setNotice(data==="rate_limited"?"操作过于频繁，请明天再试。":"没有完成操作：可能已失效、无权限或书房已经满员。");
    return false;
   }
   setNotice(data==="already_requested"?"已经申请过，请等待房主处理。":success);
   await refresh(search.trim());
   if(after)onRoomsChanged();
   return true;
  }catch{setNotice("网络异常，结果尚未确认，请刷新查看后再决定是否重试。");return false;}
  finally{setBusy(false);}
 };

 const owners=rooms.filter(r=>r.owner_id===userId&&r.state==="active");
 const drafted=(id:string)=>drafts[id]??{title:"",about:""};
 const updateDraft=(id:string,part:Partial<Draft>)=>
  setDrafts(old=>({...old,[id]:{...(old[id]??{title:"",about:""}),...part}}));

 const publish=(event:FormEvent<HTMLFormElement>,id:string,enable:boolean)=>{
  event.preventDefault();
  const draft=drafted(id);
  if(enable&&(!draft.title.trim()||draft.title.trim().length>80||draft.about.length>240))return;
  void action(()=>client.rpc("v2_set_room_listing",{
   target_room:id,title:draft.title.trim(),about:draft.about.trim(),enabled:enable,
  }),enable?"已主动公开该书房的招募卡片。":"已撤下卡片，等待中的公开申请将失效。");
 };

 return (
  <section className="rounded-2xl border border-[#d9d0c1] bg-white/80 p-5" aria-label="书房发现与安全管理">
   <div className="flex flex-wrap items-center justify-between gap-2">
    <div>
     <h2 className="font-serif text-xl">寻找共读书房</h2>
     <p className="mt-1 text-xs leading-6 text-[#817668]">
      默认不公开；只有房主自愿发布的招募卡片可以被搜索。申请仍需房主审核，不会公开书籍正文、私人笔记、邮箱或邀请码。
     </p>
    </div>
    <button type="button" className={button} disabled={busy||loading}
      onClick={()=>{void refresh(search.trim());}}>{loading?"加载中…":"刷新发现与申请"}</button>
   </div>
   <form className="mt-4 flex flex-wrap gap-2"
     onSubmit={e=>{e.preventDefault();void refresh(search.trim());}}>
    <input aria-label="搜索公开招募" className={field+" max-w-sm"} maxLength={64}
      placeholder="搜索公开书房名称或简介" value={search}
      onChange={e=>setSearch(e.target.value)} />
    <button type="submit" className={button} disabled={busy||loading}>搜索</button>
   </form>
   <div className="mt-3 grid gap-3 md:grid-cols-2">
    {found.length===0&&<p className="text-sm text-[#817668]">暂时没有符合条件的公开书房。</p>}
    {found.map(card=>(
     <article key={card.room_id} className="rounded-xl border border-[#e2d9cb] bg-[#faf8f4] p-3">
      <h3 className="font-medium">{card.public_title}</h3>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{card.public_about||"房主尚未填写公开简介。"}</p>
      <p className="mt-1 text-xs text-[#817668]">仅公开招募信息 · 至多两名成员</p>
      <div className="mt-3 flex flex-wrap gap-2">
       <button className={button} type="button" disabled={busy}
        onClick={()=>{void action(()=>client.rpc("v2_request_discovered_room",{target_room:card.room_id}),
          "申请已发出，请等待房主批准。");}}>申请加入</button>
       <button className={button} type="button" disabled={busy}
        onClick={()=>{setReportTarget(reportTarget===card.room_id?null:card.room_id);
          setConfirmBlock(null);}}>举报</button>
       {confirmBlock===card.room_id?(
        <>
         <button className={button} type="button" disabled={busy}
          onClick={()=>{setConfirmBlock(null);
           void action(()=>client.rpc("v2_block_discovery_room",{target_room:card.room_id}),
           "已屏蔽该房主的公开书房及后续邀请。");}}>确认屏蔽</button>
         <button className={button} type="button" onClick={()=>setConfirmBlock(null)}>取消</button>
        </>
       ):<button className={button} type="button" disabled={busy}
          onClick={()=>{setConfirmBlock(card.room_id);setReportTarget(null);}}>屏蔽房主</button>}
      </div>
      {reportTarget===card.room_id&&(
       <form className="mt-3 space-y-2 rounded-lg border border-[#d3c8b9] p-2"
        onSubmit={e=>{
         e.preventDefault();
         if(reportDetails.trim().length<10)return;
         void (async()=>{
          const acknowledged=await action(()=>client.rpc("v2_report_discovery_room",{
           target_room:card.room_id,category:reportReason,note:reportDetails.trim(),
          }),"举报已进入私密待审核队列，不会自动公开或直接处罚。");
          if(acknowledged){setReportTarget(null);setReportDetails("");}
         })();
        }}>
        <label className="block text-xs">问题类型
         <select className={field+" mt-1"} value={reportReason}
           onChange={e=>setReportReason(e.target.value)}>
          <option value="spam">垃圾招募</option>
          <option value="harassment">骚扰</option>
          <option value="privacy">隐私泄露</option>
          <option value="copyright">版权问题</option>
          <option value="other">其他</option>
         </select>
        </label>
        <label className="block text-xs">说明（10–500 字，不要粘贴私人书籍正文）
         <textarea className={field+" mt-1"} required minLength={10} maxLength={500}
          value={reportDetails} onChange={e=>setReportDetails(e.target.value)}/>
        </label>
        <button type="submit" className={button} disabled={busy||reportDetails.trim().length<10}>提交私密举报</button>
       </form>
      )}
     </article>
    ))}
   </div>
   <div className="mt-5 border-t border-[#e4d8ca] pt-4">
    <h3 className="font-medium">我的公开申请</h3>
    {requests.length===0&&<p className="mt-2 text-sm text-[#817668]">还没有通过书房发现发起的申请。</p>}
    {requests.map(req=>(
     <div key={req.room_id} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="mr-auto">书房 {req.room_id.slice(0,8)}… · {requestLabel[req.status]}</span>
      {req.status==="pending"&&<button type="button" className={button} disabled={busy}
       onClick={()=>{void action(()=>client.rpc("v2_withdraw_discovery_request",{target_room:req.room_id}),
        "申请已撤回。");}}>撤回</button>}
    </div>
    ))}
   </div>
   <div className="mt-5 border-t border-[#e4d8ca] pt-4">
    <h3 className="font-medium">我的书房招募（默认私密）</h3>
    {owners.length===0&&<p className="mt-2 text-sm text-[#817668]">创建自己的双人书房后才可以选择公开招募。</p>}
    {owners.map(room=>{
     const current=listings.find(x=>x.room_id===room.id);
     const draft=drafted(room.id);
     return (
      <form key={room.id} className="mt-3 space-y-2 rounded-xl border border-[#e2d9cb] p-3"
        onSubmit={e=>publish(e,room.id,true)}>
       <p className="text-sm font-medium">私密书房：{room.id.slice(0,8)}…</p>
       <p className="text-xs text-[#817668]">{current?.listed?"公开招募已开启":"不在公开目录中"}；公开文案与私密书籍标题相互独立。</p>
       <label className="block text-xs">公开招募标题
        <input className={field+" mt-1"} required maxLength={80}
         value={draft.title} placeholder="例如：寻找一起读经典文学的伙伴"
         onChange={e=>updateDraft(room.id,{title:e.target.value})}/>
       </label>
       <label className="block text-xs">公开招募简介（不写书籍正文）
        <textarea className={field+" mt-1"} maxLength={240} value={draft.about}
         onChange={e=>updateDraft(room.id,{about:e.target.value})}/>
       </label>
       <button type="submit" className={button} disabled={busy}>发布或更新招募</button>
       {current?.listed&&<button type="button" className={button} disabled={busy}
        onClick={()=>{void action(()=>client.rpc("v2_set_room_listing",{
         target_room:room.id,title:"",about:"",enabled:false,
        }),"已下架招募卡片，相关待审核申请已失效。");}}>撤下公开招募</button>}
       {inbox.filter(req=>req.room_id===room.id).map(req=>(
        <div key={req.requester_id} className="flex flex-wrap items-center gap-2 border-t border-[#eee3d7] pt-2">
         <span className="mr-auto text-xs">申请人编号 {req.requester_id.slice(0,8)}…（不显示邮箱）</span>
         <button type="button" className={button} disabled={busy}
          onClick={()=>{void action(()=>client.rpc("v2_review_discovery_request",{
            target_room:room.id,requester:req.requester_id,approve:true,
          }),"已批准加入，书房已退出公开发现。",true);}}>同意</button>
         <button type="button" className={button} disabled={busy}
          onClick={()=>{void action(()=>client.rpc("v2_review_discovery_request",{
            target_room:room.id,requester:req.requester_id,approve:false,
          }),"已拒绝申请。");}}>拒绝</button>
         {confirmApplicant===req.requester_id?
          <button className={button} type="button" disabled={busy}
           onClick={()=>{setConfirmApplicant(null);
            void action(()=>client.rpc("v2_block_discovery_applicant",{
             target_room:room.id,requester:req.requester_id,
            }),"已屏蔽该申请人。");}}>确认屏蔽</button>:
          <button className={button} type="button" disabled={busy}
           onClick={()=>setConfirmApplicant(req.requester_id)}>屏蔽</button>}
        </div>
       ))}
      </form>
     );
    })}
   </div>
   <div className="mt-5 border-t border-[#e4d8ca] pt-4">
    <h3 className="font-medium">屏蔽名单（仅自己可见）</h3>
    {blocks.length===0&&<p className="mt-2 text-xs text-[#817668]">尚未屏蔽其他用户。</p>}
    {blocks.map(item=>(
     <div key={item.blocked_id} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="mr-auto">用户 {item.blocked_id.slice(0,8)}…</span>
      <button type="button" className={button} disabled={busy}
       onClick={()=>{void action(()=>client.rpc("v2_unblock_discovery_user",{
        target_user:item.blocked_id,
       }),"已解除屏蔽；不会自动批准过去的加入申请。");}}>解除屏蔽</button>
     </div>
    ))}
   </div>
   {notice&&<p role="status" className="mt-4 text-xs text-[#76563a]">{notice}</p>}
   <p className="mt-3 text-xs leading-5 text-[#817668]">
    举报只进入待人工审核队列；正式启用陌生人发现之前，还必须完成独立滥用审核、申诉与跨账号限流，以及真实双账号测试。
   </p>
  </section>
 );
}
