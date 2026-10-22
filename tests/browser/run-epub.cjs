/* eslint-disable @typescript-eslint/no-require-imports -- isolated browser harness */
const fs=require("node:fs");
const http=require("node:http");
const path=require("node:path");
const {spawn,spawnSync}=require("node:child_process");
const base=path.resolve(__dirname,"../..");
const chrome=["google-chrome","google-chrome-stable","chromium","chromium-browser"]
  .find(bin=>spawnSync("which",[bin],{encoding:"utf8"}).status===0);
if(!chrome){console.error("Chrome needed for real EPUB parsing test");process.exit(1);}
const allowed={
  "/epub.html":"tests/browser/epub.html",
  "/compiled/epub.js":"tests/browser/compiled/epub.js",
  "/compiled/txt.js":"tests/browser/compiled/txt.js",
};
const server=http.createServer((request,response)=>{
  const requested=new URL(request.url,"http://localhost").pathname;
  const filepath=allowed[requested];
  if(!filepath){response.writeHead(404).end("Not Found");return;}
  fs.readFile(path.join(base,filepath),(error,data)=>{
    if(error){response.writeHead(404).end("Not Found");return;}
    response.writeHead(200,{"Content-Type":requested.endsWith(".html")
      ?"text/html; charset=utf-8":"application/javascript; charset=utf-8"});
    response.end(data);
  });
});
server.listen(0,"127.0.0.1",()=>{
  const address=server.address();
  if(!address || typeof address==="string")throw Error("No server port");
  const browser=spawn(chrome,[
    "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
    "--disable-extensions","--no-first-run","--virtual-time-budget=30000",
    "--dump-dom","http://127.0.0.1:"+address.port+"/epub.html",
  ],{stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  browser.stdout.on("data",data=>{if(stdout.length<400000)stdout+=data;});
  browser.stderr.on("data",data=>{if(stderr.length<10000)stderr+=data;});
  const timer=setTimeout(()=>browser.kill("SIGKILL"),60000);
  browser.on("error",error=>{
    clearTimeout(timer);console.error(error);process.exitCode=1;server.close();
  });
  browser.on("close",code=>{
    clearTimeout(timer);
    if(code===0 && stdout.includes("EPUB_BROWSER_PASS")){
      console.log("PASS: real Chromium EPUB ZIP/XHTML parser, spine mapping and no-script safety");
    }else{
      process.exitCode=1;
      console.error("FAIL: EPUB browser test, exit "+code);
      console.error(stdout.match(/EPUB_BROWSER_(?:PASS|FAIL)[^<]*/)?.[0]??stdout.slice(-1200));
      console.error(stderr.slice(-1000));
    }
    server.close();
  });
});
