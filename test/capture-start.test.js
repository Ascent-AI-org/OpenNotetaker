import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCaptureStart } from "../src/domain/validation.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const at = (iso) => sanitizeCaptureStart(iso, { nowMs: NOW, maxAgeMs: 3 * 60 * 60 * 1000 });

test("keeps a sane past timestamp exactly as reported", () => {
  assert.equal(at("2026-08-27T11:15:00.000Z"), "2026-08-27T11:15:00.000Z");
});

test("falls back to now for a future stamp, because that is a broken worker clock", () => {
  assert.equal(at("2026-08-27T12:05:00.000Z"), new Date(NOW).toISOString());
});

test("falls back to now for a stamp older than any meeting could be", () => {
  assert.equal(at("2026-08-20T09:00:00.000Z"), new Date(NOW).toISOString());
});

test("falls back to now for junk, empty, and missing values", () => {
  for (const bad of ["", null, undefined, "not-a-date", "{}", 0, NaN]) {
    assert.equal(sanitizeCaptureStart(bad, { nowMs: NOW }), new Date(NOW).toISOString());
  }
});

test("accepts the boundary and rejects just past it", () => {
  const maxAgeMs = 60_000;
  const onEdge = new Date(NOW - maxAgeMs).toISOString();
  assert.equal(sanitizeCaptureStart(onEdge, { nowMs: NOW, maxAgeMs }), onEdge);
  const overEdge = new Date(NOW - maxAgeMs - 1).toISOString();
  assert.equal(sanitizeCaptureStart(overEdge, { nowMs: NOW, maxAgeMs }), new Date(NOW).toISOString());
});
