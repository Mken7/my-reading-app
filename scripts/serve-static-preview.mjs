// Local-only static preview: no Next.js dev server, hot-reload sockets or
// external dependencies. Requires `npm run build` (Next output: export).
import {createServer} from "node:http";
import {readFile,stat} from "node:fs/promises";
import path from "node:path";

const root=path.resolve("out");
const host="127.0.0.1";
const port=Number(process.env.PREVIEW_PORT??3000);
if(!Number.isInteger(port)||port<0||port>65535){
 throw Error("Invalid local preview port");
}
const types={
 ".html":"text/html; charset=utf-8",
 ".js":"text/javascript; charset=utf-8",
 ".css":"text/css; charset=utf-8",
 ".json":"application/json; charset=utf-8",
 ".svg":"image/svg+xml",
 ".ico":"image/x-icon",
 ".png":"image/png",
 ".jpg":"image/jpeg",
 ".jpeg":"image/jpeg",
 ".webp":"image/webp",
 ".woff":"font/woff",
 ".woff2":"font/woff2",
 ".txt":"text/plain; charset=utf-8",
};
const server=createServer(async(req,res)=>{
 if(req.method!=="GET"&&req.method!=="HEAD"){
  res.writeHead(405,{Allow:"GET, HEAD"}).end();return;
 }
 let pathname;
 try{
  pathname=decodeURIComponent(new URL(req.url??"/","http://127.0.0.1").pathname);
 }catch{res.writeHead(400).end("Bad address");return;}
 if(pathname.includes("\\")||pathname.includes("\0")){
  res.writeHead(400).end("Invalid path");return;
 }
 // URL.path already normalizes literal .. segments; never resolve outside out.
 const file=path.resolve(root,"."+pathname+(pathname.endsWith("/")?"index.html":""));
 if(!file.startsWith(root+path.sep)){
  res.writeHead(403).end("Forbidden");return;
 }
 try{
  const meta=await stat(file);
  if(!meta.isFile())throw Error("not a file");
  const body=await readFile(file);
  const type=types[path.extname(file).toLowerCase()]??"application/octet-stream";
  const headers={"Content-Type":type,"Content-Length":String(body.length),
   "Cache-Control":"no-store"};
  res.writeHead(200,headers);
  res.end(req.method==="HEAD"?undefined:body);
 }catch{res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"}).end("Not found");}
});
server.on("error",error=>{
 console.error(error.code==="EADDRINUSE"?
  "本地端口已被占用。先在运行 npm run dev 的终端按 Ctrl+C，再启动预览。":
  "无法启动本地预览服务。");
 process.exitCode=1;
});
try{
 const built=await stat(path.join(root,"v2","demo","index.html"));
 if(!built.isFile())throw Error("missing");
 server.listen(port,host,()=>{
  const address=server.address();
  if(!address||typeof address==="string")return;
  console.log("LOCAL PREVIEW READY: http://"+host+":"+address.port+"/v2/demo/");
  console.log("免登录演示，无热更新 WebSocket。请在 Edge 使用上述完整地址。");
 });
}catch{
 console.error("还没有生成静态网页。请先执行 npm run build。");
 process.exitCode=1;
}
