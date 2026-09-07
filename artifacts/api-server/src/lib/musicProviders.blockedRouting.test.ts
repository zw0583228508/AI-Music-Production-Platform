import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderRegistry,
  MUSIC_PROVIDERS,
  ProviderUnavailableError,
  runArrangementProvider,
  type ArrangementProviderInput,
  type ProviderGenerationInput,
} from "./musicProviders";

const blockedProviderIds = ["MIDI_SAG", "MUSE_CONTROL_LITE"] as const;
const savedEnvironment = new Map<string, string | undefined>();
const endpointEnvironment = {
  MIDI_SAG_API_URL: "https://midi-sag.example.test",
  MIDI_SAG_API_TOKEN: "midi-sag-token",
  MUSE_CONTROL_LITE_API_URL: "https://muse-control-lite.example.test",
  MUSE_CONTROL_LITE_API_TOKEN: "muse-control-lite-token",
  MUSIC_PROVIDER_MIDI_SAG_URL: "https://gateway.example.test/midi-sag",
  MUSIC_PROVIDER_MIDI_SAG_TOKEN: "midi-sag-gateway-token",
  MUSIC_PROVIDER_MUSE_CONTROL_LITE_URL: "https://gateway.example.test/muse-control-lite",
  MUSIC_PROVIDER_MUSE_CONTROL_LITE_TOKEN: "muse-control-lite-gateway-token",
  MUSIC_PROVIDER_GATEWAY_URL: "https://gateway.example.test",
  MUSIC_PROVIDER_GATEWAY_TOKEN: "gateway-token",
  MUSIC_AI_WORKER_TOKEN: "worker-token",
} as const;

function configureEndpoints(): () => void {
  for (const [key, value] of Object.entries(endpointEnvironment)) {
    savedEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const key of Object.keys(endpointEnvironment)) {
      const value = savedEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnvironment.clear();
  };
}

test("blocked MIDI-SAG providers remain unavailable and never route configured endpoints", async () => {
  const restoreEnvironment = configureEndpoints();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("blocked providers must not fetch");
  };

  try {
    for (const providerId of blockedProviderIds) {
      const descriptor = MUSIC_PROVIDERS.find((candidate) => candidate.id === providerId);
      assert.ok(descriptor);
      assert.equal(descriptor.status, "unavailable");
      assert.match(descriptor.notes, /BLOCKED_(UPSTREAM|MISSING_LICENSED_ASSET)/);
      assert.match(descriptor.license ?? "", /BLOCKED_|unresolved/i);

      await assert.rejects(
        runArrangementProvider(descriptor, {} as ArrangementProviderInput),
        (error: unknown) =>
          error instanceof ProviderUnavailableError &&
          error.message.includes(
            providerId === "MIDI_SAG"
              ? "BLOCKED_UPSTREAM"
              : "BLOCKED_MISSING_LICENSED_ASSET",
          ),
      );
    }

    const registry = createProviderRegistry();
    for (const providerId of blockedProviderIds) {
      const provider = registry.find((candidate) => candidate.definition.id === providerId);
      assert.ok(provider);
      assert.equal(
        provider.definition.modelVersion,
        providerId === "MIDI_SAG"
          ? "midi-sag-b79839ed0cdd0b5e5f39d4cc4a80fcc90002d32f"
          : "UNVERIFIED",
      );
      assert.equal(provider.available, false);
      assert.equal(provider.readiness.availability, "unavailable");
      assert.equal(provider.readiness.configurationReady, false);
      const readiness = await provider.checkHealth(true);
      assert.equal(readiness.availability, "unavailable");
      assert.equal(readiness.configurationReady, false);
      await assert.rejects(
        provider.generate({} as ProviderGenerationInput),
        ProviderUnavailableError,
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});