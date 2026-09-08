import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const bundlePath = `/tmp/native-renderers-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export { PedalboardRenderer, SfzRenderer, performedMaterialSha256 } from "./src/lib/musicEngines";
      export { validateNativeRenderSamples } from "./src/lib/exportEngine";
    `,
    resolveDir: apiDirectory,
    sourcefile: "native-renderers-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});
const { PedalboardRenderer, SfzRenderer, performedMaterialSha256, validateNativeRenderSamples } =
  await import(pathToFileURL(bundlePath).href);

after(async () => {
  delete process.env.PEDALBOARD_VST3_API_URL;
  await unlink(bundlePath).catch(() => undefined);
});

function wavBase64(sampleRate, durationSeconds) {
  const frames = sampleRate * durationSeconds;
  const samples = frames * 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(Math.sin(frame * 0.1) * 5000);
    wav.writeInt16LE(value, 44 + frame * 4);
    wav.writeInt16LE(value, 46 + frame * 4);
  }
  return wav.toString("base64");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const trackModel = {
  id: "native-track",
  instrument: "strings",
  role: "harmony",
  instrumentDefinition: {
    family: "strings",
    playableRange: { min: 55, max: 103 },
    constraints: { minNoteDuration: 0.1 },
  },
  notes: [{ id: "n1", start: 0, duration: 0.8, pitch: 60, velocity: 96 }],
  cc: [],
  articulations: [],
  automation: [],
  mapping: null,
};

const asset = {
  id: "licensed-orchestra",
  identity: "Vendor / Orchestra / 1.0",
  sha256: "a".repeat(64),
  licenseOwner: "Test Organization",
  licenseReference: "test-license-record",
  rendererIdentity: "Test VST3 MIDI Host / 1.0",
  rendererSha256: "c".repeat(64),
};

function respondHealth(response) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    contractVersion: "1.0",
    healthy: true,
    runtimeReady: true,
    smokeTested: true,
    provider: "VST3",
    modelVersion: "pedalboard-0.9.19",
    runtimeIdentity: "music-ai-worker/python-3.11/pedalboard-0.9.19",
    asset,
    smokeEvidence: {
      assetId: asset.id,
      sha256: asset.sha256,
      trackModelRendered: true,
      audible: true,
      canonicalSensitivity: true,
      nativeHostAttested: true,
      outputSha256: "b".repeat(64),
      rendererSha256: asset.rendererSha256,
    },
  }));
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  process.env.PEDALBOARD_VST3_API_URL = `http://127.0.0.1:${port}`;
  try {
    await run();
  } finally {
    delete process.env.PEDALBOARD_VST3_API_URL;
    await new Promise((resolve) => server.close(resolve));
  }
}

test("VST3 adapter renders the exact canonical TrackModel with asset attestation", async () => {
  await withServer((request, response) => {
    if (request.method === "GET") {
      respondHealth(response);
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      assert.equal(payload.provider, "VST3");
      assert.equal(payload.trackModel.id, trackModel.id);
      assert.equal(payload.sampleRate, 8000);
      const audio_base64 = wavBase64(8000, 1);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        contractVersion: "1.0",
        provider: "VST3",
        trackModelId: trackModel.id,
        trackModelSha256: sha256(canonicalJson(trackModel)),
        outputSha256: sha256(Buffer.from(audio_base64, "base64")),
        performedMaterialSha256: performedMaterialSha256(trackModel),
        sampleRate: 8000,
        frameCount: 8000,
        durationSeconds: 1,
        version: "licensed-orchestra",
        asset,
        audio_base64,
      }));
    });
  }, async () => {
    const rendered = await new PedalboardRenderer().renderAttested(trackModel, 8000, 1);
    assert.equal(rendered.samples.length, 16000);
    assert.equal(rendered.attestation.assetIdentity, asset.identity);
    assert.equal(rendered.attestation.rendererIdentity, asset.rendererIdentity);
    assert.equal(
      rendered.attestation.rendererOutputSha256,
      sha256(Buffer.from(wavBase64(8000, 1), "base64")),
    );
    assert.deepEqual(validateNativeRenderSamples(rendered.samples, 16000), []);
  });
});

test("native sample validation rejects silence, clipping, and non-finite audio", () => {
  assert.match(validateNativeRenderSamples(new Float32Array(200), 200).join(" "), /silent/);
  const clipped = new Float32Array(200).fill(1);
  assert.match(validateNativeRenderSamples(clipped, 200).join(" "), /clipping/);
  const invalid = new Float32Array(200).fill(0.1);
  invalid[10] = Number.NaN;
  assert.match(validateNativeRenderSamples(invalid, 200).join(" "), /non-finite/);
});

test("renderer refuses audio whose attestation names another TrackModel", async () => {
  await withServer((_request, response) => {
    if (_request.method === "GET") {
      respondHealth(response);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      contractVersion: "1.0",
      provider: "VST3",
      trackModelId: "another-track",
      asset,
      performedMaterialSha256: performedMaterialSha256(trackModel),
      sampleRate: 8000,
      frameCount: 8000,
      durationSeconds: 1,
      audio_base64: wavBase64(8000, 1),
    }));
  }, async () => {
    await assert.rejects(
      () => new PedalboardRenderer().render(trackModel, 8000, 1),
      /incomplete attestation/,
    );
  });
});

test("renderer refuses an output checksum that does not match the returned WAV", async () => {
  await withServer((request, response) => {
    if (request.method === "GET") {
      respondHealth(response);
      return;
    }
    const audio_base64 = wavBase64(8000, 1);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      contractVersion: "1.0",
      provider: "VST3",
      trackModelId: trackModel.id,
      trackModelSha256: sha256(canonicalJson(trackModel)),
      outputSha256: "d".repeat(64),
      performedMaterialSha256: performedMaterialSha256(trackModel),
      sampleRate: 8000,
      frameCount: 8000,
      durationSeconds: 1,
      asset,
      audio_base64,
    }));
  }, async () => {
    await assert.rejects(
      () => new PedalboardRenderer().render(trackModel, 8000, 1),
      /output checksum did not match/,
    );
  });
});

test("renderer refuses a TrackModel checksum that does not match the request", async () => {
  await withServer((request, response) => {
    if (request.method === "GET") {
      respondHealth(response);
      return;
    }
    const audio_base64 = wavBase64(8000, 1);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      contractVersion: "1.0",
      provider: "VST3",
      trackModelId: trackModel.id,
      trackModelSha256: "e".repeat(64),
      outputSha256: sha256(Buffer.from(audio_base64, "base64")),
      performedMaterialSha256: performedMaterialSha256(trackModel),
      sampleRate: 8000,
      frameCount: 8000,
      durationSeconds: 1,
      asset,
      audio_base64,
    }));
  }, async () => {
    await assert.rejects(
      () => new PedalboardRenderer().render(trackModel, 8000, 1),
      /incomplete attestation/,
    );
  });
});

test("renderer refuses unattested raw WAV responses", async () => {
  await withServer((request, response) => {
    if (request.method === "GET") {
      respondHealth(response);
      return;
    }
    response.writeHead(200, { "Content-Type": "audio/wav" });
    response.end(Buffer.from(wavBase64(8000, 1), "base64"));
  }, async () => {
    await assert.rejects(
      () => new PedalboardRenderer().render(trackModel, 8000, 1),
      /unattested audio/,
    );
  });
});