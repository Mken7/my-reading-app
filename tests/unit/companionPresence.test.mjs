import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCompanionPresence, companionPresenceMessage,
} from "../../lib/v2/companionPresence.ts";

test("server says there is no companion without leaking a location", () => {
  assert.equal(classifyCompanionPresence([
    {partner_joined:false,partner_active:false},
  ]), "alone");
});
test("valid last-90-seconds activity is all the UI can express", () => {
  assert.equal(classifyCompanionPresence([
    {partner_joined:true,partner_active:true},
  ]), "online");
  assert.equal(classifyCompanionPresence([
    {partner_joined:true,partner_active:false},
  ]), "offline");
});
test("missing, revoked and malformed RPC results fail closed", () => {
  for (const value of [
    null, {}, [], [null], [1], [true], [false],
    [{partner_joined:true}], [{partner_active:true}],
    [{partner_joined:"true",partner_active:true}],
    [{partner_joined:false,partner_active:true}],
    [{partner_joined:true,partner_active:"false"}],
    [{partner_joined:true,partner_active:true}, {partner_joined:false,partner_active:false}],
  ]) {
    assert.equal(classifyCompanionPresence(value), "unavailable");
  }
});
test("presence never claims or reveals another reader's page or annotation", () => {
  for (const view of ["loading", "alone", "online", "offline", "unavailable"]) {
    const message = companionPresenceMessage(view);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 5);
    assert.doesNotMatch(message, /第\\d+段|chunk_index|char_offset|批注正文|章节\\d+/);
  }
});
