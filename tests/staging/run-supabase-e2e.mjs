#!/usr/bin/env node
/* Module 14: opt-in REAL staging smoke test (never used against production).
 * Needs three operator-created, email-confirmed throwaway Auth users.
 * Uses publishable client key only. No service_role, browser secrets, or
 * public access; deliberately no automatic account creation.
 * A passing PostgreSQL fake-role test is NOT a substitute for this test.
 */
import {createClient} from "@supabase/supabase-js";
import {setTimeout as delay} from "node:timers/promises";

const productionProject="warhfmpfnlgzofbeuikb";
const must=(condition,message)=>{if(!condition)throw Error(message);};
const url=process.env.V2_STAGING_URL;
const project=process.env.V2_STAGING_PROJECT_REF;
const key=process.env.V2_STAGING_PUBLISHABLE_KEY;
const credentials=[
 ["owner",process.env.V2_STAGING_OWNER_EMAIL,process.env.V2_STAGING_OWNER_PASSWORD],
 ["partner",process.env.V2_STAGING_PARTNER_EMAIL,process.env.V2_STAGING_PARTNER_PASSWORD],
 ["outsider",process.env.V2_STAGING_OUTSIDER_EMAIL,process.env.V2_STAGING_OUTSIDER_PASSWORD],
];
const safeHost=/^[a-z0-9]{20}\.supabase\.co$/;
let target;
try{target=new URL(url??"");}catch{throw Error("Set a dedicated staging URL");}
must(process.env.V2_ALLOW_MUTATING_STAGING_TEST==="I_CONFIRM_ISOLATED_STAGING_ONLY",
 "No mutation without explicit isolated-staging opt-in");
must(target.protocol==="https:"&&safeHost.test(target.hostname)&&
 target.pathname==="/"&&!target.username&&!target.password&&!target.search&&!target.hash,
 "Staging URL must be a bare HTTPS Supabase project root");
must(project&&project===target.hostname.split(".")[0]&&
 project!==productionProject,"Dedicated project ref mismatch or production project blocked");
must(key&&key.trim().length>15&&!key.startsWith("sb_secret_"),
 "Only a staging publishable/anon key is accepted");
if(key.split(".").length===3){
 try{
  const payload=JSON.parse(Buffer.from(key.split(".")[1],"base64url").toString("utf8"));
  must(payload.role!=="service_role"&&payload.role!=="supabase_admin",
   "Never use an administrator key in this test");
 }catch(error){throw Error("Unsafe or malformed staging JWT key", {cause:error});}
}
must(credentials.every(([name,email,password])=>name&&email&&password&&
 email.includes("@")&&password.length>=12),"Three precreated test accounts required");
