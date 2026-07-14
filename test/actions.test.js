import test from "node:test";
import assert from "node:assert/strict";
import { normalizeActionName } from "../src/actions.js";

test("normalizes supported online control actions", () => {
  assert.equal(normalizeActionName("undo"), "undo");
  assert.equal(normalizeActionName("new_game"), "new_game");
  assert.equal(normalizeActionName("reset"), "new_game");
  assert.equal(normalizeActionName("accept"), "accept");
  assert.equal(normalizeActionName("reject"), "reject");
});

test("rejects removed draw and resign actions", () => {
  assert.equal(normalizeActionName("draw"), null);
  assert.equal(normalizeActionName("resign"), null);
  assert.equal(normalizeActionName(null), null);
});
