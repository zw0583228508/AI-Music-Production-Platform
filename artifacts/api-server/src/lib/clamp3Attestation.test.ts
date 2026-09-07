import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAMP3_MODEL_REVISION,
  CLAMP3_ASSET_INVENTORY_SHA256,
  CLAMP3_CHECKPOINT_BINDING_SHA256,
  CLAMP3_RUNTIME_IDENTITY_SHA256,
  CLAMP3_RUNTIME_ADAPTER_SHA256,
  CLAMP3_SOURCE_REVISION,
  CLAMP3_SOURCE_TREE_SHA256,
  clamp3HealthAttestationValid,
  forwardAttestedClamp3Similarity,
} from "./clamp3Attestation";

const healthy = {
  ready: true,
  smokeTested: true,
  classification: "RESEARCH_READY",
  sourceRevision: CLAMP3_SOURCE_REVISION,
  modelRevision: CLAMP3_MODEL_REVISION,
  assetInventorySha256: CLAMP3_ASSET_INVENTORY_SHA256,
  sourceTreeSha256: CLAMP3_SOURCE_TREE_SHA256,
  runtimeIdentitySha256: CLAMP3_RUNTIME_IDENTITY_SHA256,
  checkpointBindingSha256: CLAMP3_CHECKPOINT_BINDING_SHA256,
  effectiveUid: 10001,
  effectiveGid: 10001,
  runtimeUser: "clamp3",
  networkAtRuntime: false,
  networkIsolation: "modal-block-network-v1",
  runtimeAdapterSha256: CLAMP3_RUNTIME_ADAPTER_SHA256,
};

test("accepts the exact research-ready CLaMP3 health identity", () => {
  assert.equal(clamp3HealthAttestationValid(true, healthy), true);
});

test("rejects readiness and immutable identity drift", () => {
  for (const [field, value] of [
    ["ready", false],
    ["smokeTested", false],
    ["classification", "READY"],
    ["sourceRevision", "wrong"],
    ["modelRevision", "wrong"],
    ["assetInventorySha256", "wrong"],
    ["sourceTreeSha256", "wrong"],
    ["runtimeIdentitySha256", "wrong"],
    ["checkpointBindingSha256", "wrong"],
    ["effectiveUid", 0],
    ["effectiveGid", 0],
    ["runtimeUser", "root"],
    ["networkAtRuntime", true],
    ["networkIsolation", "unverified"],
    ["runtimeAdapterSha256", "wrong"],
  ] as const) {
    assert.equal(
      clamp3HealthAttestationValid(true, { ...healthy, [field]: value }),
      false,
      field,
    );
  }
  assert.equal(clamp3HealthAttestationValid(false, healthy), false);
});

test("identity drift sends zero similarity POSTs", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
    });
    return new Response(JSON.stringify({ ...healthy, modelRevision: "drifted" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const result = await forwardAttestedClamp3Similarity(
    { endpoint: "https://clamp3.invalid", token: "test-token" },
    { left: {}, right: {} },
    fetcher,
  );
  assert.equal(result.status, 503);
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
  assert.equal(calls.some((call) => call.url.endsWith("/v1/similarity")), false);
});