must(new Set(credentials.map(x=>x[1])).size===3,"All accounts must be distinct");
const opts={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const clients=credentials.map(()=>createClient(target.origin,key,opts));
const rpc=async(c,method,args)=>{
 const {data,error}=await c.rpc(method,args);
 if(error)throw Error(method+" failed ("+(error.code??"unknown")+")");
 return data;
};
const expectRows=async(c,table,room,limit=10)=>{
 const result=await c.from(table).select("*").eq("room_id",room).limit(limit);
 if(result.error)throw Error(table+" SELECT failed ("+result.error.code+")");
 return result.data??[];
};
const makeEvent=async(c,room,author,body,visibility,chunkIndex=0)=>{
 const {data,error}=await c.from("reading_highlights_v2").insert({
  room_id:room,chunk_index:chunkIndex,author_id:author,start_index:0,end_index:3,
  body,visibility,
 }).select("id").single();
 if(error||!data?.id)throw Error("test highlight insert denied");
 return data.id;
};
const sessions=[];
let room=null;
let checkpoint="START";
let realtimeChannel;
const originalConsoleError=console.error; // Logs must never expose secrets.
try{
 for(let i=0;i<clients.length;i++){
  checkpoint="AUTH_"+credentials[i][0];
  const {data,error}=await clients[i].auth.signInWithPassword({
   email:credentials[i][1],password:credentials[i][2],
  });
  if(error||!data.user?.email_confirmed_at||!data.session?.access_token)
   throw Error("Missing/invalid confirmed throwaway staging login: "+credentials[i][0]);
  sessions.push(data.user.id);
 }
 must(new Set(sessions).size===3,"Staging Auth identities unexpectedly identical");
 const [owner,partner,outsider]=clients;
 checkpoint="PREFLIGHT_SCHEMA";
 // Guard against mutating a partially migrated staging project. Check module
 // 12 and 13 features before creating the disposable test room.
 for(const [actor,fn,args] of [
  [owner,"v2_my_room_history",{}],
  [owner,"v2_my_report_receipts",{}],
  [outsider,"v2_discover_reading_rooms",{query_text:"",page_limit:1}],
 ]){
  const {error}=await actor.rpc(fn,args);
  must(!error,"Missing required V2 migration or RPC: "+fn);
 }
 checkpoint="CREATE_ROOM";
 room=await rpc(owner,"v2_create_reading_room",{
  book_title:"STAGING E2E disposable "+Date.now(),
 });
 must(typeof room==="string"&&room.length>=32,"Room was not created");
 console.log("staging test room:",room);

 checkpoint="PRE_JOIN_RLS";
 must((await rpc(partner,"v2_read_book_chunks",{
  target_room:room,from_index:0,requested_count:1,
 })).length===0,"Partner saw unapproved room content");
 must((await rpc(outsider,"v2_room_roster",{target_room:room})).length===0,
  "Outsider saw protected roster");
 const direct=await outsider.from("reading_chunks_v2").select("body").eq("room_id",room);
 must(Boolean(direct.error)||direct.data?.length===0,
  "Outsider obtained private raw book content");
 const rawAudit=await outsider.from("reading_audit_v2").select("event_hash").eq("room_id",room);
 must(Boolean(rawAudit.error),"Outsider received raw audit table privilege");

 checkpoint="INVITE_AND_APPROVAL";
 const invite=await rpc(owner,"v2_create_room_invite",{target_room:room});
 must(typeof invite==="string"&&invite.length===6,"Invite creation failed");
 must((await rpc(partner,"v2_request_room_join",{invite_code:invite}))==="submitted",
  "Partner cannot request");
 must((await rpc(partner,"v2_read_book_chunks",{
  target_room:room,from_index:0,requested_count:1,
 })).length===0,"Applicant got book before approval");
 must(await rpc(owner,"v2_review_room_join",{
  target_room:room,requester:sessions[1],approve:true,
 })===true,"Owner approval failed");
 const roster=await rpc(partner,"v2_room_roster",{target_room:room});
 must(roster.length===2,"Room did not reach exactly two members");
 must((await rpc(outsider,"v2_room_roster",{target_room:room})).length===0,
  "Unauthorized roster leaked");

 checkpoint="COPYRIGHT_AND_UPLOAD";
 const unauthorized=await owner.rpc("v2_upload_book_chunk",{
  target_room:room,target_index:0,chunk_text:"Test book content only",
 });
 must(Boolean(unauthorized.error)||unauthorized.data===false,
  "Server permitted upload without a copyright declaration");
 must(await rpc(owner,"v2_confirm_book_rights",{
  target_room:room,rights_basis:"original",
 })===true,"Rights declaration failed");
 must(await rpc(owner,"v2_upload_book_chunk",{
  target_room:room,target_index:0,chunk_text:"Test book content only",
 })===true,"Rights-approved upload failed");
 must(await rpc(owner,"v2_upload_book_chunk",{
  target_room:room,target_index:1,chunk_text:"Future staging chapter - never a real copyrighted book",
 })===true,"Could not upload test future chapter");
 must((await rpc(partner,"v2_read_book_chunks",{
  target_room:room,from_index:0,requested_count:1,
 })).length===1,"Approved partner could not read protected content");
 must((await rpc(outsider,"v2_read_book_chunks",{
  target_room:room,from_index:0,requested_count:1,
 })).length===0,"Outsider read protected text");

 checkpoint="SPOILER_AND_REALTIME";
 const pre=await rpc(partner,"v2_can_see_shared_chunk",{
  target_room:room,target_chunk:0,
 });
 must(pre===false,"Partner saw shared note before page acknowledgement");
 await makeEvent(owner,room,sessions[0],"private test note","private");
 await makeEvent(owner,room,sessions[0],"future chapter spoiler","shared",1);
 must((await expectRows(partner,"reading_highlights_v2",room)).length===0,
  "Partner saw owner's private note");
 must((await rpc(partner,"v2_acknowledge_read_chunk",{
  target_room:room,target_chunk:0,
 }))===true,"Explicit page acknowledgement failed");
 must((await expectRows(partner,"reading_highlights_v2",room)).length===0,
  "Acknowledging first page leaked future shared chapter notes");

 let eventReceived=false;
 realtimeChannel=partner.channel("test-v2-e2e-"+room)
 .on("postgres_changes",{
  event:"*",schema:"public",table:"reading_shared_signal_v2",
  filter:"room_id=eq."+room,
 },()=>{eventReceived=true;});
 const subscribed=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error("Realtime subscription timed out")),15000);
  realtimeChannel.subscribe(status=>{
   if(status==="SUBSCRIBED"){clearTimeout(timer);resolve();}
   if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"){
    clearTimeout(timer);reject(Error("Realtime channel subscription failed"));
   }
  });
 });
 await subscribed;
 await makeEvent(owner,room,sessions[0],"shared test note","shared");
 const shared=await expectRows(partner,"reading_highlights_v2",room);
 must(shared.length===1&&shared[0].body==="shared test note",
  "Partner could not read authorized shared note or got private/future note");
 for(let i=0;i<12&&!eventReceived;i++)await delay(500);
 must(eventReceived,"Actual Supabase Realtime shared event never arrived");
 must(await rpc(partner,"v2_acknowledge_read_chunk",{
  target_room:room,target_chunk:1,
 })===true,"Partner cannot explicitly open next chapter");
 const unlocked=await expectRows(partner,"reading_highlights_v2",room);
 must(unlocked.length===2&&unlocked.some(item=>item.body==="future chapter spoiler")&&
  !unlocked.some(item=>item.visibility==="private"),
  "New chapter did not unlock its own notes or exposed private material");

 checkpoint="POST_LEAVE_RLS";
 must(await rpc(partner,"v2_leave_reading_room",{target_room:room})===true,
  "Partner cannot exit");
 must((await rpc(partner,"v2_read_book_chunks",{
  target_room:room,from_index:0,requested_count:1,
 })).length===0,"Departed member retained book reading access");
 must((await expectRows(partner,"reading_highlights_v2",room)).length===0,
  "Departed member retained shared annotation access");
 must((await rpc(partner,"v2_verify_room_audit",{target_room:room}))?.valid===true,
  "Historical audit verification unavailable to departed member");
 eventReceived=false;
 await makeEvent(owner,room,sessions[0],"After partner departed","shared");
 for(let i=0;i<8;i++)await delay(500);
 must(!eventReceived,"Former member's live subscription still received protected updates");

 checkpoint="CONSENTED_CLEANUP";
 must(await rpc(owner,"v2_change_room_state",{
  target_room:room,target_state:"closed",
 })===true,"Cleanup close failed");
 must(await rpc(owner,"v2_consent_room_purge",{target_room:room})==="consented",
  "Owner cleanup consent failed");
 must(await rpc(partner,"v2_consent_room_purge",{target_room:room})==="consented",
  "Partner cleanup consent failed");
 must(await rpc(owner,"v2_purge_closed_room",{target_room:room})==="purged",
  "Explicitly consented test room cleanup failed");
 room=null;
 console.log("PASS: real 3-user staging Auth/RLS, invite, rights, spoiler, Realtime, departure and cleanup");
} catch(error){
 console.error("FAIL at test checkpoint:",checkpoint);
 console.error("test failure:",error?.message??"unknown");
 if(room){
  // Only touch a room this run created. Never delete pre-existing staging data.
  // A failure always stays a failed test, even if cleanup succeeds.
  console.error("Attempting consent-gated cleanup of disposable room:",room);
  try {
   const [owner,partner]=clients;
   // The applicant is authenticated before room creation but may never have
   // been approved if the test failed early. Only actual members must consent.
   const rosterCheck=await owner.rpc("v2_room_roster",{target_room:room});
   const partnerWasMember=!rosterCheck.error&&
     Array.isArray(rosterCheck.data)&&
     rosterCheck.data.some(entry=>entry.user_id===sessions[1]);
   const close=await owner.rpc("v2_change_room_state",{
    target_room:room,target_state:"closed",
   });
   if(close.error||close.data!==true)throw Error("owner close not confirmed");
   const first=await owner.rpc("v2_consent_room_purge",{target_room:room});
   if(first.error||first.data!=="consented")throw Error("owner consent not confirmed");
   if(partnerWasMember){
    const second=await partner.rpc("v2_consent_room_purge",{target_room:room});
    if(second.error||second.data!=="consented")throw Error("partner consent not confirmed");
   }
   const wiped=await owner.rpc("v2_purge_closed_room",{target_room:room});
   if(wiped.error||wiped.data!=="purged")throw Error("safe purge not confirmed");
   console.error("Disposable staging room cleanup confirmed.");
   room=null;
  }catch{
   console.error("Cleanup incomplete: an authorized staging operator must examine this test room:",room);
  }
 }
 process.exitCode=1;
}finally{
 if(realtimeChannel)await clients[1].removeChannel(realtimeChannel).catch(()=>{});
 for(const client of clients)await client.auth.signOut().catch(()=>{});
 console.error=originalConsoleError;
}
