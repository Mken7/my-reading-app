/* eslint-disable @typescript-eslint/no-require-imports -- browser harness uses CommonJS */
const fs=require("node:fs");
const http=require("node:http");
const path=require("node:path");
const {spawn,spawnSync}=require("node:child_process");

const root=__dirname;
const chrome=["google-chrome","google-chrome-stable","chromium","chromium-browser"]
  .find(name=>spawnSync("which",[name],{encoding:"utf8"}).status===0);
if(!chrome){console.error("Chromium required for responsive reader test");process.exit(1);}
const serve=http.createServer((request,response)=>{
  const url=new URL(request.url,"http://localhost");
  const pathname=url.pathname;
  const location=pathname==="/reader.html"
    ? path.join(root,"reader.html")
    : pathname==="/reader-pages.css"
      ? path.join(root,"../../app/v2/reader-pages.css")
      : pathname==="/compiled/readerLayout.js"
        ? path.join(root,"compiled/readerLayout.js") : null;
  if(!location){response.writeHead(404).end("Missing");return;}
  fs.readFile(location,(error,buffer)=>{
    if(error){response.writeHead(404).end("Missing");return;}
    response.writeHead(200,{"Content-Type":pathname.endsWith(".css")?"text/css":
      pathname.endsWith(".html")?"text/html; charset=utf-8":"text/javascript; charset=utf-8"});
    response.end(buffer);
  });
});
function exercise(port,width,expect){
  return new Promise((resolve,reject)=>{
    const url="http://127.0.0.1:"+port+"/reader.html";
    const child=spawn(chrome,[
      "--headless=new","--no-sandbox","--disable-gpu","--disable-extensions",
      "--disable-dev-shm-usage","--no-first-run",
      "--window-size="+width+",860",
      "--virtual-time-budget=3000","--dump-dom",url,
    ],{stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    const timer=setTimeout(()=>child.kill("SIGKILL"),45000);
    child.stdout.on("data",data=>{stdout+=data.toString();});
    child.stderr.on("data",data=>{if(stderr.length<2000)stderr+=data.toString();});
    child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.on("close",code=>{
      clearTimeout(timer);
      const check=new RegExp("READER_BROWSER_PASS:"+expect);
      if(code===0 && check.test(stdout)){resolve();return;}
      reject(new Error(
        "Reader "+expect+" test failed, code="+code+" "+
        (stdout.match(/READER_BROWSER_(PASS|FAIL)[^<]*/)?.[0]??"no result")+
        " "+stderr.slice(-600)));
    });
  });
}
serve.listen(0,"127.0.0.1",async()=>{
  const address=serve.address();
  if(!address || typeof address==="string")throw Error("No local port");
  try {
    await exercise(address.port,430,"mobile");
    console.log("PASS: Chromium narrow-screen single-page book");
    await exercise(address.port,1440,"desktop");
    console.log("PASS: Chromium wide-screen two independent pages");
  }catch(error){
    process.exitCode=1;
    console.error(error);
  }finally{serve.close();}
});
