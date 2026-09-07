export const CLAMP3_SOURCE_REVISION = "9016d2b0c8d12d1aa79c2e0ab201e6822bdc83a8";
export const CLAMP3_MODEL_REVISION = "355625cc1c6f73726bbcd0eb9276ac7152d56426";
export const CLAMP3_ASSET_INVENTORY_SHA256 = "7ef3b9b9999a9f5d8c87a6aaade8fb031844c8b7b7f8c4444958aadebcc92103";
export const CLAMP3_SOURCE_TREE_SHA256 = "3845250edf79a8749f8862bf8683953e801b838614579a9b240c72980a14f54b";
export const CLAMP3_RUNTIME_IDENTITY_SHA256 = "12fb9b2b668e5d0fb7b86c029ea07c03d7d248371553d1aeba26b7c1ba2f2087";
export const CLAMP3_CHECKPOINT_BINDING_SHA256 = "5033f868e3977be3945ee416b5a1718d5589a173c7ba8982231d8c94a6441d80";
export const CLAMP3_RUNTIME_ADAPTER_SHA256 = "c59ff9dea565a01b2a81a29fb10030adaed87c81411fa6d2f32a34d5bd9d4112";

export function clamp3HealthAttestationValid(
  responseOk: boolean,
  payload: Record<string, unknown>,
): boolean {
  return responseOk
    && payload.ready === true
    && payload.smokeTested === true
    && payload.classification === "RESEARCH_READY"
    && payload.sourceRevision === CLAMP3_SOURCE_REVISION
    && payload.modelRevision === CLAMP3_MODEL_REVISION
    && payload.assetInventorySha256 === CLAMP3_ASSET_INVENTORY_SHA256
    && payload.sourceTreeSha256 === CLAMP3_SOURCE_TREE_SHA256
    && payload.runtimeIdentitySha256 === CLAMP3_RUNTIME_IDENTITY_SHA256
    && payload.checkpointBindingSha256 === CLAMP3_CHECKPOINT_BINDING_SHA256
    && payload.effectiveUid === 10001
    && payload.effectiveGid === 10001
    && payload.runtimeUser === "clamp3"
    && payload.networkAtRuntime === false
    && payload.networkIsolation === "modal-block-network-v1"
    && payload.runtimeAdapterSha256 === CLAMP3_RUNTIME_ADAPTER_SHA256;
}

export type Clamp3Runtime = { endpoint: string; token: string };
export type Clamp3ForwardResult = {
  status: number;
  payload: Record<string, unknown>;
  valid: boolean;
};

export async function fetchAttestedClamp3Health(
  runtime: Clamp3Runtime,
  fetcher: typeof fetch = fetch,
): Promise<Clamp3ForwardResult> {
  const response = await fetcher(new URL("/health", runtime.endpoint), {
    headers: { Authorization: `Bearer ${runtime.token}` },
    signal: AbortSignal.timeout(300_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  return {
    status: response.status,
    payload,
    valid: clamp3HealthAttestationValid(response.ok, payload),
  };
}

export async function forwardAttestedClamp3Similarity(
  runtime: Clamp3Runtime,
  body: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Clamp3ForwardResult> {
  const health = await fetchAttestedClamp3Health(runtime, fetcher);
  if (!health.valid) {
    return {
      status: 503,
      payload: { error: "CLAMP3 runtime identity or readiness attestation is invalid" },
      valid: false,
    };
  }
  const response = await fetcher(new URL("/v1/similarity", runtime.endpoint), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  return {
    status: response.status,
    payload: await response.json() as Record<string, unknown>,
    valid: true,
  };
}