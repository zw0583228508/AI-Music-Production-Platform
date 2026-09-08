import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

const bundleDirectoryPrefix = "music-studio-api-tests.";
const packageJsonUrl = new URL("../package.json", import.meta.url);
const focusedRunnerUrl = new URL(
  "../scripts/run-focused-api-tests.sh",
  import.meta.url,
);

test("every focused API bundle script uses the cleanup-safe runner", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
  const focusedScripts = Object.entries(packageJson.scripts).filter(([name]) =>
    /^test:(?:export|music-engines|validation|analysis-providers|gpu-promotion|source-ingestion|export-lineage|copilot|revisions)$/u.test(
      name,
    ),
  );

  assert.equal(focusedScripts.length, 9);
  for (const [name, command] of focusedScripts) {
    assert.match(
      command,
      /^sh \.\/scripts\/run-focused-api-tests\.sh [a-z-]+$/u,
      `${name} must delegate bundle isolation and cleanup to the shared runner`,
    );
  }

  const runner = await readFile(focusedRunnerUrl, "utf8");
  assert.match(runner, /\bmktemp -d \/tmp\/music-studio-api-tests\.XXXXXX\b/u);
  assert.match(runner, /\btrap 'rm -rf -- "\$tmpdir"' EXIT\b/u);
  assert.match(runner, /\btrap 'exit 143' TERM\b/u);
});

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
    const { NODE_TEST_CONTEXT: _parentTestContext, ...childEnv } = env;
    const child = spawn("pnpm", ["run", script], {
      cwd: new URL("..", import.meta.url),
      env: childEnv,
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

function interruptFocusedTestAfterBundles(script, env = process.env) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _parentTestContext, ...childEnv } = env;
    const child = spawn("pnpm", ["run", script], {
      cwd: new URL("..", import.meta.url),
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (
        !interrupted &&
        stderr.includes("focused API bundles ready for SIGTERM")
      ) {
        interrupted = true;
        process.kill(-child.pid, "SIGTERM");
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ script, code, signal, stdout, stderr, interrupted });
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

test(
  "esbuild failures remove their generated focused API bundle directory",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "esbuild",
    });

    assert.notEqual(
      result.code,
      0,
      "focused API test unexpectedly succeeded with an invalid esbuild input",
    );
    assert.match(
      result.stderr,
      /\[ERROR\] Could not resolve ".*intentional-missing-entry\.ts"/,
      [
        "focused API test did not fail inside esbuild as expected",
        result.signal ? `signal: ${result.signal}` : "",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `esbuild failure left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "later esbuild failures remove partially generated focused API bundle sets",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "later-esbuild",
    });

    assert.notEqual(
      result.code,
      0,
      "focused API test unexpectedly succeeded after its injected later esbuild failure",
    );
    assert.match(
      result.stderr,
      /focused API first bundle ready before later esbuild failure/,
      [
        "focused API test did not confirm that an earlier bundle was written",
        result.signal ? `signal: ${result.signal}` : "",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      result.stderr,
      /\[ERROR\] Could not resolve ".*intentional-missing-later-entry\.ts"/,
      [
        "focused API test did not fail in the intended later esbuild stage",
        result.signal ? `signal: ${result.signal}` : "",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `later esbuild failure left partially generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "different focused API esbuild failures clean up independently when run together",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const failingEnvironment = {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "esbuild",
    };
    const results = await Promise.all([
      runFocusedTest("test:validation", failingEnvironment),
      runFocusedTest("test:source-ingestion", failingEnvironment),
    ]);

    assert.equal(
      new Set(results.map(({ script }) => script)).size,
      2,
      "expected two distinct focused API scripts to fail concurrently",
    );
    for (const result of results) {
      assert.notEqual(
        result.code,
        0,
        `${result.script} unexpectedly succeeded with an invalid esbuild input`,
      );
      assert.match(
        result.stderr,
        /\[ERROR\] Could not resolve ".*intentional-missing-entry\.ts"/,
        [
          `${result.script} did not fail inside esbuild while a different focused check overlapped`,
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
      `different esbuild-failed focused API tests left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "focused API assertion failures after bundling remove their generated bundle directory",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "during-node-test",
    });

    assert.equal(
      result.code,
      1,
      [
        "focused API test did not fail through node --test",
        result.signal ? `signal: ${result.signal}` : "",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      result.stdout,
      /injected focused API assertion failure after bundling/,
      "focused API test did not report the intended assertion failure",
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `assertion-failed focused API test left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "simultaneous focused API assertion failures remove every generated bundle directory",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const failingEnvironment = {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "during-node-test",
    };
    const results = await Promise.all([
      runFocusedTest("test:validation", failingEnvironment),
      runFocusedTest("test:validation", failingEnvironment),
      runFocusedTest("test:validation", failingEnvironment),
    ]);

    for (const result of results) {
      assert.equal(
        result.code,
        1,
        [
          `${result.script} did not fail through node --test while focused checks overlapped`,
          result.signal ? `signal: ${result.signal}` : "",
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      assert.match(
        result.stdout,
        /injected focused API assertion failure after bundling/,
        [
          `${result.script} failed for an unexpected reason while focused checks overlapped`,
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
      `simultaneous assertion-failed focused API tests left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "different focused API assertion failures clean up independently when run together",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const failingEnvironment = {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "during-node-test",
    };
    const results = await Promise.all([
      runFocusedTest("test:validation", failingEnvironment),
      runFocusedTest("test:source-ingestion", failingEnvironment),
    ]);

    assert.equal(
      new Set(results.map(({ script }) => script)).size,
      2,
      "expected two distinct focused API scripts to fail concurrently",
    );
    for (const result of results) {
      assert.equal(
        result.code,
        1,
        [
          `${result.script} did not fail through node --test while a different focused check overlapped`,
          result.signal ? `signal: ${result.signal}` : "",
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      assert.match(
        result.stdout,
        /injected focused API assertion failure after bundling/,
        [
          `${result.script} failed for an unexpected reason while a different focused check overlapped`,
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
      `different assertion-failed focused API tests left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "SIGTERM after bundling removes the interrupted focused API bundle directory",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const result = await interruptFocusedTestAfterBundles("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "await-sigterm",
    });

    assert.equal(
      result.interrupted,
      true,
      [
        "focused API test never reached the post-bundle interruption point",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      result.signal,
      "SIGTERM",
      [
        "focused API test did not terminate through the intended SIGTERM path",
        `exit code: ${result.code}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      result.stderr,
      /focused API bundles ready for SIGTERM/,
      "focused API test was interrupted before its bundles existed",
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `SIGTERM-interrupted focused API test left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);