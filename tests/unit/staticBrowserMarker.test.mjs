import test from "node:test";
import assert from "node:assert/strict";
import marker from "../../lib/v2/staticBrowserMarker.cjs";
const {readStaticBrowserMarker}=marker;

test("browser assertions are not satisfied by unexecuted inline script text",()=>{
 const source=`<html><script>
   const status=(ok?"V2_STATIC_PASS:":"V2_STATIC_FAIL:")+"unverified";
   const node=document.createElement("div");
   node.id="v2-static-test-result";
   node.textContent=status;
 </script></html>`;
 assert.equal(readStaticBrowserMarker(source),null);
});
test("only an actual injected DOM result can satisfy a browser check",()=>{
 const good='<html><body><div id="v2-static-test-result">V2_STATIC_PASS:{"width":390}</div></body></html>';
 const bad='<html><body><div id="v2-static-test-result">V2_STATIC_FAIL:{"overflow":true}</div></body></html>';
 assert.equal(readStaticBrowserMarker(good),'V2_STATIC_PASS:{"width":390}');
 assert.equal(readStaticBrowserMarker(bad),'V2_STATIC_FAIL:{"overflow":true}');
 assert.equal(readStaticBrowserMarker("V2_STATIC_PASS:all-good"),null);
 assert.equal(readStaticBrowserMarker(null),null);
});
