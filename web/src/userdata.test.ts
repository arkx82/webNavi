import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, retryAfterMs } from "./userdata";

test("on login the server's copy comes down, unless this browser has a change the server never got", () => {
  // The usual: the server has it, so does storage, all sent: the server's wins.
  assert.equal(merge({ server: true, local: true, dirty: false, mayUpload: true }), "server");
  // Saved offline, or the page closed before the send: the local change goes up, not under.
  assert.equal(merge({ server: true, local: true, dirty: true, mayUpload: true }), "push");
  assert.equal(merge({ server: false, local: true, dirty: true, mayUpload: true }), "push");
  // Storage from before logins existed is uploaded by the first user to log in, and only by them.
  assert.equal(merge({ server: false, local: true, dirty: false, mayUpload: true }), "push");
  assert.equal(merge({ server: false, local: true, dirty: false, mayUpload: false }), "keep");
  assert.equal(merge({ server: true, local: true, dirty: true, mayUpload: false }), "server");
  // Nothing anywhere, or a local value that would not parse: nothing to do.
  assert.equal(merge({ server: false, local: false, dirty: false, mayUpload: true }), "keep");
  assert.equal(merge({ server: false, local: false, dirty: true, mayUpload: true }), "keep");
  assert.equal(merge({ server: true, local: false, dirty: true, mayUpload: true }), "server");
});

test("a failed send is tried again after 2 s, then 4, 8 … and at most a minute", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(retryAfterMs), [2000, 4000, 8000, 16000, 32000]);
  assert.equal(retryAfterMs(6), 60_000);
  assert.equal(retryAfterMs(20), 60_000);
  assert.equal(retryAfterMs(0), 2000);
});
