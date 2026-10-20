/* No-login UI demo: real Chromium DevTools, precise touch/viewport emulation.
 * No login, no network/backend, no credentials.
 * Desktop headless --window-size silently clamps 390px to 500px; CDP avoids it.
 * This is still Chromium emulation, NOT a real iPhone/Android/Safari test.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {spawn,spawnSync} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";

const out=path.resolve("out");
if(!fs.existsSync(path.join(out,"v2","demo","index.html")))
 throw Error("Static V2 demo export missing");
const chrome=["google-chrome","google-chrome-stable","chromium","chromium-browser"]
 .find(name=>spawnSync("which",[name],{encoding:"utf8"}).status===0);
if(!chrome)throw Error("Chromium is required for CDP browser test");

const server=http.createServer((req,res)=>{
 let pathname;
 try{pathname=decodeURIComponent(new URL(req.url,"http://localhost").pathname);}
 catch{res.writeHead(400).end("Bad path");return;}
 if(!pathname.startsWith("/my-reading-app/")){
  res.writeHead(404).end("Not a project site");return;
 }
 const sub=pathname.slice("/my-reading-app".length);
 const file=path.resolve(out,"."+ (sub.endsWith("/")?sub+"index.html":sub));
 if(!file.startsWith(out+path.sep)){
  res.writeHead(403).end("Denied");return;
 }
 fs.readFile(file,(error,bytes)=>{
  if(error){res.writeHead(404).end("Missing");return;}
  const ext=path.extname(file);
  const type=ext===".html"?"text/html; charset=utf-8":
   ext===".js"?"text/javascript; charset=utf-8":
   ext===".css"?"text/css; charset=utf-8":
   ext===".svg"?"image/svg+xml":"application/octet-stream";
  res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"});
  res.end(bytes);
 });
});
const launch=(binary)=>{
 const userData=fs.mkdtempSync(path.join(os.tmpdir(),"v2-cdp-"));
 const child=spawn(binary,[
  "--headless=new","--remote-debugging-port=0",
  "--user-data-dir="+userData,"--no-sandbox","--disable-gpu",
  "--disable-dev-shm-usage","--disable-extensions",
  "--disable-background-networking","--no-first-run","about:blank",
 ],{stdio:["ignore","ignore","pipe"]});
 let log="";
 const endpoint=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error("Chromium debugging endpoint timed out")),20000);
  child.stderr.on("data",buf=>{
   if(log.length<6000)log+=buf.toString();
   const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
   if(match){clearTimeout(timeout);resolve(match[1]);}
  });
  child.on("error",e=>{clearTimeout(timeout);reject(e);});
  child.on("exit",code=>{
   clearTimeout(timeout);reject(Error("Chromium closed before debugging: "+code));
  });
 });
 return {child,userData,endpoint};
};
function openProtocol(endpoint){
 return new Promise((resolve,reject)=>{
  const socket=new WebSocket(endpoint);
  const pending=new Map();
  let serial=0;
  socket.addEventListener("open",()=>{
   const send=(method,params={},sessionId)=>new Promise((yes,no)=>{
    const id=++serial;
    const timeout=setTimeout(()=>{
     pending.delete(id);no(Error("CDP command timeout: "+method));
    },15000);
    pending.set(id,{yes,no,timeout});
    socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
   });
   socket.addEventListener("message",evt=>{
    let msg;
    try{msg=JSON.parse(evt.data);}catch{return;}
    if(!msg.id||!pending.has(msg.id))return;
    const job=pending.get(msg.id);
    pending.delete(msg.id);clearTimeout(job.timeout);
    if(msg.error)job.no(Error(msg.error.message??"CDP protocol error"));
    else job.yes(msg.result??{});
   });
   resolve({send,close:()=>socket.close()});
  });
  socket.addEventListener("error",()=>reject(Error("Could not connect to local Chromium")));
 });
}
async function inspectDemo(send,url,width,height,mobile){
 const {targetId}=await send("Target.createTarget",{url:"about:blank"});
 try{
  const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true});
  await send("Page.enable",{},sessionId);
  await send("Runtime.enable",{},sessionId);
  await send("Emulation.setDeviceMetricsOverride",{
   width,height,deviceScaleFactor:mobile?3:1,mobile,
  },sessionId);
  await send("Emulation.setTouchEmulationEnabled",{
   enabled:mobile,maxTouchPoints:mobile?5:1,
  },sessionId);
  await send("Page.navigate",{url},sessionId);
  async function evaluate(expression){
   const {result,exceptionDetails}=await send("Runtime.evaluate",{
    returnByValue:true,expression,
   },sessionId);
   if(exceptionDetails)throw Error("Demo page JS evaluation exception");
   return result?.value;
  }
  async function waitFor(expression,label){
   for(let n=0;n<90;n++){
    const result=await evaluate(expression);
    if(result)return result;
    await delay(200);
   }
   throw Error("Demo interaction timed out: "+label);
  }
  await waitFor("!!document.querySelector('.demo-book-grid .demo-book-card')","library cards");
  const before=await evaluate(`(()=>{
   const shell=document.querySelector('.demo-outer');
   return {
    width:innerWidth,
    overflow:document.documentElement.scrollWidth>innerWidth+4||
       (shell&&shell.scrollWidth>shell.clientWidth+4),
    books:document.querySelectorAll('.demo-book-card').length,
    noAuth:!document.querySelector('input[type=password]'),
    noNetwork:!performance.getEntriesByType('resource').some(r=>r.name.includes('.supabase.co/')),
   };
  })()`);
  if(before.width!==width||before.overflow||before.books!==3||!before.noAuth||!before.noNetwork)
   throw Error("Unsafe or broken no-login library: "+JSON.stringify(before));

  await evaluate("document.querySelector('.demo-book-card')?.click();true");
  await waitFor("document.querySelector('.demo-chapter-name')?.textContent==='雨落下来'","open book");
  await evaluate("document.querySelector('.demo-page-navigation button:last-child')?.click();true");
  await waitFor("document.querySelector('.demo-chapter-name')?.textContent==='旧书房'","turn page");
  await evaluate("document.querySelector('.demo-quoted-mark')?.click();true");
  await waitFor("!!document.querySelector('.demo-note-selected')","show linked note");
  await evaluate("Array.from(document.querySelectorAll('.demo-menu-item')).find(el=>el.textContent.includes('阅读设置'))?.click();true");
  await waitFor("!!document.querySelector('.demo-settings-panel')","settings tab");
  await evaluate("document.querySelector('.demo-option-pair button:last-child')?.click();true");
  await waitFor("!!document.querySelector('.demo-app.demo-night')","night mode toggle");
  await evaluate("document.querySelector('.demo-return-to-book')?.click();true");
  await waitFor("!!document.querySelector('.demo-paper-page')","return to reader");
  await evaluate("document.querySelector('button[title*=书签]')?.click();true");
  await waitFor("!!document.querySelector('.demo-icon-selected')","bookmark switch");
  const after=await evaluate(`(()=>{
   const shell=document.querySelector('.demo-outer');
   return {
    width:innerWidth,
    overflow:document.documentElement.scrollWidth>innerWidth+4||
      (shell&&shell.scrollWidth>shell.clientWidth+4),
    night:!!document.querySelector('.demo-app.demo-night'),
    bookmark:!!document.querySelector('.demo-icon-selected'),
    noAuth:!document.querySelector('input[type=password]'),
    noNetwork:!performance.getEntriesByType('resource').some(r=>r.name.includes('.supabase.co/')),
   };
  })()`);
  if(after.width!==width||after.overflow||!after.night||!after.bookmark||!after.noAuth||!after.noNetwork)
   throw Error("Demo interaction check failed: "+JSON.stringify(after));
  console.log("PASS: no-login book open, page turn, partner note, night theme and bookmark",JSON.stringify({
   viewport:width+"x"+height,touch:mobile,network:false,
  }));
 }finally{await send("Target.closeTarget",{targetId}).catch(()=>{});}
}
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser,protocol;
try{
 const addr=server.address();
 if(!addr||typeof addr==="string")throw Error("No local server address");
 const url="http://127.0.0.1:"+addr.port+"/my-reading-app/v2/demo/";
 browser=launch(chrome);
 protocol=await openProtocol(await browser.endpoint);
 await inspectDemo(protocol.send,url,390,844,true);
 await inspectDemo(protocol.send,url,1280,900,false);
}finally{
 protocol?.close();
 browser?.child.kill();
 if(browser?.userData){
  try{
   fs.rmSync(browser.userData,{recursive:true,force:true,maxRetries:8,retryDelay:120});
  }catch{
   // Chromium can still write into its disposable profile during shutdown.
   // The ephemeral CI runner cleans its temporary directory at job exit.
   console.warn("Deferred ephemeral Chromium profile cleanup after browser exit");
  }
 }
 server.close();
}
