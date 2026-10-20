/** Extract only a rendered DOM assertion node, never source-code strings.
 * Chrome --dump-dom includes inline <script> source: searching the whole
 * response for "PASS" can accidentally pass a test that never executed. */
export function readStaticBrowserMarker(html) {
 if (typeof html!=="string") return null;
 const found=html.match(/<div\s+id="v2-static-test-result">([^<]*)<\/div>/);
 return found?.[1]??null;
}
