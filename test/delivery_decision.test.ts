import assert from "node:assert/strict";
import test from "node:test";
import { decideDelivery } from "../src/delivery_decision";

test("a stored creator asset enters processing and schedules its subscriber update", () => {
  assert.deepEqual(decideDelivery(true, 125), {
    asset_status: "processing",
    processing_job: "transcode-and-package",
    subscriber_update: "publish-when-ready",
  });
});

test("subscriber delivery stays on hold until storage confirms the object", () => {
  assert.deepEqual(decideDelivery(false, 125), {
    asset_status: "awaiting_upload",
    processing_job: null,
    subscriber_update: "hold",
  });
});
