/** Auth UX and isolation rules for the opt-in V2 Supabase staging preview.
 * No auth tokens, passwords or recovery links are cached here.
 */
const PROJECT_HOST=/^[a-z0-9-]+\.supabase\.co$/;
const FORBIDDEN_PROJECT="warhfmpfnlgzofbeuikb";

/** Only a literal isolated Supabase project endpoint is allowed.
 * Avoid accepting password-bearing URLs, arbitrary hosts, or legacy projects.
 */
export function validStagingEndpoint(raw:string|undefined):boolean{
  if(!raw)return false;
  try{
    const parsed=new URL(raw);
    return parsed.protocol==="https:" &&
      PROJECT_HOST.test(parsed.hostname) &&
      parsed.hostname!==FORBIDDEN_PROJECT+".supabase.co" &&
      !parsed.username && !parsed.password && !parsed.port &&
      (parsed.pathname==="/" || parsed.pathname==="") &&
      !parsed.search && !parsed.hash;
  }catch{return false;}
}

/** Constrain password reset redirects to this app's already-open /v2 route.
 * GitHub Pages may prefix exactly one repository segment before /v2.
 * Strip all query/hash fragments so an attacker cannot inject a redirect.
 */
export function recoveryReturnUrl(current:string):string|null{
  try{
    const url=new URL(current);
    if((url.protocol!=="https:" &&
        !(url.protocol==="http:" && ["localhost","127.0.0.1"].includes(url.hostname))) ||
      url.username || url.password ||
      !/^\/(?:[a-zA-Z0-9._-]+\/)?v2\/?$/.test(url.pathname))return null;
    return url.origin+url.pathname;
  }catch{return null;}
}

export function validNewPassword(value:string):boolean{
  // Supabase settings may be stricter; UI bounds are not server-side policy.
  return value.length>=12 && value.length<=128 && !value.includes("\u0000");
}

export type AuthView="login"|"signup"|"reset";
export function authEventView(
  event:string, authorizedRecovery:boolean,
):"password_reset"|"signed_out"|"normal"{
  if(event==="PASSWORD_RECOVERY")return "password_reset";
  if(event==="SIGNED_OUT")return "signed_out";
  return authorizedRecovery?"password_reset":"normal";
}
