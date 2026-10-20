"use client";
import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
 personalExportSections,validPersonalExportPage,
 type PersonalExportSection,
} from "@/lib/v2/personalExportSchema";

export function V2PersonalExport({client,roomId}:{
 client:SupabaseClient;roomId:string;
}){
 const [section,setSection]=useState<PersonalExportSection>("info");
 const [offset,setOffset]=useState(0);
 const [payload,setPayload]=useState("");
 const [count,setCount]=useState(0);
 const [loading,setLoading]=useState(false);
 const [notice,setNotice]=useState("");
 async function load(target:PersonalExportSection,position:number){
  if(loading)return;
  setLoading(true);setPayload("");setCount(0);setNotice("");
  try{
   const {data,error}=await client.rpc("v2_export_my_room_section",{
    target_room:roomId,target_section:target,page_offset:position,
   });
   if(error||!validPersonalExportPage(data,target,roomId,position)){
    setNotice("这一页无法导出，可能是权限或网络异常。");return;
   }
   setSection(target);setOffset(position);setCount(data.items.length);
   setPayload(JSON.stringify(data,null,2));
   setNotice("已读取自己的资料，可选中文字复制到本地文件；未保存到浏览器缓存。");
  }catch{setNotice("读取失败，请刷新书房状态后再试。");}
  finally{setLoading(false);}
 }
 return <div className="mt-3 space-y-2 rounded-lg border border-[#d8ccbd] bg-white p-3">
  <p className="text-sm font-medium">按类别导出自己的数据</p>
  <p className="text-xs text-[#817668]">
   每次至多 50 条，仅属于你自己的记录；连续读取下一页即可备份全部。
   含私人文字及你上传的书籍内容，请勿公开转发。
  </p>
  <label className="block text-xs">资料类别
   <select className="ml-2 rounded-lg border border-[#bfb3a5] p-2"
     value={section} disabled={loading}
     onChange={e=>{
      const target=e.target.value as PersonalExportSection;
      setSection(target);setOffset(0);setPayload("");setCount(0);
     }}>
     {personalExportSections.map(name=>
      <option key={name} value={name}>{name}</option>)}
   </select>
  </label>
  <div className="flex gap-2">
   <button type="button" disabled={loading}
     className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50"
     onClick={()=>{void load(section,0);}}>读取第一页</button>
   <button type="button" disabled={loading||!payload||count!==50||offset>=20000}
     className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50"
     onClick={()=>{void load(section,offset+50);}}>下一页</button>
  </div>
  {payload&&<label className="block text-xs">此页 JSON（可手动复制）
   <textarea className="mt-1 h-44 w-full rounded-lg border border-[#c5b8a9] p-2 font-mono text-xs"
     readOnly value={payload} aria-label="私人导出 JSON 内容"/>
  </label>}
  {notice&&<p role="status" className="text-xs text-[#76563a]">{notice}</p>}
 </div>;
}
