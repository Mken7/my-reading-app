/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS Chromium launcher */
const fs=require("node:fs");
const http=require("node:http");
const path=require("node:path");
const {spawn,spawnSync}=require("node:child_process");
const {readStaticBrowserMarker}=require("../../lib/v2/staticBrowserMarker.cjs");

const out=path.resolve(__dirname,"../../out");
const enabled=process.argv.includes("--enabled");
if(!fs.existsSync(path.join(out,"v2","index.html"))){
 console.error("Expected a completed GitHub Pages static export in out/v2/index.html");
 process.exit(1);
}
const chrome=["google-chrome","google-chrome-stable","chromium","chromium-browser"]
 .find(name=>spawnSync("which",[name],{encoding:"utf8"}).status===0);
if(!chrome){console.error("A real Chromium browser is required");process.exit(1);}

const injected=`<script>(() => {
 const browserErrors=[];
 window.addEventListener("error",e=>{browserErrors.push(String(e.message).slice(0,120));});
 window.addEventListener("unhandledrejection",e=>{
  browserErrors.push(String(e.reason?.message??e.reason).slice(0,120));
 });
 let done=false;
 const started=Date.now();
 const report=()=>{
  if(done)return;
  const title=[...document.querySelectorAll("h2")]
    .map(node=>node.textContent||"")
    .find(title=>title.includes("V2 预览默认关闭"))||"";
  const realForm=document.querySelector("input[type=password]");
  const emailForm=document.querySelector("input[type=email]");
  const viewport=document.querySelector("meta[name=viewport]");
  const controls=[...document.querySelectorAll("button,input")];
  const unlabeled=controls.filter(node=>!node.getAttribute("aria-label")&&
    !node.closest("label")&&!node.getAttribute("aria-labelledby")&&
    !node.textContent?.trim()&&!node.getAttribute("type")?.includes("submit"));
  const formFields=[...document.querySelectorAll("input[type=email],input[type=password]")];
  const undersizedFields=formFields.filter(field=>
    field.getBoundingClientRect().height<43.5 || field.getBoundingClientRect().width<44);
  const keyboardFocusOutline=getComputedStyle(formFields[0]??document.body).outlineStyle;
  const authFetch=performance.getEntriesByType("resource").some(item=>
   /\\.supabase\\.co\\/(?:rest|auth|realtime)\\//.test(item.name));
  const overflowing=document.documentElement.scrollWidth>innerWidth+4;
  const active=${enabled};
  // Hydration timing is nondeterministic even in headless Chromium: never
  // assert that login is missing just because the first 2.5 seconds elapsed.
  // Retry until the form and responsive CSS actually hydrate, or fail at the
  // hard cutoff. This does not turn a permanently broken page into a pass.
  if(active && (!emailForm || !realForm || undersizedFields.length>0) &&
     Date.now()-started<10000) return;
  done=true;
  window.clearInterval(poll);
  const ok=active
    ? Boolean(emailForm&&realForm&&!overflowing&&viewport&&
      document.querySelector("form")&&undersizedFields.length===0&&
      document.querySelector(".v2-preview-shell")&&
      !document.querySelector("input[type=hidden][name=service_role]"))
    : title.includes("V2 预览默认关闭")&&!realForm&&!authFetch&&!overflowing;
  const result=document.createElement("div");
  result.id="v2-static-test-result";
  result.textContent=(ok?"V2_STATIC_PASS:":"V2_STATIC_FAIL:")+
   JSON.stringify({width:innerWidth,overflowing,disabled:!!title.includes("默认关闭"),
    exposedAuthForm:!!realForm,hasEmail:!!emailForm,viewport:!!viewport,
    unlabeledInputs:unlabeled.filter(x=>x.matches("input")).length,
    undersizedFields:undersizedFields.length,keyboardFocusOutline,authFetch,
    heading:title,bodyText:document.body.innerText.slice(0,200),
    javascriptFiles:performance.getEntriesByType("resource").filter(x=>x.name.includes("/_next/")).length,
    scriptResponses:performance.getEntriesByType("resource")
      .filter(x=>x.name.includes("/_next/"))
      .slice(0,8).map(x=>[new URL(x.name).pathname.split("/").slice(-2).join("/"),x.responseStatus,x.transferSize]),
    loadedScripts:document.querySelectorAll("script[src]").length,
    browserErrors:browserErrors.slice(0,5)});
  document.body.appendChild(result);
 };
 const poll=window.setInterval(report,250);
 window.setTimeout(report,10500);
})()</script>`;

const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
 const cleaned=pathname.replace(/^\/my-reading-app/,"");
 const relative=cleaned.endsWith("/")?cleaned+"index.html":cleaned;
 const filename=path.resolve(out,"."+relative);
 if(!filename.startsWith(out+path.sep)){res.writeHead(404).end();return;}
 fs.readFile(filename,(error,buf)=>{
  if(error){res.writeHead(404).end("Missing");return;}
  const ext=path.extname(filename);
  if(ext===".html"){
   const html=buf.toString("utf8").replace("</head>",injected+"</head>");
   res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
   res.end(html);return;
  }
  const mime=ext===".css"?"text/css":ext===".js"?"text/javascript":
   ext===".svg"?"image/svg+xml":"application/octet-stream";
  res.writeHead(200,{"Content-Type":mime});
  res.end(buf);
 });
});

async function check(port,width){
 const url="http://127.0.0.1:"+port+"/my-reading-app/v2/";
 return new Promise((resolve,reject)=>{
  const browser=spawn(chrome,[
   "--headless=new","--no-sandbox","--disable-gpu","--disable-extensions",
   "--disable-dev-shm-usage","--no-first-run",
   "--window-size="+width+",860","--virtual-time-budget=14000",
   "--dump-dom",url,
  ],{stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  const timeout=setTimeout(()=>browser.kill("SIGKILL"),45000);
  browser.stdout.on("data",data=>{if(stdout.length<300000)stdout+=data.toString();});
  browser.stderr.on("data",data=>{if(stderr.length<1800)stderr+=data.toString();});
  browser.on("error",error=>{clearTimeout(timeout);reject(error);});
  browser.on("close",code=>{
   clearTimeout(timeout);
   const text=readStaticBrowserMarker(stdout);
   if(code===0&&text?.startsWith("V2_STATIC_PASS:"))resolve(text);
   else reject(Error("Static preview "+width+"px failed: "+(text??"missing rendered assertion node")+
    " "+stderr.slice(-350)));
  });
 });
}
server.listen(0,"127.0.0.1",async()=>{
 const addr=server.address();
 if(!addr||typeof addr==="string")throw Error("No listen port");
 try{
  for(const w of [390,520,768,1280]){
   let result=null;
   let lastError=null;
   // Headless Chrome/Next hydration races during cold CI starts. A retry is
   // accepted ONLY if a fresh browser instance actually renders PASS in its
   // DOM; stale inline-source markers remain explicitly rejected.
   for(let attempt=1;attempt<=3&&!result;attempt++){
    try{result=await check(addr.port,w);}
    catch(error){lastError=error;}
   }
   if(!result)throw lastError??Error("No browser hydration result");
   console.log("PASS: static V2 preview "+(enabled?"opt-in login":"default-off")+" at width",w,result);
  }
 }catch(error){process.exitCode=1;console.error(error);}
 finally{server.close();}
});
