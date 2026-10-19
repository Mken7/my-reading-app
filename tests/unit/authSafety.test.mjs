import test from "node:test";
import assert from "node:assert/strict";
import {
  validStagingEndpoint,recoveryReturnUrl,validNewPassword,authEventView,
} from "../../lib/v2/authSafety.ts";

test("only isolated HTTPS Supabase staging project root is permitted",()=>{
  assert.equal(validStagingEndpoint("https://testing-project.supabase.co"),true);
  assert.equal(validStagingEndpoint("https://testing-project.supabase.co/"),true);
  for(const input of [undefined,"","http://staging.supabase.co",
    "https://warhfmpfnlgzofbeuikb.supabase.co",
    "https://warhfmpfnlgzofbeuikb.supabase.co.evil.tld",
    "https://staging.supabase.co.evil.com",
    "https://user:secret@staging.supabase.co",
    "https://staging.supabase.co:444",
    "https://staging.supabase.co/api",
    "https://staging.supabase.co/?redirect=https://evil.com",
    "https://staging.supabase.co/#token"]){
    assert.equal(validStagingEndpoint(input),false,String(input));
  }
});

test("password reset redirect preserves only known current V2 route",()=>{
  assert.equal(recoveryReturnUrl("https://app.example.org/v2/?code=secret#token=hidden"),
    "https://app.example.org/v2/");
  assert.equal(recoveryReturnUrl("https://example.github.io/my-reading-app/v2/?code=abc"),
    "https://example.github.io/my-reading-app/v2/");
  assert.equal(recoveryReturnUrl("http://localhost:3000/v2/?code=abc"),
    "http://localhost:3000/v2/");
  for(const input of ["http://untrusted.example.com/v2/", "https://evil.com/v2//phish",
    "https://user:pass@example.com/v2/",
    "https://app.example.org/profile?redirect=/v2",
    "https://app.example.org/book/v2/more",
    "javascript:alert(1)","/v2","not an url"]){
    assert.equal(recoveryReturnUrl(input),null,input);
  }
});
test("password policy never permits short or NUL passwords",()=>{
  for(const candidate of ["", "12345678","a".repeat(11),
    "a".repeat(129),"a".repeat(20)+"\u0000"]){
    assert.equal(validNewPassword(candidate),false);
  }
  assert.equal(validNewPassword("a".repeat(12)),true);
  assert.equal(validNewPassword("a".repeat(128)),true);
});
test("reset form is reachable only through the actual PASSWORD_RECOVERY auth event",()=>{
  assert.equal(authEventView("SIGNED_IN",false),"normal");
  assert.equal(authEventView("INITIAL_SESSION",false),"normal");
  assert.equal(authEventView("TOKEN_REFRESHED",false),"normal");
  assert.equal(authEventView("PASSWORD_RECOVERY",false),"password_reset");
  assert.equal(authEventView("TOKEN_REFRESHED",true),"password_reset");
  assert.equal(authEventView("SIGNED_OUT",true),"signed_out");
});
