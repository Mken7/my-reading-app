// Verifies the actual built static export can be served without Next's HMR
// socket, and that its asset URLs work in both local and Pages base paths.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";

const child=spawn(process.execPath,["scripts/serve-static-preview.mjs"],{
 env:{...process.env,PREVIEW_PORT:"0"},
 stdio:["ignore","pipe","pipe"],
});
let err="",output="",url;
const ready=new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error("Static preview did not start")),15000);
 child.stdout.on("data",buf=>{
  output+=buf.toString();
  const match=output.match(/LOCAL PREVIEW READY: (http:\/\/127\.0\.0\.1:\d+\/v2\/demo\/)/);
  if(match){url=match[1];clearTimeout(timer);resolve();}
 });
 child.stderr.on("data",buf=>{if(err.length<2000)err+=buf.toString();});
 child.once("error",e=>{clearTimeout(timer);reject(e);});
 child.once("exit",code=>{clearTimeout(timer);reject(Error("Static preview exited: "+code+" "+err));});
});
try{
 await ready;
 const page=await fetch(url);
 assert.equal(page.status,200,"Built demo must be served");
 assert.match(page.headers.get("content-type")??"",/text\/html/);
 const html=await page.text();
 assert.match(html,/(共读书房|无需登录)/);
 const base=new URL(url).origin;
 const js=html.match(/<script[^>]*\ssrc="([^"]+\.js(?:\?[^"]*)?)"/);
 assert.ok(js,"Next HTML needs at least one hydration JS asset");
 const path=js[1].replaceAll("&amp;","&");
 const asset=await fetch(new URL(path,base));
 assert.equal(asset.status,200,"Bundled JavaScript must be reachable");
 assert.match(asset.headers.get("content-type")??"",/javascript/);
 const notFound=await fetch(base+"/v2/demo/no-such-file.js");
 assert.equal(notFound.status,404);
 const head=await fetch(url,{method:"HEAD"});
 assert.equal(head.status,200);
 assert.equal((await head.text()).length,0);
 await delay(100);
 console.log("PASS: no-WebSocket static V2 demo entry, compiled React JS, missing file and HEAD");
}finally{
 child.kill();
}
