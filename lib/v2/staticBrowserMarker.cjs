/* eslint-disable @typescript-eslint/no-require-imports -- portable CommonJS browser test helper */
/** Do not accept PASS markers that occur in an unexecuted inline script. */
function readStaticBrowserMarker(html) {
 if (typeof html!=="string") return null;
 const found=html.match(/<div\s+id="v2-static-test-result">([^<]*)<\/div>/);
 return found?.[1]??null;
}
module.exports={readStaticBrowserMarker};
