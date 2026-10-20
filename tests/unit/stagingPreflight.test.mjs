import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

const dir=path.dirname(fileURLToPath(import.meta.url));
const script=path.resolve(dir,"../staging/run-supabase-e2e.mjs");
const ref="abcdefghijklmnopqrst";
const env={
 PATH:process.env.PATH??"",
 HOME:process.env.HOME??"",
 V2_ALLOW_MUTATING_STAGING_TEST:"I_CONFIRM_ISOLATED_STAGING_ONLY",
 V2_STAGING_URL:"https://"+ref+".supabase.co",
 V2_STAGING_PROJECT_REF:ref,
 V2_STAGING_PUBLISHABLE_KEY:"sb_publishable_fake_value_not_a_key_12345",
 V2_STAGING_OWNER_EMAIL:"owner@staging.invalid",
 V2_STAGING_OWNER_PASSWORD:"fake-and-private-1234",
 V2_STAGING_PARTNER_EMAIL:"partner@staging.invalid",
 V2_STAGING_PARTNER_PASSWORD:"different-private-1234",
 V2_STAGING_OUTSIDER_EMAIL:"outsider@staging.invalid",
 V2_STAGING_OUTSIDER_PASSWORD:"longest-private-1234",
};
const run=(overrides={})=>spawnSync(process.execPath,[script],{
 env:{...env,...overrides},encoding:"utf8",timeout:10000,
});
test("staging E2E requires an exact human-confirmed mutation opt-in",()=>{
 const result=run({V2_ALLOW_MUTATING_STAGING_TEST:""});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/No mutation without explicit isolated-staging opt-in/);
});
test("staging E2E cannot be pointed at old production project",()=>{
 const result=run({
  V2_STAGING_URL:"https://warhfmpfnlgzofbeuikb.supabase.co",
  V2_STAGING_PROJECT_REF:"warhfmpfnlgzofbeuikb",
 });
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/production project blocked/);
});
test("staging E2E cannot mutate using an administrator publishable key",()=>{
 const result=run({V2_STAGING_PUBLISHABLE_KEY:"sb_secret_example_admin_key"});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Only a staging publishable\/anon key/);
});
test("staging requires three distinct test accounts, no real credentials in logs",()=>{
 const result=run({
  V2_STAGING_OUTSIDER_EMAIL:env.V2_STAGING_OWNER_EMAIL,
 });
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/All accounts must be distinct/);
 assert.doesNotMatch(result.stderr,/(fake-and-private-1234|different-private-1234|longest-private-1234)/);
});
