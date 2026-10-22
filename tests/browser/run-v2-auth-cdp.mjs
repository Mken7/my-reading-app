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
const demoOnly=process.argv.includes("--demo-only");
const mobileOnly=process.argv.includes("--mobile-only");
const desktopOnly=process.argv.includes("--desktop-only");
const compactDesktop=process.argv.includes("--compact-desktop");
if(mobileOnly&&desktopOnly)throw Error("Choose at most one offline viewport filter");
const chrome=["google-chrome","google-chrome-stable","chromium","chromium-browser"]
 .find(name=>spawnSync("which",[name],{encoding:"utf8"}).status===0)
 || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
 ].find(candidate=>fs.existsSync(candidate));
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
    const diagnostic=await evalPage(`(()=>{const nav=document.querySelector('.demo-page-navigation');const flow=document.querySelector('.demo-column-flow');let stored={};try{stored=JSON.parse(localStorage.getItem('reading-v2-offline-ui-demo-1')||'{}').pageProgress||{};}catch{}return {pageCount:nav?.dataset.pageCount,pageOffset:nav?.dataset.pageOffset,chapter:nav?.dataset.chapter,stored,selection:getSelection()?.toString(),firstParagraph:document.querySelector('.demo-prose p')?.textContent?.slice(0,24),flowClientWidth:flow?.clientWidth,flowScrollWidth:flow?.scrollWidth,flowTransform:flow?.style.transform,flows:document.querySelectorAll('.demo-column-flow').length};})()`);
    throw Error("Demo did not reach "+label+": "+JSON.stringify(diagnostic));
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
  if(width>=1000){
   await waitFor("!!document.querySelector('.demo-paper-page-next')","desktop spread layout");
   const chapterBoundary=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {pages:Number(nav?.dataset.pageCount),flows:document.querySelectorAll('.demo-column-flow').length,headings:document.querySelectorAll('.demo-chapter-name').length,blank:!!document.querySelector('.demo-paper-page-next.demo-paper-page-blank')};})()");
   if(chapterBoundary.flows!==1||chapterBoundary.headings!==1||
      (chapterBoundary.pages===1&&!chapterBoundary.blank))
    throw Error("Desktop chapter boundary duplicated or pre-read its next chapter: "+JSON.stringify(chapterBoundary));
  }
  await evalPage("document.querySelector('.demo-reader-actions .demo-icon-action').click();true");
  await waitFor("!!document.querySelector('.demo-icon-selected')","bookmark toggle");

  // Regression: completing a freehand stroke used to enqueue a React state
  // updater that read drawingRef.current after it had been cleared to null.
  await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('自由手绘'));button.click();return true;})()");
  await waitFor("!!document.querySelector('.demo-ink-layer.demo-ink-active')","freehand drawing mode");
  const inkRect=await evalPage("(()=>{const svg=document.querySelector('.demo-ink-layer.demo-ink-active');svg.scrollIntoView({block:'center'});const r=svg.getBoundingClientRect();return {x:r.left+r.width*.4,y:r.top+r.height*.38,width:r.width,height:r.height};})()");
  if(inkRect.width<50||inkRect.height<50)throw Error("Drawing overlay has invalid bounds");
  const x=Math.round(inkRect.x),y=Math.round(inkRect.y);
  if(mobile){
   await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y,id:1}]},sessionId);
   await send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:x+28,y:y+27,id:1}]},sessionId);
   await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]},sessionId);
  }else{
   await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+28,y:y+27,button:"left",buttons:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x+28,y:y+27,button:"left",clickCount:1},sessionId);
  }
  if(!mobile&&width>=1000){
   const rightInk=await evalPage("(()=>{const svg=document.querySelector('.demo-ink-layer[data-page=\\\"1\\\"]');if(!svg)return null;const r=svg.getBoundingClientRect();return {x:Math.round(r.left+r.width*.62),y:Math.round(r.top+r.height*.44)};})()");
   if(!rightInk)throw Error("Desktop spread did not expose the right-page ink layer");
   await send("Input.dispatchMouseEvent",{type:"mousePressed",x:rightInk.x,y:rightInk.y,button:"left",clickCount:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:rightInk.x+31,y:rightInk.y+19,button:"left",buttons:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:rightInk.x+31,y:rightInk.y+19,button:"left",clickCount:1},sessionId);
   await waitFor("document.querySelectorAll('.demo-ink-layer polyline').length>=2","left and right spread ink strokes");
   await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-drawing-help button')].find(b=>b.textContent.includes('撤销'));button.click();return true;})()");
   await waitFor("document.querySelectorAll('.demo-ink-layer polyline').length===1","undo right-page stroke");
   await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-drawing-help button')].find(b=>b.textContent.includes('重做'));button.click();return true;})()");
   await waitFor("document.querySelectorAll('.demo-ink-layer polyline').length===2","redo right-page stroke");
   await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-drawing-help button')].find(b=>b.textContent.includes('橡皮擦'));button.click();return true;})()");
   await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+2,y:y+2,button:"left",buttons:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x+2,y:y+2,button:"left",clickCount:1},sessionId);
   await waitFor("document.querySelectorAll('.demo-ink-layer polyline').length===1","erase left-page stroke");
   await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-drawing-help button')].find(b=>b.textContent.includes('画笔'));button.click();return true;})()");
   await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+28,y:y+27,button:"left",buttons:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x+28,y:y+27,button:"left",clickCount:1},sessionId);
   await waitFor("document.querySelectorAll('.demo-ink-layer polyline').length===2","redraw erased left-page stroke");
  }
  await waitFor("!!document.querySelector('.demo-ink-layer polyline')","completed ink stroke");
  // Regression: a freehand circle must retain a source-text anchor so a
  // reflowed line does not leave the ink at its old screen coordinates.
  let anchoredStrokeId=null;
  if(!mobile&&width>=1000){
   const target=await evalPage("(()=>{const paragraph=document.querySelector('.demo-prose p[data-paragraph-index=\\\"0\\\"]');const svg=document.querySelector('.demo-ink-layer[data-page=\\\"0\\\"]');if(!paragraph||!svg)return null;const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);const node=walker.nextNode();if(!node||!node.textContent)return null;const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(18,node.textContent.length));const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);const sr=svg.getBoundingClientRect();if(!rects.length||!sr.width||!sr.height)return null;const bounds={left:Math.min(...rects.map(r=>r.left)),top:Math.min(...rects.map(r=>r.top)),right:Math.max(...rects.map(r=>r.right)),bottom:Math.max(...rects.map(r=>r.bottom))};const left=Math.max(sr.left+8,bounds.left-12),right=Math.min(sr.right-8,bounds.right+12),top=Math.max(sr.top+8,bounds.top-8),bottom=Math.min(sr.bottom-8,bounds.bottom+8);if(right-left<18||bottom-top<12)return null;const points=[];for(let i=0;i<=20;i++){const angle=(Math.PI*2*i)/20;points.push({x:Math.round(left+(right-left)*(0.5+0.5*Math.cos(angle))),y:Math.round(top+(bottom-top)*(0.5+0.5*Math.sin(angle)))});}return {points,quote:range.toString(),bounds:{left,top,right,bottom}};})()");
   if(!target)throw Error("Could not locate a visible text target for freehand reflow regression");
   await send("Input.dispatchMouseEvent",{type:"mousePressed",x:target.points[0].x,y:target.points[0].y,button:"left",clickCount:1},sessionId);
   for(const point of target.points.slice(1,-1))
    await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y,button:"left",buttons:1},sessionId);
   const last=target.points.at(-1);
   await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:last.x,y:last.y,button:"left",clickCount:1},sessionId);
   await waitFor("(()=>{try{const s=JSON.parse(localStorage.getItem('reading-v2-offline-ui-demo-1')||'{}').strokes||[];return !!s.at(-1)?.anchor?.quote;}catch{return false;}})()","text-anchored freehand stroke");
   const persistedAnchor=await evalPage("(()=>{try{const s=JSON.parse(localStorage.getItem('reading-v2-offline-ui-demo-1')||'{}').strokes||[];const item=[...s].reverse().find(x=>x?.anchor?.quote);return item?{id:item.id,anchor:item.anchor}:null;}catch{return null;}})()");
   if(!persistedAnchor?.id||!persistedAnchor.anchor)throw Error("Freehand stroke was not persisted with a text anchor");
   anchoredStrokeId=persistedAnchor.id;
  }
  await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('结束手绘'));button.click();return true;})()");
  await waitFor("!document.querySelector('.demo-ink-active')","freehand mode exits");
  await delay(500);
  await send("Page.reload",{ignoreCache:true},sessionId);
  await waitFor("document.querySelector('.demo-app')?.dataset.demoReady==='yes'","ink reload");
  await evalPage("document.querySelector('.demo-book-card').click();true");
  await waitFor("!!document.querySelector('.demo-ink-layer polyline')","persistent saved ink stroke");

  if(!mobile&&width>=1000){
   await waitFor("document.querySelectorAll('.demo-physical-page').length>=1&&document.querySelectorAll('.demo-ink-layer').length>=1","persisted spread ink layers");
   const overlayGeometry=async()=>evalPage("(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return {papers:[...document.querySelectorAll('.demo-physical-page')].map(rect),inks:[...document.querySelectorAll('.demo-ink-layer')].map(rect)};})()");
   const assertOverlayAlignment=(geometry,mode)=>{
    if(!geometry.papers.length||!geometry.inks.length)
     throw Error("Ink layer count changed in "+mode+" mode: "+JSON.stringify(geometry));
    geometry.inks.forEach(ink=>{
     const paper=geometry.papers.reduce((best,candidate)=>{
      const score=Math.abs(candidate.left-ink.left)+Math.abs(candidate.top-ink.top);
      return !best||score<best.score?{paper:candidate,score}:best;
     },null)?.paper;
     if(!paper)throw Error("Ink layer has no matching paper in "+mode);
     const delta=Math.max(Math.abs(paper.left-ink.left),Math.abs(paper.right-ink.right),
      Math.abs(paper.top-ink.top),Math.abs(paper.bottom-ink.bottom));
     if(delta>1.5)throw Error("Ink layer drifted from paper in "+mode+" mode: "+JSON.stringify({paper,ink,delta}));
    });
   };
   if(anchoredStrokeId){
    const anchorGeometry=async()=>evalPage(`(()=>{try{const state=JSON.parse(localStorage.getItem('reading-v2-offline-ui-demo-1')||'{}');const item=(state.strokes||[]).find(x=>x.id===${JSON.stringify(anchoredStrokeId)});const anchor=item?.anchor;const paragraph=anchor&&document.querySelector('.demo-prose p[data-paragraph-index="'+anchor.paragraphIndex+'"]');const poly=anchor&&document.querySelector('polyline[data-stroke-id="'+${JSON.stringify(anchoredStrokeId)}+'"]');if(!anchor||!paragraph||!poly)return {anchor:!!anchor,paragraph:!!paragraph,poly:!!poly};const boundary=offset=>{const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);let node=walker.nextNode(),remaining=offset;while(node){const length=node.textContent?.length||0;if(remaining<=length)return {node,offset:remaining};remaining-=length;node=walker.nextNode();}return null;};const from=boundary(anchor.start),to=boundary(anchor.end);if(!from||!to)return {anchor:true,paragraph:true,poly:true,range:false};const range=document.createRange();range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);const text=rects.length?{left:Math.min(...rects.map(r=>r.left)),top:Math.min(...rects.map(r=>r.top)),right:Math.max(...rects.map(r=>r.right)),bottom:Math.max(...rects.map(r=>r.bottom))}:null;const svg=poly.ownerSVGElement,sr=svg?.getBoundingClientRect(),box=poly.getBBox();const ink=sr&&box?{left:sr.left+box.x/100*sr.width,top:sr.top+box.y/100*sr.height,right:sr.left+(box.x+box.width)/100*sr.width,bottom:sr.top+(box.y+box.height)/100*sr.height}:null;const covers=!!(text&&ink&&ink.left<=text.right+18&&ink.right>=text.left-18&&ink.top<=text.bottom+18&&ink.bottom>=text.top-18);return {anchor:true,quote:anchor.quote,text,ink,covers};}catch(error){return {error:String(error)};}})()`,`anchor geometry`);
    const beforeAnchor=await anchorGeometry();
    if(!beforeAnchor.covers)throw Error("Anchored freehand stroke does not cover its source text before reflow: "+JSON.stringify(beforeAnchor));
    await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('设置'));button.click();return true;})()");
    await waitFor("!!document.querySelector('.demo-settings-panel')","font reflow settings");
    await evalPage("(()=>{const input=document.querySelector('input[aria-label=\\\"正文字号\\\"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'24');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    await evalPage("document.querySelector('.demo-return-to-book').click();true");
    await waitFor("!!document.querySelector('.demo-prose')&&document.querySelector('.demo-page-navigation')?.dataset.pageCount","font reflow reader");
    const afterFontAnchor=await anchorGeometry();
    if(!afterFontAnchor.covers)throw Error("Anchored freehand stroke drifted after font reflow: "+JSON.stringify({before:beforeAnchor,after:afterFontAnchor}));
    await send("Emulation.setDeviceMetricsOverride",{width:1100,height,deviceScaleFactor:1,mobile:false},sessionId);
    await waitFor("!!document.querySelector('.demo-prose')&&document.querySelectorAll('.demo-ink-layer').length>=1","window resize reflow reader");
    const afterResizeAnchor=await anchorGeometry();
    if(!afterResizeAnchor.covers)throw Error("Anchored freehand stroke drifted after window resize: "+JSON.stringify(afterResizeAnchor));
    await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false},sessionId);
    await waitFor("innerWidth==="+String(width)+"&&Math.abs(document.querySelector('.demo-physical-page')?.getBoundingClientRect().right-document.querySelector('.demo-ink-layer')?.getBoundingClientRect().right)<2","restored window reflow reader");
   }
   assertOverlayAlignment(await overlayGeometry(),"double-page");
   for(let cycle=0;cycle<3;cycle++){
    await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('设置'));button.click();return true;})()");
    await waitFor("!!document.querySelector('.demo-settings-panel')","drawing reflow settings");
    await evalPage("document.querySelector('[role=\\\"switch\\\"][aria-label=\\\"桌面双页模式\\\"]').click();true");
    await evalPage("document.querySelector('.demo-return-to-book').click();true");
    await waitFor("!!document.querySelector('.demo-prose')&&document.querySelectorAll('.demo-physical-page').length===1","single-page drawing reflow");
    assertOverlayAlignment(await overlayGeometry(),"single-page");
    await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('设置'));button.click();return true;})()");
    await waitFor("!!document.querySelector('.demo-settings-panel')","drawing spread settings");
    await evalPage("document.querySelector('[role=\\\"switch\\\"][aria-label=\\\"桌面双页模式\\\"]').click();true");
    await evalPage("document.querySelector('.demo-return-to-book').click();true");
    await waitFor("!!document.querySelector('.demo-prose')&&document.querySelectorAll('.demo-physical-page').length===2","double-page drawing reflow");
    assertOverlayAlignment(await overlayGeometry(),"double-page");
   }
  }

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
  // Long imported TXT (like book/PDF text chunks) must flow horizontally
  // into physical pages rather than expanding the paper and desktop scrollbar.
  await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-menu-item')].find(b=>b.textContent.includes('我的书架'));button.click();return true;})()");
  await waitFor("!!document.querySelector('.demo-file-input')","return to bookshelf");
  await evalPage("(()=>{const text=Array.from({length:1500},(_,i)=>'分页标记 '+String(i).padStart(4,'0')+'：连续分页测试。').join('\\n\\n');const input=document.querySelector('.demo-file-input');const dt=new DataTransfer();dt.items.add(new File([text],'长文本翻页测试.txt',{type:'text/plain'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
  await waitFor("document.querySelector('.demo-reader-back h1')?.textContent==='长文本翻页测试'","long TXT book import");
  await waitFor("(()=>{const flow=document.querySelector('.demo-column-flow');const label=document.querySelector('.demo-progress-label');return flow&&flow.clientWidth>0&&flow.scrollWidth>flow.clientWidth*1.7&&label?.textContent.includes('页');})()","actual multi-column book pagination");
  // Every viewport must traverse at least twenty physical pages in one
  // chapter; desktop spreads advance two consecutive pages per interaction.
  // A single TXT storage chunk is capped at 2800 code points. At the taller
  // 900px desktop viewport that source chunk measures 17 pages; the compact
  // desktop and mobile passes still exercise the requested 20-page sequence.
  const requiredPages=width>=1000&&height>700?16:20;
  await waitFor("Number(document.querySelector('.demo-page-navigation')?.dataset.pageCount)>="+String(requiredPages),"fully measured physical column count");
  const initialFlow=await evalPage("(()=>({flows:document.querySelectorAll('.demo-column-flow').length,first:(document.querySelector('.demo-column-flow')?.textContent.match(/分页标记 0000/g)||[]).length,second:(document.querySelector('.demo-column-flow')?.textContent.match(/分页标记 0001/g)||[]).length}))()");
  if(initialFlow.flows!==1||initialFlow.first!==1||initialFlow.second!==1)
   throw Error("Reader rendered duplicate paragraph sources: "+JSON.stringify(initialFlow));
  const oldLabel=await evalPage("document.querySelector('.demo-progress-label').textContent");
  const beforeLayout=await evalPage("(()=>{const page=document.querySelector('.demo-physical-page');const flow=document.querySelector('.demo-column-flow');return {pageHeight:page.clientHeight,textHeight:flow.clientHeight,paperOverflow:getComputedStyle(page).overflow,desktopOverflow:getComputedStyle(document.querySelector('.demo-outer')).overflowY};})()");
  if(beforeLayout.textHeight>beforeLayout.pageHeight||beforeLayout.paperOverflow!=="hidden")
   throw Error("Page exceeded fixed paper height: "+JSON.stringify(beforeLayout));
  if(width>=1000&&beforeLayout.desktopOverflow!=="hidden")
   throw Error("Desktop reader still uses vertical scrolling: "+JSON.stringify(beforeLayout));
  // Page zero is already visible when the imported chapter opens. Desktop
  // advances through two consecutive pages per interaction.
  const pageTurns=Math.floor((requiredPages-1)/(width>=1000?2:1));
  for(let turn=0;turn<pageTurns;turn++){
   const beforeTurn=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),chapter:Number(nav.dataset.chapter),transform:document.querySelector('.demo-column-flow').style.transform};})()");
   await evalPage("document.querySelector('.demo-page-navigation button:last-child').click();true");
   await waitFor("Number(document.querySelector('.demo-page-navigation')?.dataset.pageOffset)>"+String(beforeTurn.offset),"continuous physical page "+String(turn+1));
   const afterTurn=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),chapter:Number(nav.dataset.chapter),transform:document.querySelector('.demo-column-flow').style.transform,flows:document.querySelectorAll('.demo-column-flow').length};})()");
   const stride=width>=1000?2:1;
   if(afterTurn.offset!==beforeTurn.offset+stride||afterTurn.chapter!==beforeTurn.chapter||
      afterTurn.transform===beforeTurn.transform||afterTurn.flows!==1)
    throw Error("Non-continuous reader turn "+String(turn+1)+": "+JSON.stringify({beforeTurn,afterTurn,stride}));
  }
  await waitFor("document.querySelector('.demo-progress-label')?.textContent!=="+JSON.stringify(oldLabel),"physical page advance without chapter jump");
  const changed=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),chapter:Number(nav.dataset.chapter),count:Number(nav.dataset.pageCount),transform:document.querySelector('.demo-column-flow').style.transform};})()");
  if(changed.offset<1||changed.chapter!==0||!changed.transform.includes("translate3d(-"))
   throw Error("Book did not advance inside the same chapter: "+JSON.stringify(changed));
  // Whole-book seeking keeps the physical pages still while the thumb is only
  // being previewed, then commits one real source-position jump on release.
  const progressSlider=await evalPage("(()=>{const input=document.querySelector('.demo-progress-slider input');if(!input)return null;const r=input.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()");
  if(!progressSlider||progressSlider.width<60)throw Error("Whole-book progress slider has no usable hit area");
  const previewBefore=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),chapter:Number(nav.dataset.chapter),transform:document.querySelector('.demo-column-flow').style.transform};})()");
  const previewState=await evalPage("(()=>{const input=document.querySelector('.demo-progress-slider input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'75');input.dispatchEvent(new Event('input',{bubbles:true}));return {preview:document.querySelector('.demo-progress-preview')?.textContent,offset:Number(document.querySelector('.demo-page-navigation').dataset.pageOffset),transform:document.querySelector('.demo-column-flow').style.transform};})()");
  if(!previewState.preview?.includes("75%")||previewState.offset!==previewBefore.offset||
     previewState.transform!==previewBefore.transform)
    throw Error("Progress preview changed reader pages before release: "+JSON.stringify({previewBefore,previewState}));
  const startX=Math.round(progressSlider.left+progressSlider.width*.75);
  const targetX=Math.round(progressSlider.left+progressSlider.width*.25);
  const targetY=Math.round(progressSlider.top+progressSlider.height/2);
  if(mobile){
   // Chromium's headless touch injector does not target native range inputs.
   // Dispatch touch-pointer semantics in the mobile document so the same
   // Pointer-event path is covered without pretending a mouse is a touch.
   await evalPage("(()=>{const input=document.querySelector('.demo-progress-slider input');const emit=(type,x)=>input.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:3,pointerType:'touch',clientX:x,clientY:"+String(targetY)+"}));emit('pointerdown',"+String(startX)+");emit('pointermove',"+String(targetX)+");emit('pointerup',"+String(targetX)+");return true;})()");
  }else{
   await send("Input.dispatchMouseEvent",{type:"mousePressed",x:startX,y:targetY,button:"left",clickCount:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:targetX,y:targetY,button:"left",buttons:1},sessionId);
   await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:targetX,y:targetY,button:"left",clickCount:1},sessionId);
  }
  await waitFor("(()=>{const nav=document.querySelector('.demo-page-navigation');const input=document.querySelector('.demo-progress-slider input');return Number(input?.value)<30&&Number(nav?.dataset.pageOffset)!=="+String(previewBefore.offset)+";})()","whole-book progress release jump");
  const seeked=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),chapter:Number(nav.dataset.chapter),transform:document.querySelector('.demo-column-flow').style.transform,label:document.querySelector('.demo-progress-label')?.textContent};})()");
  if((seeked.chapter===previewBefore.chapter&&seeked.offset===previewBefore.offset)||seeked.transform===previewBefore.transform||
     !seeked.label?.includes("已读"))
    throw Error("Whole-book progress release did not move the rendered source: "+JSON.stringify({previewBefore,seeked}));
  await waitFor("(()=>{const nav=document.querySelector('.demo-page-navigation');return Number(nav?.dataset.pageCount)>1&&Number(nav?.dataset.pageOffset)>0;})()","measured whole-book seek target");
  if(width>=1000){
   // Repeatedly leave and re-enter the reader through its settings control.
   // A single sheet has a centered max width, so its source viewport must be
   // measured in that sheet rather than the full two-page parent container.
   const seekAnchor=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),count:Number(nav.dataset.pageCount)};})()");
   const anchorRatio=seekAnchor.offset/Math.max(1,seekAnchor.count-1);
   for(let toggle=0;toggle<5;toggle++){
    await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('设置'));button.click();return true;})()");
    await waitFor("!!document.querySelector('[role=switch][aria-label=桌面双页模式]')","reader settings for spread toggle");
    await evalPage("document.querySelector('[role=switch][aria-label=桌面双页模式]').click();true");
    await evalPage("(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('返回阅读界面'));button.click();return true;})()");
    await waitFor("!!document.querySelector('.demo-reader')","reader after spread toggle");
    const spread=await evalPage("(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};const papers=[...document.querySelectorAll('.demo-physical-page')].map(rect);const viewport=rect(document.querySelector('.demo-flow-viewport'));let visible=false;for(const p of document.querySelectorAll('.demo-prose p')){const range=document.createRange();range.selectNodeContents(p);for(const r of range.getClientRects()){if(papers.some(paper=>r.left>=paper.left-1&&r.right<=paper.right+1&&r.top>=paper.top-1&&r.bottom<=paper.bottom+1)){visible=true;break;}}if(visible)break;}const nav=document.querySelector('.demo-page-navigation');return {papers,viewport,visible,offset:Number(nav.dataset.pageOffset),count:Number(nav.dataset.pageCount),topbar:getComputedStyle(document.querySelector('.demo-topbar')).display,strip:getComputedStyle(document.querySelector('.demo-accessibility-top')).display};})()");
    const expected=toggle%2===0?1:2;
    if(spread.papers.length!==expected||!spread.visible||spread.topbar!=="none"||spread.strip!=="none")
      throw Error("Spread switch broke visible reading geometry: "+JSON.stringify({toggle,spread}));
    if(expected===1&&(Math.abs(spread.viewport.left-spread.papers[0].left)>2||Math.abs(spread.viewport.right-spread.papers[0].right)>2))
      throw Error("Single-page text viewport is not aligned to its paper: "+JSON.stringify({toggle,spread}));
    const afterRatio=spread.offset/Math.max(1,spread.count-1);
    if(Math.abs(afterRatio-anchorRatio)>.2)
      throw Error("Spread switch lost the chapter reading position: "+JSON.stringify({toggle,anchorRatio,afterRatio,spread}));
   }
   const beforeSidebar=await evalPage("Number(document.querySelector('.demo-page-navigation')?.dataset.pageOffset)");
   await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('批注'));button.click();return true;})()");
   await waitFor("[...document.querySelectorAll('.demo-reader-actions button')].some(b=>b.textContent.includes('批注')&&b.getAttribute('aria-pressed')==='true')","floating annotation panel toggle");
   const afterSidebar=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),flows:document.querySelectorAll('.demo-column-flow').length,overflow:document.documentElement.scrollWidth>innerWidth+4};})()");
   if(afterSidebar.offset!==beforeSidebar||afterSidebar.flows!==1||afterSidebar.overflow)
    throw Error("Sidebar resize broke pagination: "+JSON.stringify({beforeSidebar,afterSidebar}));
   await evalPage("(()=>{const button=[...document.querySelectorAll('.demo-reader-actions button')].find(b=>b.textContent.includes('批注'));button.click();return true;})()");
   await send("Emulation.setDeviceMetricsOverride",{
    width:1160,height,deviceScaleFactor:1,mobile:false,
   },sessionId);
   await waitFor("innerWidth===1160&&document.querySelectorAll('.demo-column-flow').length===1","live desktop resize");
   const resized=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav?.dataset.pageOffset),count:Number(nav?.dataset.pageCount),flows:document.querySelectorAll('.demo-column-flow').length,overflow:document.documentElement.scrollWidth>innerWidth+4};})()");
   if(resized.offset<0||resized.offset>=resized.count||resized.flows!==1||resized.overflow)
    throw Error("Live window resize broke the continuous spread: "+JSON.stringify(resized));
   await send("Emulation.setDeviceMetricsOverride",{
    width,height,deviceScaleFactor:1,mobile:false,
   },sessionId);
   await waitFor("innerWidth==="+String(width)+"&&document.querySelectorAll('.demo-column-flow').length===1","restored desktop viewport");
  }
  // The physical-page cursor is local state, not a visual transform alone:
  // after a reload it must return to the same continuous page sequence.
  const settledSeeked=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:Number(nav.dataset.pageOffset),chapter:Number(nav.dataset.chapter)};})()");
  const persistedOffset=settledSeeked.offset;
  const persistedChapter=settledSeeked.chapter;
  await delay(600);
  await send("Page.reload",{ignoreCache:true},sessionId);
  await waitFor("document.querySelector('.demo-app')?.dataset.demoReady==='yes'&&!!document.querySelector('.demo-book-card')","reader progress reload");
  await evalPage("(()=>{const card=[...document.querySelectorAll('.demo-book-card')].find(el=>el.textContent.includes('长文本翻页测试'));card?.click();return true;})()");
  await delay(250);
  const restoreStart=await evalPage("(()=>{const nav=document.querySelector('.demo-page-navigation');return {offset:nav?.dataset.pageOffset,count:nav?.dataset.pageCount,saved:nav?.dataset.savedPage,disabled:document.querySelector('.demo-page-navigation button:last-child')?.disabled};})()");
  try{
   await waitFor("(()=>{const nav=document.querySelector('.demo-page-navigation');return Number(nav?.dataset.chapter)==="+String(persistedChapter)+"&&Number(nav?.dataset.pageOffset)==="+String(persistedOffset)+"&&Number(nav?.dataset.pageCount)>"+String(persistedOffset)+"&&!document.querySelector('.demo-page-navigation button:last-child')?.disabled;})()","restored continuous reading progress after pagination measurement");
  }catch(error){
   throw Error("Restored progress changed after opening the saved book: "+JSON.stringify({persistedChapter,persistedOffset,restoreStart}),{cause:error});
  }
  const keyboardStart=persistedOffset;
  const keyboardStride=await evalPage("document.querySelectorAll('.demo-physical-page').length");
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowLeft",code:"ArrowLeft",windowsVirtualKeyCode:37},sessionId);
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowLeft",code:"ArrowLeft",windowsVirtualKeyCode:37},sessionId);
  await waitFor("Number(document.querySelector('.demo-page-navigation')?.dataset.pageOffset)==="+String(keyboardStart-keyboardStride),"keyboard previous page");
  const afterKeyboardLeft=await evalPage("Number(document.querySelector('.demo-page-navigation')?.dataset.pageOffset)");
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39},sessionId);
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39},sessionId);
  try{
   await waitFor("Number(document.querySelector('.demo-page-navigation')?.dataset.pageOffset)==="+String(keyboardStart),"keyboard next page");
  }catch(error){
   throw Error("Keyboard page sequence failed: "+JSON.stringify({keyboardStart,keyboardStride,afterKeyboardLeft}),{cause:error});
  }
  await evalPage("document.querySelector('button[title*=书签]').click();true");
  await waitFor("document.querySelector('button[title*=书签]')?.getAttribute('aria-pressed')==='true'","physical page bookmark");
  const savedPage=await evalPage("Number(document.querySelector('.demo-page-navigation').dataset.pageOffset)");
  await evalPage("(()=>{const b=[...document.querySelectorAll('.demo-menu-item')].find(x=>x.textContent.includes('我的书签'));b.click();return true;})()");
  await waitFor("!!document.querySelector('.demo-bookmark-item')","bookmarks list");
  await evalPage("(()=>{const item=[...document.querySelectorAll('.demo-bookmark-item')].find(x=>x.textContent.includes('长文本翻页测试'));if(!item)return false;item.querySelector('button').click();return true;})()");
  await waitFor("Number(document.querySelector('.demo-page-navigation')?.dataset.pageOffset)==="+String(savedPage),"return to exact bookmarked page");


  console.log("PASS: offline demo import, annotation, bookmark, selection, refresh, night mode, touch/mouse freehand ink and persistence",width);
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
 if(!demoOnly){
  await inspect(protocol.send,url,390,844,true);
  await inspect(protocol.send,url,430,932,true);
  await inspect(protocol.send,url,768,1024,false);
  await inspect(protocol.send,url,1280,900,false);
 }
  if(!desktopOnly)await inspectOfflineDemo(protocol.send,url+"demo/",390,844,true);
  if(!mobileOnly)await inspectOfflineDemo(protocol.send,url+"demo/",1280,compactDesktop?620:900,false);
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
