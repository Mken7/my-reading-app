/* Module 14: real Chromium DevTools, precise touch/viewport emulation.
 * Uses ONLY a fake build-time publishable key, never real staging secrets.
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
if(!fs.existsSync(path.join(out,"v2","index.html")))
 throw Error("Static V2 export missing");
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
async function inspect(send,url,width,height,mobile){
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
  let last=null;
  for(let n=0;n<85;n++){
   await delay(200);
   const {result,exceptionDetails}=await send("Runtime.evaluate",{
    returnByValue:true,expression:`(()=>{
      const email=document.querySelector('input[type=email]');
      const password=document.querySelector('input[type=password]');
      const inputs=[...document.querySelectorAll('input')];
      const missingLabels=inputs.filter(el=>
        !el.closest('label')&&!el.getAttribute('aria-label')&&
        !el.getAttribute('aria-labelledby')).length;
      const tooSmall=[email,password].filter(el=>
        el&&el.getBoundingClientRect().height<43.5).length;
      return {
        ready:!!email&&!!password,
        width:innerWidth,
        overflow:document.documentElement.scrollWidth>innerWidth+4,
        missingLabels,tooSmall,
        touch:'ontouchstart' in window||navigator.maxTouchPoints>0,
        text:document.body?.innerText?.slice(-170)??'',
      };
    })()`,
   },sessionId);
   if(exceptionDetails)throw Error("Page script evaluation failed");
   last=result?.value??null;
   if(last?.ready)break;
  }
  if(!last?.ready)throw Error("Email/password never hydrated: "+JSON.stringify(last));
  if(last.width!==width)throw Error("Viewport was clamped: "+JSON.stringify(last));
  if(last.overflow||last.missingLabels>0||last.tooSmall>0)
   throw Error("Mobile overflow/input-label/touch target violation: "+JSON.stringify(last));
  if(mobile&&!last.touch)throw Error("Mobile touch emulation failed");
  console.log("PASS: hydrated opt-in fake staging login",JSON.stringify({
   viewport:width+"x"+height,touch:mobile,labels:true,overflow:false,
  }));
 }finally{await send("Target.closeTarget",{targetId}).catch(()=>{});}
}

async function inspectOfflineDemo(send,url,width,height,mobile){
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
  const evalPage=async(expression)=>{
   const res=await send("Runtime.evaluate",{
    expression,returnByValue:true,awaitPromise:true,
   },sessionId);
   if(res.exceptionDetails)throw Error("Demo browser evaluation failed: "+
     res.exceptionDetails.text);
   return res.result?.value;
  };
  const waitFor=async(expression,label)=>{
   for(let i=0;i<75;i++){
    if(await evalPage(expression))return;
    await delay(160);
   }
   throw Error("Demo did not reach "+label);
  };
  await send("Page.navigate",{url},sessionId);
  await waitFor("document.querySelector('.demo-app')?.dataset.demoReady==='yes'","hydrated bookshelf");
  // Run every device-width test from the same clean, deterministic local state.
  await evalPage("localStorage.removeItem('reading-v2-offline-ui-demo-1');true");
  await send("Page.reload",{ignoreCache:true},sessionId);
  await waitFor("document.querySelector('.demo-app')?.dataset.demoReady==='yes'&&document.querySelectorAll('.demo-book-card').length===3","clean bookshelf");
  const metrics=await evalPage("({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+4})");
  if(metrics.width!==width||metrics.overflow)
   throw Error("Demo layout overflow: "+JSON.stringify(metrics));
  await evalPage("document.querySelector('.demo-book-card').click();true");
  await waitFor("!!document.querySelector('.demo-prose')","reader");
  await evalPage("document.querySelector('.demo-reader-actions .demo-icon-action').click();true");
  await waitFor("!!document.querySelector('.demo-icon-selected')","bookmark toggle");
  await evalPage("(()=>{const target=document.querySelector('.demo-prose p');const node=target.firstChild;const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(9,node.textContent.length));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);target.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true;})()");
  await waitFor("!!document.querySelector('.demo-selection-toolbar')","selection UI");
  await evalPage("document.querySelector('.demo-selection-toolbar button').click();true");
  await waitFor("!!document.querySelector('.demo-notice')","local highlight");
  await evalPage("(()=>{const el=document.querySelector('#demo-new-note');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,'本地测试批注，可刷新保存');el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'本地测试批注'}));return true;})()");
  await waitFor("!document.querySelector('.demo-note-compose button').disabled","note editor");
  await evalPage("document.querySelector('.demo-note-compose').requestSubmit();true");
  await waitFor("document.body.innerText.includes('本地测试批注，可刷新保存')","saved note");
  await evalPage("document.querySelector('.demo-back-button').click();true");
  await waitFor("!!document.querySelector('.demo-file-input')","import button");
  await evalPage("(()=>{const input=document.querySelector('.demo-file-input');const dt=new DataTransfer();dt.items.add(new File(['# 本地测试读物\\n\\n这是不用登录就能导入的自写文字。'],'本地测试读物.txt',{type:'text/plain'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
  await waitFor("document.querySelector('.demo-reader-back h1')?.textContent==='本地测试读物'","local TXT import");
  await delay(1000);
  await send("Page.reload",{ignoreCache:true},sessionId);
  await waitFor("document.querySelector('.demo-app')?.dataset.demoReady==='yes'&&document.querySelectorAll('.demo-book-card').length===4","reloaded imported shelf");
  await evalPage("(()=>{const card=[...document.querySelectorAll('.demo-book-card')].find(el=>el.textContent.includes('本地测试读物'));card.click();return true;})()");
  await waitFor("document.querySelector('.demo-reader-back h1')?.textContent==='本地测试读物'","reloaded imported book");
  await evalPage("document.querySelector('.demo-back-button').click();true");
  await evalPage("(()=>{const settings=[...document.querySelectorAll('.demo-menu-item')].find(x=>x.textContent.includes('阅读设置'));settings.click();return true;})()");
  await waitFor("!!document.querySelector('.demo-settings-panel')","local settings");
  await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-option-pair button')].find(x=>x.textContent.includes('夜间'));button.click();return true;})()");
  await waitFor("!!document.querySelector('.demo-night')","night mode");
  const local=await evalPage("localStorage.getItem('reading-v2-offline-ui-demo-1')?.length??0");
  if(local<100)throw Error("Local demo state never persisted");
  console.log("PASS: offline demo import, annotation, bookmark, selection, refresh, night mode",width);
 }finally{await send("Target.closeTarget",{targetId}).catch(()=>{});}
}
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser,protocol;
try{
 const addr=server.address();
 if(!addr||typeof addr==="string")throw Error("No local server address");
 const url="http://127.0.0.1:"+addr.port+"/my-reading-app/v2/";
 browser=launch(chrome);
 protocol=await openProtocol(await browser.endpoint);
 await inspect(protocol.send,url,390,844,true);
 await inspect(protocol.send,url,430,932,true);
 await inspect(protocol.send,url,768,1024,false);
 await inspect(protocol.send,url,1280,900,false);
 await inspectOfflineDemo(protocol.send,url+"demo/",390,844,true);
 await inspectOfflineDemo(protocol.send,url+"demo/",1280,900,false);
}finally{
 protocol?.close();
 browser?.child.kill();
 if(browser?.userData){
  try{
   fs.rmSync(browser.userData,{recursive:true,force:true,maxRetries:8,retryDelay:120});
  }catch{
   // Chromium sometimes creates one more transient profile file after exit.
   // The disposable CI runner will remove it after the job.
   console.warn("Deferred ephemeral Chromium profile cleanup");
  }
 }
 server.close();
}
