import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = new URL(
  `./logger-redaction-${process.pid}.tmp.mjs`,
  import.meta.url,
).pathname;

await build({
  stdin: {
    contents: `
      import { logger } from "./src/lib/logger";

      logger.info({
        operation: "export_recovery",
        exportId: "export-safe-123",
        reclamation: {
          discovered: 7,
          reclaimed: 3,
          preservedReady: 4,
          failedDeletions: 0,
        },
        download: {
          signedUrl: "https://storage.example/private.wav?X-Goog-Signature=download-secret",
        },
        upload: {
          uploadURL: "https://storage.example/upload?X-Goog-Credential=upload-secret",
        },
        provider: {
          credentials: {
            clientId: "private-client",
            clientSecret: "credential-secret",
          },
          authorization: "Bearer provider-secret",
        },
        req: {
          headers: {
            authorization: "Bearer request-secret",
            cookie: "session=request-cookie-secret",
            "x-request-id": "request-safe-456",
          },
        },
        res: {
          headers: {
            "set-cookie": "session=response-cookie-secret",
          },
        },
      }, "export_object_reclamation_summary");
    `,
    resolveDir: apiDirectory,
    sourcefile: "logger-redaction-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: harnessPath,
  external: ["pino", "pino-pretty"],
});

after(() => unlink(harnessPath).catch(() => undefined));

test("serialized logs redact private URLs and credentials while preserving operational fields", () => {
  const result = spawnSync(process.execPath, [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      LOG_LEVEL: "info",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");

  const entries = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);

  const [entry] = entries;
  const serialized = JSON.stringify(entry);

  for (const secret of [
    "download-secret",
    "upload-secret",
    "private-client",
    "credential-secret",
    "provider-secret",
    "request-secret",
    "request-cookie-secret",
    "response-cookie-secret",
    "X-Goog-Signature",
    "X-Goog-Credential",
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      `serialized log exposed ${secret}`,
    );
  }

  assert.equal(entry.msg, "export_object_reclamation_summary");
  assert.equal(entry.operation, "export_recovery");
  assert.equal(entry.exportId, "export-safe-123");
  assert.equal(entry.req.headers["x-request-id"], "request-safe-456");
  assert.deepEqual(entry.reclamation, {
    discovered: 7,
    reclaimed: 3,
    preservedReady: 4,
    failedDeletions: 0,
  });
  assert.equal(entry.download.signedUrl, "[Redacted]");
  assert.equal(entry.upload.uploadURL, "[Redacted]");
  assert.equal(entry.provider.credentials, "[Redacted]");
  assert.equal(entry.provider.authorization, "[Redacted]");
  assert.equal(entry.req.headers.authorization, "[Redacted]");
  assert.equal(entry.req.headers.cookie, "[Redacted]");
  assert.equal(entry.res.headers["set-cookie"], "[Redacted]");
});