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
      import { logProductionJobEvent } from "./src/lib/productionJobLogger";

      class IntegrationWrapper {
        constructor() {
          this.safeKind = "custom-wrapper";
          this.inner = {
            signedUrl:
              "https://storage.example/wrapped.wav?token=wrapper-secret",
            credentials: {
              secret: "wrapper-credential-secret",
            },
            retryable: true,
          };
        }
      }

      const payload = {
        presignedUrl: "https://storage.example/root-private.wav?signature=root-presigned-secret",
        signedURL: "https://storage.example/root-signed.wav?signature=root-signed-url-secret",
        presignedURL: "https://storage.example/root-presigned.wav?signature=root-presigned-url-secret",
        preSignedURL: "https://storage.example/root-pre-signed.wav?signature=root-pre-signed-url-secret",
        accessToken: "root-access-token-secret",
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
          signedURL: "https://storage.example/nested-signed.wav?signature=nested-signed-url-secret",
          presignedUrl: "https://storage.example/private.flac?signature=presigned-secret",
          presignedURL: "https://storage.example/nested-presigned.wav?signature=nested-presigned-url-secret",
          preSignedURL: "https://storage.example/nested-pre-signed.wav?signature=nested-pre-signed-url-secret",
          downloadUrl: "https://storage.example/private.mp3?token=download-url-secret",
          downloadStatus: "ready",
        },
        upload: {
          uploadURL: "https://storage.example/upload?X-Goog-Credential=upload-secret",
          uploadUrl: "https://storage.example/upload-next?token=upload-url-secret",
          uploadBytes: 4096,
        },
        provider: {
          credentials: {
            clientId: "private-client",
            clientSecret: "credential-secret",
          },
          authorization: "Bearer provider-secret",
          accessToken: "access-token-secret",
          refresh_token: "refresh-token-secret",
          tokenCount: 2,
          credentialSource: "managed",
        },
        integrations: {
          wrapper: new IntegrationWrapper(),
          attempts: [
            {
              safeProvider: "storage-a",
              response: {
                links: {
                  signed_url: "https://storage.example/deep.wav?token=deep-secret",
                  expiresIn: 900,
                },
              },
            },
            {
              safeProvider: "storage-b",
              response: {
                auth: {
                  credentials: {
                    accessKey: "array-credential-secret",
                  },
                  region: "us-east-1",
                },
              },
            },
          ],
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
      };

      Object.freeze(payload.integrations.attempts[0].response.links);
      Object.freeze(payload.integrations.attempts[1].response.auth.credentials);
      const bindings = {
        integration: {
          provider: "storage-provider",
          connection: {
            signedUrl:
              "https://storage.example/binding.wav?token=binding-secret",
            credentials: {
              clientSecret: "binding-credential-secret",
            },
            region: "us-west-2",
          },
          attempts: [
            {
              authorization: "Bearer binding-authorization-secret",
              retryable: false,
            },
          ],
        },
      };
      Object.freeze(bindings.integration.connection.credentials);
      const integrationLogger = logger.child(bindings);
      const requestBindings = {
        requestContext: {
          operation: "provider_download",
          credentials: {
            accessToken: "child-binding-credential-secret",
          },
          traceId: "trace-safe-789",
        },
      };
      Object.freeze(requestBindings.requestContext.credentials);
      const requestLogger = integrationLogger.child(requestBindings);
      requestLogger.info(payload, "export_object_reclamation_summary");

      if (
        payload.integrations.attempts[0].response.links.signed_url !==
          "https://storage.example/deep.wav?token=deep-secret" ||
        payload.integrations.attempts[1].response.auth.credentials.accessKey !==
          "array-credential-secret" ||
        bindings.integration.connection.credentials.clientSecret !==
          "binding-credential-secret" ||
        requestBindings.requestContext.credentials.accessToken !==
          "child-binding-credential-secret"
      ) {
        throw new Error("logger mutated caller-owned data");
      }

      logProductionJobEvent("job-safe-789", "production_job_private_metadata", {
        downloadUrl: "https://storage.example/job-private.wav?token=job-download-secret",
        refreshToken: "job-refresh-token-secret",
        attempt: 2,
      });

      const providerError = new Error("provider request failed safely");
      providerError.accessToken = "error-access-token-secret";
      logger.error({
        err: providerError,
        recoveryStatus: "retrying",
      }, "provider_request_failure");
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
  assert.equal(entries.length, 3);

  const [entry, jobEntry, errorEntry] = entries;
  const serialized = JSON.stringify(entries);

  for (const secret of [
    "root-presigned-secret",
    "root-signed-url-secret",
    "root-presigned-url-secret",
    "root-pre-signed-url-secret",
    "root-access-token-secret",
    "download-secret",
    "nested-signed-url-secret",
    "upload-secret",
    "presigned-secret",
    "nested-presigned-url-secret",
    "nested-pre-signed-url-secret",
    "download-url-secret",
    "upload-url-secret",
    "private-client",
    "credential-secret",
    "provider-secret",
    "deep-secret",
    "array-credential-secret",
    "wrapper-secret",
    "wrapper-credential-secret",
    "access-token-secret",
    "refresh-token-secret",
    "job-download-secret",
    "job-refresh-token-secret",
    "error-access-token-secret",
    "request-secret",
    "request-cookie-secret",
    "response-cookie-secret",
    "binding-secret",
    "binding-credential-secret",
    "binding-authorization-secret",
    "child-binding-credential-secret",
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
  assert.equal(entry.presignedUrl, "[Redacted]");
  assert.equal(entry.signedURL, "[Redacted]");
  assert.equal(entry.presignedURL, "[Redacted]");
  assert.equal(entry.preSignedURL, "[Redacted]");
  assert.equal(entry.accessToken, "[Redacted]");
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
  assert.equal(entry.download.signedURL, "[Redacted]");
  assert.equal(entry.download.presignedUrl, "[Redacted]");
  assert.equal(entry.download.presignedURL, "[Redacted]");
  assert.equal(entry.download.preSignedURL, "[Redacted]");
  assert.equal(entry.download.downloadUrl, "[Redacted]");
  assert.equal(entry.download.downloadStatus, "ready");
  assert.equal(entry.upload.uploadURL, "[Redacted]");
  assert.equal(entry.upload.uploadUrl, "[Redacted]");
  assert.equal(entry.upload.uploadBytes, 4096);
  assert.equal(entry.provider.credentials, "[Redacted]");
  assert.equal(entry.provider.authorization, "[Redacted]");
  assert.equal(entry.provider.accessToken, "[Redacted]");
  assert.equal(entry.provider.refresh_token, "[Redacted]");
  assert.equal(entry.provider.tokenCount, 2);
  assert.equal(entry.provider.credentialSource, "managed");
  assert.equal(
    entry.integrations.attempts[0].response.links.signed_url,
    "[Redacted]",
  );
  assert.equal(entry.integrations.attempts[0].safeProvider, "storage-a");
  assert.equal(entry.integrations.attempts[0].response.links.expiresIn, 900);
  assert.equal(
    entry.integrations.attempts[1].response.auth.credentials,
    "[Redacted]",
  );
  assert.equal(entry.integrations.attempts[1].safeProvider, "storage-b");
  assert.equal(entry.integrations.attempts[1].response.auth.region, "us-east-1");
  assert.equal(entry.integrations.wrapper.inner.signedUrl, "[Redacted]");
  assert.equal(entry.integrations.wrapper.inner.credentials, "[Redacted]");
  assert.equal(entry.integrations.wrapper.safeKind, "custom-wrapper");
  assert.equal(entry.integrations.wrapper.inner.retryable, true);
  assert.equal(entry.integration.provider, "storage-provider");
  assert.equal(entry.integration.connection.signedUrl, "[Redacted]");
  assert.equal(entry.integration.connection.credentials, "[Redacted]");
  assert.equal(entry.integration.connection.region, "us-west-2");
  assert.equal(entry.integration.attempts[0].authorization, "[Redacted]");
  assert.equal(entry.integration.attempts[0].retryable, false);
  assert.equal(entry.requestContext.operation, "provider_download");
  assert.equal(entry.requestContext.credentials, "[Redacted]");
  assert.equal(entry.requestContext.traceId, "trace-safe-789");
  assert.equal(entry.req.headers.authorization, "[Redacted]");
  assert.equal(entry.req.headers.cookie, "[Redacted]");
  assert.equal(entry.res.headers["set-cookie"], "[Redacted]");
  assert.equal(jobEntry.msg, "production_job_private_metadata");
  assert.equal(jobEntry.jobId, "job-safe-789");
  assert.equal(jobEntry.downloadUrl, "[Redacted]");
  assert.equal(jobEntry.refreshToken, "[Redacted]");
  assert.equal(jobEntry.attempt, 2);
  assert.equal(errorEntry.msg, "provider_request_failure");
  assert.equal(errorEntry.recoveryStatus, "retrying");
  assert.equal(errorEntry.err.type, "Error");
  assert.equal(errorEntry.err.message, "provider request failed safely");
  assert.match(errorEntry.err.stack, /provider request failed safely/);
  assert.equal(errorEntry.err.accessToken, "[Redacted]");
});