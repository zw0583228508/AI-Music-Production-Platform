import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harness = `/tmp/pedalboard-builtin-${process.pid}.mjs`;
await build({
  stdin: { contents: `export { processPedalboardBuiltinWav } from "./src/lib/pedalboardBuiltin";`,
    resolveDir: apiDirectory, sourcefile: "pedalboard-builtin-harness.ts" },
  bundle: true, platform: "node", format: "esm", outfile: harness,
});
const { processPedalboardBuiltinWav } = await import(pathToFileURL(harness).href);
after(() => unlink(harness).catch(() => undefined));

function wav() {
  const value = Buffer.alloc(48);
  value.write("RIFF", 0); value.writeUInt32LE(40, 4); value.write("WAVE", 8);
  value.write("fmt ", 12); value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22); value.writeUInt32LE(8000, 24); value.writeUInt32LE(16000, 28);
  value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write("data", 36);
  value.writeUInt32LE(4, 40); value.writeInt16LE(100, 44); value.writeInt16LE(-100, 46);
  return value;
}

async function withWorker(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.MUSIC_AI_WORKER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.MUSIC_AI_WORKER_TOKEN = "test-token";
  try { await run(); } finally {
    delete process.env.MUSIC_AI_WORKER_URL; delete process.env.MUSIC_AI_WORKER_TOKEN;
    await new Promise((resolve) => server.close(resolve));
  }
}

const health = { status: "ok", healthy: true, runtimeReady: true, packageReady: true,
  checkpointReady: true, smokeTested: true, provider: "PEDALBOARD_BUILTIN", modelVersion: "0.9.19" };

test("Pedalboard built-in client authenticates, validates, and records final-byte hashes", async () => {
  await withWorker((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    if (request.method === "GET") {
      assert.equal(request.url, "/health?provider=PEDALBOARD_BUILTIN");
      response.end(JSON.stringify(health)); return;
    }
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      assert.equal(payload.provider, "PEDALBOARD_BUILTIN");
      assert.equal(Buffer.from(payload.audio_base64, "base64").toString("hex"), wav().toString("hex"));
      response.end(JSON.stringify({ provider: "PEDALBOARD_BUILTIN", version: "0.9.19",
        format: "wav", encoding: "pcm_s16le", audio_base64: wav().toString("base64") }));
    });
  }, async () => {
    const result = await processPedalboardBuiltinWav(wav());
    assert.equal(result.data.toString("hex"), wav().toString("hex"));
    assert.equal(result.evidence.status, "processed");
    assert.match(result.evidence.inputSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.evidence.inputSha256, result.evidence.outputSha256);
  });
});

test("Pedalboard built-in client rejects malformed process audio", async () => {
  await withWorker((request, response) => {
    if (request.method === "GET") { response.end(JSON.stringify(health)); return; }
    response.end(JSON.stringify({ provider: "PEDALBOARD_BUILTIN", version: "0.9.19",
      format: "wav", encoding: "pcm_s16le", audio_base64: "not-base64!" }));
  }, () => assert.rejects(() => processPedalboardBuiltinWav(wav()), /invalid base64/));
});

test("Pedalboard built-in client fails closed without worker credentials", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.statusCode = 500;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.MUSIC_AI_WORKER_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.MUSIC_AI_WORKER_TOKEN;
  delete process.env.PEDALBOARD_BUILTIN_API_TOKEN;
  try {
    await assert.rejects(
      () => processPedalboardBuiltinWav(wav()),
      /authentication token is not configured/,
    );
    assert.equal(requests, 0);
  } finally {
    delete process.env.MUSIC_AI_WORKER_URL;
    await new Promise((resolve) => server.close(resolve));
  }
});