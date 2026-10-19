/* Run actual IndexedDB/API integration in a real headless Chromium browser.
 * No real accounts, secrets, or Supabase connections are used. */
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const {spawn,spawnSync}=require("node:child_process");
const root=__dirname;
const binary=["google-chrome","google-chrome-stable","chromium","chromium-browser"]
  .find(command=>spawnSync("which",[command],{encoding:"utf8"}).status===0);
if (!binary){
  console.error("Chrome/Chromium browser is required for IndexedDB E2E test");
  process.exit(1);
}
const mime=(p)=>p.endsWith(".html")?"text/html; charset=utf-8":
  "text/javascript; charset=utf-8";
const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
  if(pathname!=="/queue.html" &&
     !/^\/compiled\/[a-zA-Z0-9-]+\.js$/.test(pathname)){
    res.writeHead(404).end("Missing");
    return;
  }
  const filename=path.join(root,pathname.slice(1));
  fs.readFile(filename,(error,buffer)=>{
    if(error){res.writeHead(404).end("Missing");return;}
    res.writeHead(200,{"Content-Type":mime(filename),"Cache-Control":"no-store"});
    res.end(buffer);
  });
});
server.listen(0,"127.0.0.1",()=>{
  const address=server.address();
  if(!address || typeof address==="string")throw Error("No server port");
  const url="http://127.0.0.1:"+address.port+"/queue.html";
  const browser=spawn(binary,[
    "--headless=new","--no-sandbox","--disable-gpu",
    "--disable-dev-shm-usage","--disable-extensions",
    "--no-first-run","--virtual-time-budget=60000",
    "--dump-dom",url,
  ],{stdio:["ignore","pipe","pipe"]});
  let output="";
  let stderr="";
  browser.stdout.on("data",chunk=>{if(output.length<200000)output+=chunk;});
  browser.stderr.on("data",chunk=>{if(stderr.length<50000)stderr+=chunk;});
  const timeout=setTimeout(()=>browser.kill("SIGKILL"),90000);
  browser.on("error",error=>{
    clearTimeout(timeout);
    console.error(error);
    process.exitCode=1;
    server.close();
  });
  browser.on("close",code=>{
    clearTimeout(timeout);
    const success=code===0 && output.includes("BROWSER_TEST_PASS");
    if(success) console.log("PASS: real Chrome IndexedDB encrypted drafts and privacy");
    else {
      console.error("FAIL: Browser E2E, exit "+code);
      const result=output.match(/BROWSER_TEST_(?:FAIL|PASS)[^<]*/);
      console.error(result?.[0] ?? output.slice(-1000));
      console.error(stderr.slice(-3000));
      process.exitCode=1;
    }
    server.close();
  });
});
