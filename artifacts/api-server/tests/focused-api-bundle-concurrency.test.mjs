import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

const bundleDirectoryPrefix = "music-studio-api-tests.";

async function listBundleDirectories() {
  return new Set(
    (await readdir(tmpdir(), { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(bundleDirectoryPrefix),
      )
      .map((entry) => entry.name),
  );
}

function runFocusedTest(script, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", script], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ script, code, signal, stdout, stderr });
    });
  });
}

test(
  "focused API test bundles remain isolated and clean under concurrency",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const results = await Promise.all([
      runFocusedTest("test:validation"),
      runFocusedTest("test:validation"),
      runFocusedTest("test:source-ingestion"),
    ]);

    for (const result of results) {
      assert.equal(
        result.code,
        0,
        [
          `${result.script} failed while focused API tests overlapped`,
          result.signal ? `signal: ${result.signal}` : "",
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `focused API tests left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "failed focused API tests remove their generated bundle directory",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "after-tempdir",
    });

    assert.equal(
      result.code,
      73,
      [
        "focused API test did not fail with the injected exit code",
        result.signal ? `signal: ${result.signal}` : "",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      result.stderr,
      /injected focused API failure after tempdir creation/,
      "focused API test failed for an unexpected reason",
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `failed focused API test left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);