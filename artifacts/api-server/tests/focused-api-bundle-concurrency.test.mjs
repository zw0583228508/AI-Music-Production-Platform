import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  assert.match(runner, /\btrap 'exit 130' INT\b/u);
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

function interruptFocusedTestAfterBundles(
  script,
  signal = "SIGTERM",
  env = process.env,
) {
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
        stderr.includes(`focused API bundles ready for ${signal}`)
      ) {
        interrupted = true;
        process.kill(-child.pid, signal);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ script, code, signal, stdout, stderr, interrupted });
    });
  });
}

function interruptFocusedTestDuringAssertions(
  script,
  env = process.env,
  repeatSignal = false,
) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _parentTestContext, ...childEnv } = env;
    const handshakePath = join(
      tmpdir(),
      `focused-api-assertion-${randomUUID()}.txt`,
    );
    childEnv.FOCUSED_API_TEST_HANDSHAKE_FILE = handshakePath;
    const child = spawn("pnpm", ["run", script], {
      cwd: new URL("..", import.meta.url),
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    let runnerPid;
    let testChildPid;
    let repeatedSignalTimer;

    const interruptWhenAssertionIsActive = () => {
      if (interrupted) {
        return;
      }
      try {
        const marker = readFileSync(handshakePath, "utf8").match(
          /^(\d+),(\d+)$/u,
        );
        if (!marker) {
          return;
        }
        interrupted = true;
        runnerPid = Number(marker[1]);
        testChildPid = Number(marker[2]);
        process.kill(runnerPid, "SIGTERM");
        if (repeatSignal) {
          repeatedSignalTimer = setTimeout(() => {
            try {
              process.kill(runnerPid, "SIGTERM");
            } catch (error) {
              if (error?.code !== "ESRCH") {
                reject(error);
              }
            }
          }, 100);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          clearInterval(handshakePoll);
          reject(error);
        }
      }
    };
    const handshakePoll = setInterval(interruptWhenAssertionIsActive, 10);
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
      clearInterval(handshakePoll);
      clearTimeout(repeatedSignalTimer);
      rmSync(handshakePath, { force: true });
      resolve({
        script,
        code,
        signal,
        stdout,
        stderr,
        interrupted,
        runnerPid,
        testChildPid,
      });
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
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
  "different focused API later esbuild failures clean up partial bundles independently",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const failingEnvironment = {
      ...process.env,
      FOCUSED_API_TEST_INJECT_FAILURE: "later-esbuild",
    };
    const results = await Promise.all([
      runFocusedTest("test:validation", failingEnvironment),
      runFocusedTest("test:source-ingestion", failingEnvironment),
    ]);

    assert.equal(
      new Set(results.map(({ script }) => script)).size,
      2,
      "expected two distinct focused API scripts to fail concurrently after writing initial bundles",
    );
    for (const result of results) {
      assert.notEqual(
        result.code,
        0,
        `${result.script} unexpectedly succeeded after its injected later esbuild failure`,
      );
      assert.match(
        result.stderr,
        /focused API first bundle ready before later esbuild failure/,
        [
          `${result.script} did not confirm its initial bundle was written while a different focused check overlapped`,
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
          `${result.script} did not fail in the intended later esbuild stage while a different focused check overlapped`,
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
      `different later-esbuild-failed focused API tests left partial bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "a later esbuild failure does not disrupt a different healthy focused API check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [failed, healthy] = await Promise.all([
      runFocusedTest("test:validation", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "later-esbuild",
      }),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.notEqual(
      failed.script,
      healthy.script,
      "expected two distinct focused API scripts to run concurrently",
    );
    assert.notEqual(
      failed.code,
      0,
      "focused API test unexpectedly succeeded after its injected later esbuild failure",
    );
    assert.match(
      failed.stderr,
      /focused API first bundle ready before later esbuild failure/,
      [
        `${failed.script} did not confirm its initial bundle was written while the healthy focused check overlapped`,
        failed.signal ? `signal: ${failed.signal}` : "",
        failed.stdout,
        failed.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      failed.stderr,
      /\[ERROR\] Could not resolve ".*intentional-missing-later-entry\.ts"/,
      [
        `${failed.script} did not report the intended later esbuild failure`,
        failed.signal ? `signal: ${failed.signal}` : "",
        failed.stdout,
        failed.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check cleaned up after a later esbuild failure`,
        healthy.signal ? `signal: ${healthy.signal}` : "",
        healthy.stdout,
        healthy.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed-outcome focused API tests left generated bundle directories behind: ${leaked.join(", ")}`,
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
  "a focused API assertion failure does not disrupt a different healthy focused check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [failed, healthy] = await Promise.all([
      runFocusedTest("test:validation", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "during-node-test",
      }),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.notEqual(
      failed.script,
      healthy.script,
      "expected two distinct focused API scripts to run concurrently",
    );
    assert.equal(
      failed.code,
      1,
      [
        `${failed.script} did not fail through node --test while the healthy focused check overlapped`,
        failed.signal ? `signal: ${failed.signal}` : "",
        failed.stdout,
        failed.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      failed.stdout,
      /injected focused API assertion failure after bundling/,
      [
        `${failed.script} did not report the intended post-bundle assertion failure`,
        failed.signal ? `signal: ${failed.signal}` : "",
        failed.stdout,
        failed.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check cleaned up after an assertion failure`,
        healthy.signal ? `signal: ${healthy.signal}` : "",
        healthy.stdout,
        healthy.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed assertion-outcome focused API tests left generated bundle directories behind: ${leaked.join(", ")}`,
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
    const result = await interruptFocusedTestAfterBundles(
      "test:validation",
      "SIGTERM",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "await-sigterm",
      },
    );

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

test(
  "SIGTERM after bundling does not disrupt a different healthy focused API check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interrupted, healthy] = await Promise.all([
      interruptFocusedTestAfterBundles("test:validation", "SIGTERM", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "await-sigterm",
      }),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.notEqual(
      interrupted.script,
      healthy.script,
      "expected two distinct focused API scripts to run concurrently",
    );
    assert.equal(
      interrupted.interrupted,
      true,
      [
        `${interrupted.script} never reached the post-bundle interruption point`,
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      interrupted.signal,
      "SIGTERM",
      [
        `${interrupted.script} did not terminate through the intended SIGTERM path`,
        `exit code: ${interrupted.code}`,
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      interrupted.stderr,
      /focused API bundles ready for SIGTERM/,
      `${interrupted.script} was interrupted before its bundles existed`,
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check handled SIGTERM`,
        healthy.signal ? `signal: ${healthy.signal}` : "",
        healthy.stdout,
        healthy.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed healthy and SIGTERM-interrupted focused API tests left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "SIGTERM during assertions terminates its test child without disrupting a different healthy focused API check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interrupted, healthy] = await Promise.all([
      interruptFocusedTestDuringAssertions("test:validation", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "await-sigterm-during-node-test",
      }),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.notEqual(
      interrupted.script,
      healthy.script,
      "expected two distinct focused API scripts to run concurrently",
    );
    assert.equal(
      interrupted.interrupted,
      true,
      [
        `${interrupted.script} never reached its node --test phase`,
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      interrupted.code,
      143,
      [
        `${interrupted.script} did not terminate through the intended SIGTERM path`,
        interrupted.signal ? `signal: ${interrupted.signal}` : "",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await waitForProcessExit(interrupted.testChildPid);
    assert.equal(
      processExists(interrupted.testChildPid),
      false,
      `interrupted node --test child ${interrupted.testChildPid} remained alive`,
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check handled SIGTERM during assertions`,
        healthy.signal ? `signal: ${healthy.signal}` : "",
        healthy.stdout,
        healthy.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed healthy and assertion-interrupted focused API tests left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "repeated SIGTERM force-terminates resistant assertions without disrupting a healthy focused API check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interrupted, healthy] = await Promise.all([
      interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-node-test",
        },
        true,
      ),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.equal(
      interrupted.interrupted,
      true,
      [
        `${interrupted.script} never reached its signal-resistant node --test phase`,
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      interrupted.code,
      143,
      [
        `${interrupted.script} did not terminate through the intended SIGTERM path`,
        interrupted.signal ? `signal: ${interrupted.signal}` : "",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await waitForProcessExit(interrupted.testChildPid);
    assert.equal(
      processExists(interrupted.testChildPid),
      false,
      `signal-resistant node --test child ${interrupted.testChildPid} remained alive`,
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check escalated termination`,
        healthy.signal ? `signal: ${healthy.signal}` : "",
        healthy.stdout,
        healthy.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed healthy and force-terminated focused API tests left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "overlapping SIGTERM and later esbuild failure leave no focused API bundles behind",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interruptedResult, laterEsbuildResult] = await Promise.all([
      interruptFocusedTestAfterBundles(
        "test:validation",
        "SIGTERM",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE: "await-sigterm",
        },
      ),
      runFocusedTest("test:source-ingestion", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "later-esbuild",
      }),
    ]);

    assert.notEqual(
      interruptedResult.script,
      laterEsbuildResult.script,
      "expected two distinct focused API scripts to exercise the overlapping failure paths",
    );
    assert.equal(
      interruptedResult.interrupted,
      true,
      [
        `${interruptedResult.script} never reached the post-bundle interruption point`,
        interruptedResult.stdout,
        interruptedResult.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      interruptedResult.signal,
      "SIGTERM",
      [
        `${interruptedResult.script} did not terminate through the intended SIGTERM path`,
        `exit code: ${interruptedResult.code}`,
        interruptedResult.stdout,
        interruptedResult.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      interruptedResult.stderr,
      /focused API bundles ready for SIGTERM/,
      `${interruptedResult.script} was interrupted before its bundles existed`,
    );

    assert.notEqual(
      laterEsbuildResult.code,
      0,
      `${laterEsbuildResult.script} unexpectedly succeeded after its injected later esbuild failure`,
    );
    assert.match(
      laterEsbuildResult.stderr,
      /focused API first bundle ready before later esbuild failure/,
      `${laterEsbuildResult.script} did not confirm its initial bundle was written`,
    );
    assert.match(
      laterEsbuildResult.stderr,
      /\[ERROR\] Could not resolve ".*intentional-missing-later-entry\.ts"/,
      [
        `${laterEsbuildResult.script} did not fail in the intended later esbuild stage`,
        laterEsbuildResult.signal ? `signal: ${laterEsbuildResult.signal}` : "",
        laterEsbuildResult.stdout,
        laterEsbuildResult.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `overlapping interrupted and later-esbuild-failed focused API tests left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "SIGINT after bundling removes the interrupted focused API bundle directory",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const result = await interruptFocusedTestAfterBundles(
      "test:validation",
      "SIGINT",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "await-sigint",
      },
    );

    assert.equal(
      result.interrupted,
      true,
      [
        "focused API test never reached the post-bundle keyboard interruption point",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.equal(
      result.signal,
      "SIGINT",
      [
        "focused API test did not terminate through the intended SIGINT path",
        `exit code: ${result.code}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      result.stderr,
      /focused API bundles ready for SIGINT/,
      "focused API test was interrupted before its bundles existed",
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `SIGINT-interrupted focused API test left generated bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "overlapping SIGINT and later esbuild failure leave no focused API bundles behind",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interruptedResult, laterEsbuildResult] = await Promise.all([
      interruptFocusedTestAfterBundles(
        "test:validation",
        "SIGINT",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE: "await-sigint",
        },
      ),
      runFocusedTest("test:source-ingestion", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "later-esbuild",
      }),
    ]);

    assert.notEqual(
      interruptedResult.script,
      laterEsbuildResult.script,
      "expected two distinct focused API scripts to exercise the overlapping failure paths",
    );
    assert.equal(interruptedResult.interrupted, true);
    assert.equal(
      interruptedResult.signal,
      "SIGINT",
      [
        `${interruptedResult.script} did not terminate through the intended SIGINT path`,
        `exit code: ${interruptedResult.code}`,
        interruptedResult.stdout,
        interruptedResult.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      interruptedResult.stderr,
      /focused API bundles ready for SIGINT/,
      `${interruptedResult.script} was interrupted before its bundles existed`,
    );
    assert.notEqual(
      laterEsbuildResult.code,
      0,
      `${laterEsbuildResult.script} unexpectedly succeeded after its injected later esbuild failure`,
    );
    assert.match(
      laterEsbuildResult.stderr,
      /focused API first bundle ready before later esbuild failure/,
    );
    assert.match(
      laterEsbuildResult.stderr,
      /\[ERROR\] Could not resolve ".*intentional-missing-later-entry\.ts"/,
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `overlapping SIGINT and later-esbuild-failed focused API tests left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);