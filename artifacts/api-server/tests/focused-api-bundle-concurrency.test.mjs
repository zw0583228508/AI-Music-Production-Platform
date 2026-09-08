import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

const bundleDirectoryPrefix = "music-studio-api-tests.";
const packageJsonUrl = new URL("../package.json", import.meta.url);

function findBundledFocusedScripts(scripts) {
  return Object.entries(scripts).filter(([, command]) =>
    /\besbuild\s/u.test(command),
  );
}

function auditBundledFocusedScript(name, command) {
  const errors = [];
  const tempDirectoryAssignment = command.match(
    /\b([A-Za-z_][A-Za-z0-9_]*)=\$\(mktemp -d ([^)]*)\)/u,
  );

  if (!tempDirectoryAssignment) {
    errors.push("must create its bundle directory with mktemp -d");
    return errors.map((error) => `${name}: ${error}`);
  }

  const [, variable, template] = tempDirectoryAssignment;
  if (!/X{6,}(?:["']?\s*)$/u.test(template)) {
    errors.push("must use a unique mktemp template ending in at least six Xs");
  }

  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const outputPattern = new RegExp(
    String.raw`--outfile=(?:"\$\{?${escapedVariable}\}?/|'\$\{?${escapedVariable}\}?/|\$\{?${escapedVariable}\}?/)`,
    "u",
  );
  const bundleCommands = command
    .split(/\s*&&\s*/u)
    .filter((part) => /^\s*esbuild(?:\s|$)/u.test(part));

  if (bundleCommands.length === 0) {
    errors.push("must expose each esbuild invocation as a command segment");
  }
  for (const bundleCommand of bundleCommands) {
    if (!outputPattern.test(bundleCommand)) {
      errors.push(
        `must write every bundle below the unique $${variable} directory: ${bundleCommand}`,
      );
    }
  }

  const cleanupTrap = command.match(/\btrap\s+(.+?)\s+EXIT\b/u)?.[1];
  const cleanupVariablePattern = new RegExp(
    String.raw`\$\{?${escapedVariable}\}?`,
    "u",
  );
  if (
    !cleanupTrap ||
    !/\brm\s+-rf\b/u.test(cleanupTrap) ||
    !cleanupVariablePattern.test(cleanupTrap)
  ) {
    errors.push(`must install an EXIT trap that removes $${variable}`);
  }

  return errors.map((error) => `${name}: ${error}`);
}

test("every focused API bundle script uses isolated temporary output", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
  const bundledScripts = findBundledFocusedScripts(packageJson.scripts);

  assert.ok(
    bundledScripts.length > 0,
    "expected to discover focused API scripts that generate bundles",
  );

  const errors = bundledScripts.flatMap(([name, command]) =>
    auditBundledFocusedScript(name, command),
  );
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("focused API bundle audit rejects each unsafe path pattern", () => {
  const unsafeScripts = {
    "test:fixed-output":
      "esbuild src/example.test.ts --bundle --outfile=/tmp/example.test.mjs",
    "test:shared-directory":
      "sh -c 'tmpdir=$(mktemp -d /tmp/music-studio-api-tests) && trap \"rm -rf \\\"$tmpdir\\\"\" EXIT && esbuild src/example.test.ts --bundle --outfile=\"$tmpdir/example.test.mjs\"'",
    "test:missing-cleanup":
      "sh -c 'tmpdir=$(mktemp -d /tmp/music-studio-api-tests.XXXXXX) && esbuild src/example.test.ts --bundle --outfile=\"$tmpdir/example.test.mjs\"'",
  };

  const errors = findBundledFocusedScripts(unsafeScripts).flatMap(
    ([name, command]) => auditBundledFocusedScript(name, command),
  );

  assert.ok(errors.some((error) => error.startsWith("test:fixed-output:")));
  assert.ok(errors.some((error) => error.startsWith("test:shared-directory:")));
  assert.ok(errors.some((error) => error.startsWith("test:missing-cleanup:")));
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