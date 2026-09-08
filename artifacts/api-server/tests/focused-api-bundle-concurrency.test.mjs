import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

for (const [environmentVariable, invalidValue] of [
  ["FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE", "EPREM"],
  ["FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE", "EACCESS"],
  ["FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE", "SIGTREK:EPERM"],
  ["FOCUSED_API_TEST_INJECT_PROCESS_GROUP_SIGNAL_FAILURE", "EPERM,EACCES"],
  ["FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE", "ENOENT"],
  ["FOCUSED_API_TEST_INJECT_FAILURE", "await-sigtrek"],
  ["FOCUSED_API_TEST_INJECT_PROCESS_DIRECTORY_READ_FAILURE", "ture"],
  ["FOCUSED_API_TEST_INJECT_MALFORMED_CLEANUP_MESSAGE", "throwing-value-of"],
  ["FOCUSED_API_TEST_INJECT_MALFORMED_STARTUP_ERROR", "throwing-value-of"],
]) {
  test(`${environmentVariable} rejects unsupported cleanup fault values`, async () => {
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      [environmentVariable]: invalidValue,
    });

    assert.equal(
      result.code,
      1,
      [
        "unsupported cleanup fault setting did not fail",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(result.stderr, new RegExp(`${environmentVariable} has unsupported cleanup fault`));
    assert.match(result.stderr, new RegExp(invalidValue.replaceAll(",", "\\,")));
    assert.match(
      result.stderr,
      /supported values are /,
      "diagnostic did not list supported cleanup fault values",
    );
  });
}

for (const invalidValue of ["not-a-pid", "1.5", "0", "-7"]) {
  test(`FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET rejects ${invalidValue}`, async () => {
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: invalidValue,
    });

    assert.equal(
      result.code,
      1,
      [
        "invalid reused-PID target did not fail before focused tests",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      result.stderr,
      /FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET has invalid process ID target:/,
    );
    assert.match(result.stderr, new RegExp(invalidValue.replace(".", "\\.")));
    assert.match(
      result.stderr,
      /accepted format is a positive base-10 integer/,
      "diagnostic did not explain the accepted reused-PID target format",
    );
    assert.doesNotMatch(
      result.stdout,
      /\besbuild\b|TAP version/u,
      "invalid reused-PID target reached bundling or focused tests",
    );
  });
}

test("FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET rejects a PID outside the host range", async () => {
  const pidWrapPoint = Number(
    readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(),
  );
  const maximumSupportedPid = pidWrapPoint - 1;
  const invalidValue = String(pidWrapPoint);
  const result = await runFocusedTest("test:validation", {
    ...process.env,
    FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: invalidValue,
  });

  assert.equal(
    result.code,
    1,
    [
      "out-of-range reused-PID target did not fail before focused tests",
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  assert.match(
    result.stderr,
    new RegExp(
      `FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET has unsupported process ID target: ${invalidValue}`,
    ),
  );
  assert.match(
    result.stderr,
    new RegExp(`accepted host range is 1-${maximumSupportedPid}`),
    "diagnostic did not identify the accepted host PID range",
  );
  assert.doesNotMatch(
    result.stdout,
    /\besbuild\b|TAP version/u,
    "out-of-range reused-PID target reached bundling or focused tests",
  );
});

test("an unreadable host PID limit fails before focused work with a bounded diagnostic", async () => {
  const overrideDirectory = await mkdtemp(
    join(tmpdir(), "focused-api-pid-limit."),
  );
  try {
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
      FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: overrideDirectory,
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /focused API runner could not read host kernel setting \/proc\/sys\/kernel\/pid_max: EISDIR/u,
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(overrideDirectory.replaceAll("/", "\\/")),
      "diagnostic exposed the test input path",
    );
    assert.doesNotMatch(
      result.stdout,
      /\besbuild\b|TAP version/u,
      "unreadable host PID limit reached bundling or focused tests",
    );
  } finally {
    await rm(overrideDirectory, { recursive: true, force: true });
  }
});

test("denied access to the host PID limit fails before focused work with a bounded diagnostic", async () => {
  const deniedOverridePath = join(
    tmpdir(),
    `focused-api-denied-pid-limit-${randomUUID()}`,
  );
  const result = await runFocusedTest("test:validation", {
    ...process.env,
    FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
    FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: deniedOverridePath,
    FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE: "EACCES",
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /focused API runner could not read host kernel setting \/proc\/sys\/kernel\/pid_max: EACCES/u,
  );
  assert.doesNotMatch(
    result.stderr,
    new RegExp(deniedOverridePath.replaceAll("/", "\\/")),
    "diagnostic exposed the denied test input path",
  );
  assert.doesNotMatch(
    result.stdout,
    /\besbuild\b|TAP version/u,
    "denied host PID limit reached bundling or focused tests",
  );
});

test("EPERM access denial to the host PID limit fails before focused work with a bounded diagnostic", async () => {
  const deniedOverridePath = join(
    tmpdir(),
    `focused-api-eperm-pid-limit-${randomUUID()}`,
  );
  const result = await runFocusedTest("test:validation", {
    ...process.env,
    FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
    FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: deniedOverridePath,
    FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE: "EPERM",
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /focused API runner could not read host kernel setting \/proc\/sys\/kernel\/pid_max: EPERM/u,
  );
  assert.doesNotMatch(
    result.stderr,
    new RegExp(deniedOverridePath.replaceAll("/", "\\/")),
    "diagnostic exposed the EPERM-denied test input path",
  );
  assert.doesNotMatch(
    result.stdout,
    /\besbuild\b|TAP version/u,
    "EPERM-denied host PID limit reached bundling or focused tests",
  );
});

test("an unclassified host PID limit failure fails before focused work with a bounded diagnostic", async () => {
  const deniedOverridePath = join(
    tmpdir(),
    `focused-api-unknown-pid-limit-${randomUUID()}`,
  );
  const result = await runFocusedTest("test:validation", {
    ...process.env,
    FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
    FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: deniedOverridePath,
    FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE: "UNKNOWN",
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /focused API runner could not read host kernel setting \/proc\/sys\/kernel\/pid_max: UNKNOWN/u,
  );
  assert.doesNotMatch(
    result.stderr,
    new RegExp(deniedOverridePath.replaceAll("/", "\\/")),
    "diagnostic exposed the unclassified test input path",
  );
  assert.doesNotMatch(
    result.stdout,
    /\besbuild\b|TAP version/u,
    "unclassified host PID limit failure reached bundling or focused tests",
  );
});

test("a throwing host PID limit code getter normalizes to UNKNOWN before focused work", async () => {
  const deniedOverridePath = join(
    tmpdir(),
    `focused-api-throwing-pid-limit-code-${randomUUID()}`,
  );
  const result = await runFocusedTest("test:validation", {
    ...process.env,
    FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
    FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: deniedOverridePath,
    FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE: "THROWING_GETTER",
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /focused API runner could not read host kernel setting \/proc\/sys\/kernel\/pid_max: UNKNOWN/u,
  );
  assert.doesNotMatch(
    result.stderr,
    /injected throwing host PID limit code getter/u,
    "diagnostic exposed the throwing getter exception",
  );
  assert.doesNotMatch(
    result.stderr,
    new RegExp(deniedOverridePath.replaceAll("/", "\\/")),
    "diagnostic exposed the hostile getter override path",
  );
  assert.doesNotMatch(
    result.stdout,
    /\besbuild\b|TAP version/u,
    "hostile host PID limit failure reached bundling or focused tests",
  );
});

test("a throwing process-record error code getter cannot replace its root identity diagnostic", async () => {
  const overrideDirectory = await mkdtemp(
    join(tmpdir(), "focused-api-hostile-process-record."),
  );
  const overridePath = join(overrideDirectory, "malformed.json");
  try {
    await writeFile(overridePath, "{");
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
      FOCUSED_API_TEST_PROCESS_STAT_OVERRIDE_FILE: overridePath,
      FOCUSED_API_TEST_INJECT_MALFORMED_STARTUP_ERROR:
        "throwing-code-getter",
    });

    assert.equal(result.code, 0);
    assert.match(
      result.stderr,
      /focused API cleanup could not capture root process \d+ identity: UNKNOWN /u,
    );
    assert.doesNotMatch(
      result.stderr,
      /injected throwing startup code getter/u,
      "hostile code getter replaced the bounded root identity diagnostic",
    );
    assert.match(
      result.stdout,
      /converts constant tempo between seconds, ticks, beats, and bars/u,
      "non-fatal root identity diagnostic prevented focused work",
    );
  } finally {
    await rm(overrideDirectory, { recursive: true, force: true });
  }
});

for (const [injectedFailure, hiddenErrorLabel] of [
  ["UNEXPECTED_LONG", `E${"X".repeat(1_024)}`],
  ["UNEXPECTED_MALFORMED", "host error label"],
]) {
  test(`${injectedFailure} host PID limit labels normalize to UNKNOWN before focused work`, async () => {
    const deniedOverridePath = join(
      tmpdir(),
      `focused-api-unusual-pid-limit-${randomUUID()}`,
    );
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
      FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: deniedOverridePath,
      FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE: injectedFailure,
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /focused API runner could not read host kernel setting \/proc\/sys\/kernel\/pid_max: UNKNOWN/u,
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(hiddenErrorLabel),
      "diagnostic exposed the unusual host error label",
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(deniedOverridePath.replaceAll("/", "\\/")),
      "diagnostic exposed the unusual-label override path",
    );
    assert.doesNotMatch(
      result.stdout,
      /\besbuild\b|TAP version/u,
      "unusual host PID limit failure reached bundling or focused tests",
    );
  });
}

test("a missing host PID limit fails before focused work with a bounded diagnostic", async () => {
  const overrideDirectory = await mkdtemp(
    join(tmpdir(), "focused-api-pid-limit."),
  );
  const missingOverridePath = join(overrideDirectory, "missing-pid-max");
  try {
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
      FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: missingOverridePath,
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /focused API runner could not read host kernel setting \/proc\/sys\/kernel\/pid_max: ENOENT/u,
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(missingOverridePath.replaceAll("/", "\\/")),
      "diagnostic exposed the missing test input path",
    );
    assert.doesNotMatch(
      result.stdout,
      /\besbuild\b|TAP version/u,
      "missing host PID limit reached bundling or focused tests",
    );
  } finally {
    await rm(overrideDirectory, { recursive: true, force: true });
  }
});

test("a malformed host PID limit fails before focused work without echoing its contents", async () => {
  const overrideDirectory = await mkdtemp(
    join(tmpdir(), "focused-api-pid-limit."),
  );
  const overridePath = join(overrideDirectory, "pid-max");
  const malformedValue = "not-a-kernel-pid-limit";
  try {
    await writeFile(overridePath, malformedValue);
    const result = await runFocusedTest("test:validation", {
      ...process.env,
      FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: "1",
      FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE: overridePath,
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /focused API runner found malformed host kernel setting \/proc\/sys\/kernel\/pid_max; expected a base-10 integer greater than 1/u,
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(malformedValue),
      "diagnostic exposed malformed host input",
    );
    assert.doesNotMatch(
      result.stdout,
      /\besbuild\b|TAP version/u,
      "malformed host PID limit reached bundling or focused tests",
    );
  } finally {
    await rm(overrideDirectory, { recursive: true, force: true });
  }
});

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
  handshakePrefix = "focused-api-assertion",
) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _parentTestContext, ...childEnv } = env;
    const handshakePath = join(
      tmpdir(),
      `${handshakePrefix}-${randomUUID()}.txt`,
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
    let helperPid;
    let helperPids = [];
    let repeatedSignalTimer;

    const interruptWhenAssertionIsActive = () => {
      try {
        const marker = readFileSync(handshakePath, "utf8").match(
          /^(\d+),(\d+)((?:,\d+)*)$/u,
        );
        if (!marker) {
          return;
        }
        runnerPid = Number(marker[1]);
        testChildPid = Number(marker[2]);
        helperPids = marker[3] ? marker[3].slice(1).split(",").map(Number) : [];
        helperPid = helperPids[0];
        if (interrupted) {
          return;
        }
        interrupted = true;
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
      if (helperPids.length === 0) {
        try {
          const marker = readFileSync(handshakePath, "utf8").match(
            /^(\d+),(\d+)((?:,\d+)*)$/u,
          );
          helperPids = marker?.[3]
            ? marker[3].slice(1).split(",").map(Number)
            : [];
          helperPid = helperPids[0];
        } catch (error) {
          if (error?.code !== "ENOENT") {
            reject(error);
            return;
          }
        }
      }
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
        helperPid,
        helperPids,
        activeChildPid: testChildPid,
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

for (const [malformedStartupError, expectedCode, expectedDiagnostic] of [
  [
    "throwing-message-getter",
    73,
    /focused API runner failed with unavailable error message/u,
  ],
  [
    "throwing-message-conversion",
    73,
    /focused API runner failed with unavailable error message/u,
  ],
  [
    "throwing-exit-code-getter",
    1,
    /injected focused API failure after tempdir creation/u,
  ],
]) {
  test(
    `${malformedStartupError} cannot replace the bounded startup diagnostic`,
    async () => {
      const before = await listBundleDirectories();
      const result = await runFocusedTest("test:validation", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "after-tempdir",
        FOCUSED_API_TEST_INJECT_MALFORMED_STARTUP_ERROR: malformedStartupError,
      });

      assert.equal(result.code, expectedCode);
      assert.match(result.stderr, expectedDiagnostic);
      assert.doesNotMatch(
        result.stderr,
        /injected throwing startup (?:message|exit code)/u,
      );
      const after = await listBundleDirectories();
      assert.deepEqual(
        [...after].filter((directory) => !before.has(directory)),
        [],
      );
    },
  );
}

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
  "SIGTERM force-terminates a resistant bundler without disrupting a healthy focused API check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interrupted, healthy] = await Promise.all([
      interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
          FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE: "true",
        },
        false,
        "focused-api-bundler",
      ),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.equal(
      interrupted.interrupted,
      true,
      [
        `${interrupted.script} never reached its signal-resistant bundling phase`,
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
    const directSignalFailures =
      interrupted.stderr.match(
        /focused API cleanup could not signal process \d+ with SIGKILL: EPERM injected denied direct process signal/g,
      ) ?? [];
    assert.equal(
      directSignalFailures.length,
      1,
      "a single denied direct signal should retain exactly one detailed diagnostic",
    );
    assert.doesNotMatch(
      interrupted.stderr,
      /focused API cleanup suppressed detailed SIGKILL EPERM signal failures/,
      "a single denied direct signal should not emit an empty suppression summary",
    );
    await waitForProcessExit(interrupted.activeChildPid);
    assert.equal(
      processExists(interrupted.activeChildPid),
      false,
      `signal-resistant bundler child ${interrupted.activeChildPid} remained alive`,
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check force-terminated its bundler`,
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
      `mixed healthy and bundler-interrupted focused API tests left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

for (const errorCode of ["EPERM", "EACCES"]) {
  test(
    `a single ${errorCode} process record fault is injected during cleanup`,
    { timeout: 15_000 },
    async () => {
      const before = await listBundleDirectories();
      const interrupted = await interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
          FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE: errorCode,
        },
        false,
        `focused-api-single-${errorCode.toLowerCase()}-process-record`,
      );

      assert.equal(interrupted.interrupted, true);
      assert.equal(
        interrupted.code,
        143,
        [
          `single ${errorCode} process record fault did not complete cleanup`,
          interrupted.stdout,
          interrupted.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      assert.match(
        interrupted.stderr,
        new RegExp(
          `focused API cleanup could not read /proc/\\d+/stat: ${errorCode} injected unreadable process record`,
        ),
      );
      await waitForProcessExit(interrupted.activeChildPid);
      assert.equal(processExists(interrupted.activeChildPid), false);

      const after = await listBundleDirectories();
      const leaked = [...after].filter((directory) => !before.has(directory));
      assert.deepEqual(leaked, []);
    },
  );
}

test(
  "cleanup error messages stay single-line and bounded without hiding useful context",
  { timeout: 15_000 },
  async () => {
    const hostileTail = "X".repeat(1_024);
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
        FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE: "EPERM",
        FOCUSED_API_TEST_INJECT_CLEANUP_ERROR_MESSAGE: `useful cleanup context\nforged log entry\u0007\u001b[31m${hostileTail}`,
      },
      false,
      "focused-api-bounded-cleanup-message",
    );

    assert.equal(interrupted.interrupted, true);
    assert.equal(
      interrupted.code,
      143,
      [
        "hostile cleanup message prevented bounded cancellation",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const diagnostic = interrupted.stderr.match(
      /focused API cleanup could not read \/proc\/\d+\/stat: EPERM ([^\n]+)/u,
    );
    assert.ok(diagnostic, "cleanup did not retain its detailed diagnostic");
    assert.match(
      diagnostic[1],
      /^useful cleanup context forged log entry \[31m/u,
      "cleanup removed useful context instead of flattening controls",
    );
    assert.ok(
      diagnostic[1].length <= 240,
      `cleanup message exceeded its 240-character limit: ${diagnostic[1].length}`,
    );
    assert.match(diagnostic[1], /\.\.\.$/u);
    assert.doesNotMatch(
      interrupted.stderr,
      /\u0007|\u001b|\nforged log entry/u,
    );
    assert.doesNotMatch(interrupted.stderr, /X{256}/u);
    await waitForProcessExit(interrupted.activeChildPid);
    assert.equal(processExists(interrupted.activeChildPid), false);
  },
);

for (const malformedMessage of [
  "throwing-getter",
  "throwing-string-conversion",
]) {
  test(
    `${malformedMessage} cleanup messages cannot interrupt cancellation diagnostics`,
    { timeout: 15_000 },
    async () => {
      const before = await listBundleDirectories();
      const interrupted = await interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
          FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE: "EPERM",
          FOCUSED_API_TEST_INJECT_MALFORMED_CLEANUP_MESSAGE: malformedMessage,
        },
        false,
        `focused-api-${malformedMessage}-cleanup-message`,
      );

      assert.equal(interrupted.interrupted, true);
      assert.equal(
        interrupted.code,
        143,
        [
          "malformed cleanup message prevented bounded cancellation",
          interrupted.stdout,
          interrupted.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      assert.match(
        interrupted.stderr,
        /focused API cleanup could not read \/proc\/\d+\/stat: EPERM unavailable error message/u,
      );
      assert.doesNotMatch(
        interrupted.stderr,
        /injected throwing cleanup message/u,
      );
      await waitForProcessExit(interrupted.activeChildPid);
      assert.equal(processExists(interrupted.activeChildPid), false);

      const after = await listBundleDirectories();
      assert.deepEqual(
        [...after].filter((directory) => !before.has(directory)),
        [],
      );
    },
  );
}

test(
  "a throwing cleanup code getter cannot interrupt cancellation diagnostics",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
        FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE: "EPERM",
        FOCUSED_API_TEST_INJECT_MALFORMED_CLEANUP_MESSAGE:
          "throwing-code-getter",
      },
      false,
      "focused-api-throwing-code-getter",
    );

    assert.equal(interrupted.interrupted, true);
    assert.equal(
      interrupted.code,
      143,
      [
        "hostile cleanup code prevented bounded cancellation",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      interrupted.stderr,
      /focused API cleanup could not read \/proc\/\d+\/stat: UNKNOWN injected unreadable process record/u,
    );
    assert.doesNotMatch(
      interrupted.stderr,
      /injected throwing cleanup code getter/u,
    );
    await waitForProcessExit(interrupted.activeChildPid);
    assert.equal(processExists(interrupted.activeChildPid), false);

    const after = await listBundleDirectories();
    assert.deepEqual(
      [...after].filter((directory) => !before.has(directory)),
      [],
    );
  },
);

test(
  "mixed unreadable process records retain bounded per-code diagnostics and cannot strand cancellation cleanup",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const startedAt = Date.now();
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
        FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE: "EPERM,EACCES",
      },
      false,
      "focused-api-unreadable-process-record",
    );
    const cleanupDurationMs = Date.now() - startedAt;

    assert.equal(
      interrupted.interrupted,
      true,
      [
        "focused API test never reached its signal-resistant bundling phase",
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
        "focused API test did not complete the intended SIGTERM cleanup path",
        interrupted.signal ? `signal: ${interrupted.signal}` : "",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const sampledPidsByCode = new Map();
    for (const errorCode of ["EPERM", "EACCES"]) {
      const detailedFailures =
        interrupted.stderr.match(
          new RegExp(
            `focused API cleanup could not read /proc/(\\d+)/stat: ${errorCode} injected unreadable process record`,
            "g",
          ),
        ) ?? [];
      assert.equal(
        detailedFailures.length,
        1,
        `focused API cleanup did not retain exactly one ${errorCode} process record detail`,
      );
      const summary = interrupted.stderr.match(
        new RegExp(
          `focused API cleanup suppressed detailed ${errorCode} process record read failures for (\\d+) additional processes; affected PIDs: ([^\\n]+)`,
        ),
      );
      assert.ok(
        summary,
        `focused API cleanup did not retain a separate ${errorCode} affected-PID summary`,
      );
      assert.ok(
        Number(summary[1]) > 0,
        `${errorCode} process record summary did not include additional processes`,
      );
      const sampledPids = summary[2]
        .replace(/, and \d+ more$/u, "")
        .split(", ");
      assert.ok(
        sampledPids.length <= 10,
        `${errorCode} process record summary sampled too many affected PIDs: ${sampledPids.length}`,
      );
      sampledPidsByCode.set(errorCode, new Set(sampledPids));
    }
    assert.deepEqual(
      [...sampledPidsByCode.get("EPERM")].filter((pid) =>
        sampledPidsByCode.get("EACCES").has(pid),
      ),
      [],
      "mixed process record summaries assigned the same PID to both permission errors",
    );
    assert.ok(
      cleanupDurationMs < 10_000,
      `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
    );
    await waitForProcessExit(interrupted.activeChildPid);
    assert.equal(
      processExists(interrupted.activeChildPid),
      false,
      `signal-resistant bundler child ${interrupted.activeChildPid} remained alive`,
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `unreadable process record left focused API bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

for (const [injectedCode, faultEnvironment, faultValue, expectedDiagnostic] of [
  [
    "UNEXPECTED_LONG",
    "FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE",
    "EPERM,EACCES",
    /focused API cleanup suppressed detailed UNKNOWN process record read failures/u,
  ],
  [
    "UNEXPECTED_MALFORMED",
    "FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE",
    "EPERM,EACCES",
    /focused API cleanup suppressed detailed UNKNOWN process existence-check failures/u,
  ],
  [
    "UNEXPECTED_LONG",
    "FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE",
    "SIGTERM:EPERM,SIGKILL:EACCES",
    /focused API cleanup suppressed detailed SIG(?:TERM|KILL) UNKNOWN signal failures/u,
  ],
]) {
  test(
    `${injectedCode} ${faultEnvironment} labels collapse into bounded UNKNOWN cancellation diagnostics`,
    { timeout: 15_000 },
    async () => {
      const before = await listBundleDirectories();
      const interrupted = await interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE:
            faultEnvironment ===
            "FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE"
              ? "prelaunch-four-helpers-during-esbuild"
              : "continuously-launch-helpers-during-esbuild",
          [faultEnvironment]: faultValue,
          FOCUSED_API_TEST_INJECT_UNUSUAL_CLEANUP_ERROR_CODE: injectedCode,
        },
        false,
        `focused-api-${injectedCode.toLowerCase()}-cleanup-code`,
      );

      assert.equal(interrupted.interrupted, true);
      assert.equal(interrupted.code, 143, [
        "unusual cleanup error label prevented bounded cancellation",
        interrupted.stdout,
        interrupted.stderr,
      ].filter(Boolean).join("\n"));
      assert.match(interrupted.stderr, expectedDiagnostic);
      assert.doesNotMatch(
        interrupted.stderr,
        /EX{64}|\[object Object\]|cleanup error label/u,
        "cleanup diagnostics exposed an unusual error-code value",
      );
      await Promise.all(
        [interrupted.activeChildPid, ...interrupted.helperPids].map((pid) =>
          waitForProcessExit(pid),
        ),
      );
      const after = await listBundleDirectories();
      assert.deepEqual(
        [...after].filter((directory) => !before.has(directory)),
        [],
      );
    },
  );
}

test(
  "malformed process-table, identity, and process-group labels stay UNKNOWN during cancellation",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE:
          "ignore-sigterm-bundler-helper-during-esbuild",
        FOCUSED_API_TEST_INJECT_PROCESS_DIRECTORY_READ_FAILURE: "true",
        FOCUSED_API_TEST_INJECT_ROOT_IDENTITY_CAPTURE_FAILURE: "true",
        FOCUSED_API_TEST_INJECT_PROCESS_GROUP_SIGNAL_FAILURE: "EPERM",
        FOCUSED_API_TEST_INJECT_UNUSUAL_CLEANUP_ERROR_CODE:
          "UNEXPECTED_MALFORMED",
      },
      false,
      "focused-api-malformed-process-inspection-code",
    );

    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.code, 143, [
      "malformed process-inspection labels prevented bounded cancellation",
      interrupted.stdout,
      interrupted.stderr,
    ].filter(Boolean).join("\n"));
    assert.match(
      interrupted.stderr,
      /focused API cleanup could not capture root process \d+ identity: UNKNOWN/u,
    );
    assert.match(
      interrupted.stderr,
      /focused API cleanup could not enumerate \/proc: UNKNOWN/u,
    );
    assert.match(
      interrupted.stderr,
      /focused API cleanup could not signal process group \d+ with SIGTERM: UNKNOWN/u,
    );
    assert.doesNotMatch(
      interrupted.stderr,
      /\[object Object\]|cleanup error label/u,
      "cleanup diagnostics exposed a malformed error-code value",
    );
    await Promise.all(
      [interrupted.activeChildPid, ...interrupted.helperPids].map((pid) =>
        waitForProcessExit(pid),
      ),
    );
    const after = await listBundleDirectories();
    assert.deepEqual(
      [...after].filter((directory) => !before.has(directory)),
      [],
    );
  },
);

test(
  "an unreadable process table cannot prevent process-group cancellation",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const startedAt = Date.now();
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
        FOCUSED_API_TEST_INJECT_PROCESS_DIRECTORY_READ_FAILURE: "true",
      },
      false,
      "focused-api-unreadable-process-table",
    );
    const cleanupDurationMs = Date.now() - startedAt;

    assert.equal(
      interrupted.interrupted,
      true,
      [
        "focused API test never reached its signal-resistant bundling phase",
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
        "focused API test did not complete the intended SIGTERM cleanup path",
        interrupted.signal ? `signal: ${interrupted.signal}` : "",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.match(
      interrupted.stderr,
      /focused API cleanup could not enumerate \/proc: EACCES injected unreadable process table/,
      "focused API cleanup did not report the actionable process table failure",
    );
    assert.ok(
      cleanupDurationMs < 10_000,
      `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
    );
    await waitForProcessExit(interrupted.activeChildPid);
    assert.equal(
      processExists(interrupted.activeChildPid),
      false,
      `signal-resistant bundler child ${interrupted.activeChildPid} remained alive`,
    );

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `unreadable process table left focused API bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

for (const errorCode of ["EPERM", "EACCES"]) {
  test(
    `a denied ${errorCode} process existence check cannot interrupt bounded cancellation cleanup`,
    { timeout: 15_000 },
    async () => {
      const before = await listBundleDirectories();
      const startedAt = Date.now();
      const interrupted = await interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE:
            "ignore-sigterm-bundler-helper-during-esbuild",
          FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE: errorCode,
        },
        false,
        `focused-api-denied-${errorCode.toLowerCase()}-process-existence-check`,
      );
      const cleanupDurationMs = Date.now() - startedAt;

      assert.equal(
        interrupted.interrupted,
        true,
        [
          "focused API test never reached its signal-resistant bundling phase",
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
          "focused API test did not complete the intended SIGTERM cleanup path",
          interrupted.signal ? `signal: ${interrupted.signal}` : "",
          interrupted.stdout,
          interrupted.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const detailedFailurePattern = new RegExp(
        `focused API cleanup could not check whether process \\d+ exists: ${errorCode} injected denied process existence check`,
        "g",
      );
      const detailedFailures =
        interrupted.stderr.match(detailedFailurePattern) ?? [];
      assert.equal(
        detailedFailures.length,
        1,
        `focused API cleanup emitted an unbounded number of detailed process existence-check failures: ${detailedFailures.length}`,
      );
      assert.match(
        interrupted.stderr,
        new RegExp(
          `focused API cleanup suppressed detailed ${errorCode} process existence-check failures for \\d+ additional processes; affected PIDs: \\d+(?:, \\d+)*(?:, and \\d+ more)?`,
        ),
        "focused API cleanup did not summarize additional denied process checks with their error code and affected PIDs",
      );
      assert.match(
        interrupted.stderr,
        /focused API cleanup could not confirm process exit after bounded reaping: \d+(?:, \d+)*/,
        "focused API cleanup did not report which process exits remained unconfirmed",
      );
      assert.ok(
        cleanupDurationMs < 10_000,
        `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
      );
      assert.ok(
        interrupted.helperPid,
        "helper-backed bundler did not report its helper process",
      );
      await Promise.all([
        waitForProcessExit(interrupted.activeChildPid),
        waitForProcessExit(interrupted.helperPid),
      ]);
      for (const pid of [interrupted.activeChildPid, interrupted.helperPid]) {
        assert.equal(
          processExists(pid),
          false,
          `signal-resistant fixture process ${pid} remained alive`,
        );
      }

      const after = await listBundleDirectories();
      const leaked = [...after].filter((directory) => !before.has(directory));
      assert.deepEqual(
        leaked,
        [],
        `denied process existence check left focused API bundle directories behind: ${leaked.join(", ")}`,
      );
    },
  );
}

test(
  "denied process existence checks keep EPERM and EACCES diagnostics separated across processes",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const startedAt = Date.now();
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE:
          "prelaunch-four-helpers-during-esbuild",
        FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE:
          "EPERM,EACCES",
      },
      false,
      "focused-api-mixed-permission-process-existence-checks",
    );
    const cleanupDurationMs = Date.now() - startedAt;

    assert.equal(interrupted.interrupted, true, [
      "focused API test never reached its signal-resistant bundling phase",
      interrupted.stdout,
      interrupted.stderr,
    ].filter(Boolean).join("\n"));
    assert.equal(interrupted.code, 143, [
      "focused API test did not complete the intended SIGTERM cleanup path",
      interrupted.signal ? `signal: ${interrupted.signal}` : "",
      interrupted.stdout,
      interrupted.stderr,
    ].filter(Boolean).join("\n"));

    for (const errorCode of ["EPERM", "EACCES"]) {
      const detailedFailurePattern = new RegExp(
        `focused API cleanup could not check whether process \\d+ exists: ${errorCode} injected denied process existence check`,
        "g",
      );
      const detailedFailures =
        interrupted.stderr.match(detailedFailurePattern) ?? [];
      assert.equal(
        detailedFailures.length,
        1,
        `focused API cleanup did not emit exactly one detailed ${errorCode} process existence-check failure`,
      );
      assert.match(
        interrupted.stderr,
        new RegExp(
          `focused API cleanup suppressed detailed ${errorCode} process existence-check failures for \\d+ additional processes; affected PIDs: \\d+(?:, \\d+)*(?:, and \\d+ more)?`,
        ),
        `focused API cleanup did not summarize additional ${errorCode} process existence-check failures separately`,
      );
    }
    assert.match(
      interrupted.stderr,
      /focused API cleanup could not confirm process exit after bounded reaping: \d+(?:, \d+)*/,
      "focused API cleanup did not report which process exits remained unconfirmed",
    );
    assert.ok(
      cleanupDurationMs < 10_000,
      `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
    );

    await Promise.all(
      [interrupted.activeChildPid, ...interrupted.helperPids].map((pid) =>
        waitForProcessExit(pid),
      ),
    );
    for (const pid of [
      interrupted.activeChildPid,
      ...interrupted.helperPids,
    ]) {
      assert.equal(
        processExists(pid),
        false,
        `signal-resistant fixture process ${pid} remained alive`,
      );
    }

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed permission process existence-check failures left focused API bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

for (const errorCode of ["EPERM", "EACCES"]) {
  test(
    `a denied ${errorCode} direct process signal cannot interrupt bounded cancellation cleanup`,
    { timeout: 15_000 },
    async () => {
      const before = await listBundleDirectories();
      const startedAt = Date.now();
      const interrupted = await interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE:
            "continuously-launch-helpers-during-esbuild",
          FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE: errorCode,
        },
        false,
        "focused-api-denied-direct-process-signal",
      );
      const cleanupDurationMs = Date.now() - startedAt;

      assert.equal(
        interrupted.interrupted,
        true,
        [
          "focused API test never reached its signal-resistant bundling phase",
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
          "focused API test did not complete the intended SIGTERM cleanup path",
          interrupted.signal ? `signal: ${interrupted.signal}` : "",
          interrupted.stdout,
          interrupted.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const detailedFailurePattern = new RegExp(
        `focused API cleanup could not signal process \\d+ with SIGKILL: ${errorCode} injected denied direct process signal`,
        "g",
      );
      assert.match(
        interrupted.stderr,
        detailedFailurePattern,
        "focused API cleanup did not report the denied direct signal with its PID and signal",
      );
      const detailedFailures =
        interrupted.stderr.match(detailedFailurePattern) ?? [];
      assert.equal(
        detailedFailures.length,
        1,
        `focused API cleanup did not emit exactly one detailed ${errorCode} signal failure`,
      );
      assert.match(
        interrupted.stderr,
        new RegExp(
          `focused API cleanup suppressed detailed SIGKILL ${errorCode} signal failures for \\d+ additional processes; affected PIDs: \\d+(?:, \\d+)*(?:, and \\d+ more)?`,
        ),
        "focused API cleanup did not summarize additional denied signals with their signal, error code, and affected PIDs",
      );
      assert.ok(
        cleanupDurationMs < 10_000,
        `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
      );
      assert.ok(
        interrupted.helperPid,
        "helper-backed bundler did not report its helper process",
      );
      await Promise.all([
        waitForProcessExit(interrupted.activeChildPid),
        waitForProcessExit(interrupted.helperPid),
      ]);
      for (const pid of [interrupted.activeChildPid, interrupted.helperPid]) {
        assert.equal(
          processExists(pid),
          false,
          `signal-resistant fixture process ${pid} remained alive`,
        );
      }

      const after = await listBundleDirectories();
      const leaked = [...after].filter((directory) => !before.has(directory));
      assert.deepEqual(
        leaked,
        [],
        `denied direct process signal left focused API bundle directories behind: ${leaked.join(", ")}`,
      );
    },
  );
}

for (const errorCode of ["EPERM", "EACCES"]) {
  test(
    `denied ${errorCode} process-group signals cannot interrupt bounded cancellation cleanup`,
    { timeout: 15_000 },
    async () => {
      const before = await listBundleDirectories();
      const startedAt = Date.now();
      const interrupted = await interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE:
            "ignore-sigterm-bundler-helper-during-esbuild",
          FOCUSED_API_TEST_INJECT_PROCESS_GROUP_SIGNAL_FAILURE: errorCode,
        },
        false,
        `focused-api-denied-${errorCode.toLowerCase()}-process-group-signal`,
      );
      const cleanupDurationMs = Date.now() - startedAt;

      assert.equal(
        interrupted.interrupted,
        true,
        [
          "focused API test never reached its signal-resistant bundling phase",
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
          "focused API test did not complete the intended SIGTERM cleanup path",
          interrupted.signal ? `signal: ${interrupted.signal}` : "",
          interrupted.stdout,
          interrupted.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        const detailedFailurePattern = new RegExp(
          `focused API cleanup could not signal process group \\d+ with ${signal}: ${errorCode} injected denied process-group signal`,
          "g",
        );
        const detailedFailures =
          interrupted.stderr.match(detailedFailurePattern) ?? [];
        assert.equal(
          detailedFailures.length,
          1,
          `focused API cleanup did not emit exactly one detailed ${signal} ${errorCode} process-group signal failure`,
        );
      }
      assert.ok(
        cleanupDurationMs < 10_000,
        `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
      );
      assert.ok(
        interrupted.helperPids.length > 0,
        "helper-backed bundler did not report any helper processes",
      );
      await Promise.all(
        [interrupted.activeChildPid, ...interrupted.helperPids].map((pid) =>
          waitForProcessExit(pid),
        ),
      );
      for (const pid of [
        interrupted.activeChildPid,
        ...interrupted.helperPids,
      ]) {
        assert.equal(
          processExists(pid),
          false,
          `signal-resistant fixture process ${pid} remained alive`,
        );
      }

      const after = await listBundleDirectories();
      const leaked = [...after].filter((directory) => !before.has(directory));
      assert.deepEqual(
        leaked,
        [],
        `denied process-group signal left focused API bundle directories behind: ${leaked.join(", ")}`,
      );
    },
  );
}

test(
  "denied direct signals keep SIGTERM and SIGKILL diagnostics separated during bounded cancellation cleanup",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const startedAt = Date.now();
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE:
          "continuously-launch-helpers-during-esbuild",
        FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE:
          "SIGTERM:EPERM,SIGKILL:EPERM",
      },
      false,
      "focused-api-mixed-denied-direct-process-signals",
    );
    const cleanupDurationMs = Date.now() - startedAt;

    assert.equal(
      interrupted.interrupted,
      true,
      [
        "focused API test never reached its signal-resistant bundling phase",
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
        "focused API test did not complete the intended SIGTERM cleanup path",
        interrupted.signal ? `signal: ${interrupted.signal}` : "",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    for (const signal of ["SIGTERM", "SIGKILL"]) {
      const detailedFailurePattern = new RegExp(
        `focused API cleanup could not signal process \\d+ with ${signal}: EPERM injected denied direct process signal`,
        "g",
      );
      const detailedFailures =
        interrupted.stderr.match(detailedFailurePattern) ?? [];
      assert.equal(
        detailedFailures.length,
        1,
        `focused API cleanup did not emit exactly one detailed ${signal} EPERM signal failure`,
      );
      const suppressionSummary = new RegExp(
        `focused API cleanup suppressed detailed ${signal} EPERM signal failures for \\d+ additional processes; affected PIDs: \\d+(?:, \\d+)*(?:, and \\d+ more)?`,
      );
      const signalWasRetried = interrupted.stderr.includes(
        `focused API cleanup suppressed detailed ${signal} EPERM`,
      );
      if (signalWasRetried) {
        assert.match(
          interrupted.stderr,
          suppressionSummary,
          `focused API cleanup summarized ${signal} EPERM failures under the wrong diagnostic bucket`,
        );
      }
    }
    assert.doesNotMatch(
      interrupted.stderr,
      /suppressed detailed (?:SIGTERM|SIGKILL) EACCES/,
      "focused API cleanup reported the mixed-signal fixture under an unconfigured error code",
    );
    assert.ok(
      cleanupDurationMs < 10_000,
      `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
    );

    await Promise.all(
      [interrupted.activeChildPid, ...interrupted.helperPids].map((pid) =>
        waitForProcessExit(pid),
      ),
    );
    for (const pid of [
      interrupted.activeChildPid,
      ...interrupted.helperPids,
    ]) {
      assert.equal(
        processExists(pid),
        false,
        `signal-resistant fixture process ${pid} remained alive`,
      );
    }

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed denied direct process signals left focused API bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "denied direct signals keep EPERM and EACCES diagnostics separated for one signal",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const startedAt = Date.now();
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE:
          "continuously-launch-helpers-during-esbuild",
        FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE:
          "SIGTERM:EPERM,SIGTERM:EACCES",
      },
      false,
      "focused-api-mixed-permission-direct-process-signals",
    );
    const cleanupDurationMs = Date.now() - startedAt;

    assert.equal(interrupted.interrupted, true, [
      "focused API test never reached its signal-resistant bundling phase",
      interrupted.stdout,
      interrupted.stderr,
    ].filter(Boolean).join("\n"));
    assert.equal(interrupted.code, 143, [
      "focused API test did not complete the intended SIGTERM cleanup path",
      interrupted.signal ? `signal: ${interrupted.signal}` : "",
      interrupted.stdout,
      interrupted.stderr,
    ].filter(Boolean).join("\n"));

    for (const errorCode of ["EPERM", "EACCES"]) {
      const detailedFailurePattern = new RegExp(
        `focused API cleanup could not signal process \\d+ with SIGTERM: ${errorCode} injected denied direct process signal`,
        "g",
      );
      const detailedFailures =
        interrupted.stderr.match(detailedFailurePattern) ?? [];
      assert.equal(
        detailedFailures.length,
        1,
        `focused API cleanup did not emit exactly one detailed SIGTERM ${errorCode} failure`,
      );
      assert.match(
        interrupted.stderr,
        new RegExp(
          `focused API cleanup suppressed detailed SIGTERM ${errorCode} signal failures for \\d+ additional processes; affected PIDs: \\d+(?:, \\d+)*(?:, and \\d+ more)?`,
        ),
        `focused API cleanup did not summarize additional SIGTERM ${errorCode} failures separately`,
      );
    }
    assert.doesNotMatch(
      interrupted.stderr,
      /suppressed detailed SIGKILL (?:EPERM|EACCES)/,
      "focused API cleanup reported the single-signal fixture under SIGKILL",
    );
    assert.ok(
      cleanupDurationMs < 10_000,
      `focused API cleanup exceeded its bounded window: ${cleanupDurationMs}ms`,
    );

    await Promise.all(
      [interrupted.activeChildPid, ...interrupted.helperPids].map((pid) =>
        waitForProcessExit(pid),
      ),
    );
    for (const pid of [
      interrupted.activeChildPid,
      ...interrupted.helperPids,
    ]) {
      assert.equal(
        processExists(pid),
        false,
        `signal-resistant fixture process ${pid} remained alive`,
      );
    }

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `mixed permission direct signal failures left focused API bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "cancellation skips a PID whose process identity changed before direct signaling",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { stdio: "ignore" },
    );
    try {
      const interrupted = await interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE: "ignore-sigterm-during-esbuild",
          FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET: String(unrelated.pid),
        },
        false,
        "focused-api-reused-process-id",
      );

      assert.equal(interrupted.interrupted, true);
      assert.equal(interrupted.code, 143, [
        "focused API test did not complete the intended SIGTERM cleanup path",
        interrupted.signal ? `signal: ${interrupted.signal}` : "",
        interrupted.stdout,
        interrupted.stderr,
      ].filter(Boolean).join("\n"));
      assert.match(
        interrupted.stderr,
        new RegExp(
          `focused API cleanup skipped reused process ID ${unrelated.pid}; process identity changed`,
        ),
        "focused API cleanup did not safely report the simulated reused PID",
      );
      assert.equal(
        processExists(unrelated.pid),
        true,
        "cleanup signaled the unrelated process whose identity did not match",
      );
    } finally {
      unrelated.kill("SIGKILL");
      await waitForProcessExit(unrelated.pid);
    }

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `reused-PID cancellation left focused API bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "a reused root PID stops discovery and process-group signaling",
  { timeout: 15_000 },
  async () => {
    const processStatOverridePath = join(
      tmpdir(),
      `focused-api-process-stat-${randomUUID()}.json`,
    );
    const signalAttemptPath = join(
      tmpdir(),
      `focused-api-root-signal-attempts-${randomUUID()}.txt`,
    );
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE:
          "reused-root-with-helper-during-esbuild",
        FOCUSED_API_TEST_PROCESS_STAT_OVERRIDE_FILE: processStatOverridePath,
        FOCUSED_API_TEST_SIGNAL_ATTEMPT_FILE: signalAttemptPath,
      },
      false,
      "focused-api-reused-root",
    );

    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.code, 143, [
      "focused API test did not complete the reused-root cleanup path",
      interrupted.signal ? `signal: ${interrupted.signal}` : "",
      interrupted.stdout,
      interrupted.stderr,
    ].filter(Boolean).join("\n"));
    assert.match(
      interrupted.stderr,
      new RegExp(
        `focused API cleanup skipped reused process ID ${interrupted.activeChildPid}; process identity changed`,
      ),
      "focused API cleanup did not report the reused root identity",
    );
    assert.ok(interrupted.helperPid, "reused-root fixture did not report its helper");
    assert.throws(
      () => readFileSync(signalAttemptPath, "utf8"),
      (error) => error?.code === "ENOENT",
      "cleanup attempted to signal after the spawn-time root identity changed",
    );

    for (const pid of [interrupted.activeChildPid, interrupted.helperPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") {
          throw error;
        }
      }
    }
    await Promise.all([
      waitForProcessExit(interrupted.activeChildPid),
      waitForProcessExit(interrupted.helperPid),
    ]);
    rmSync(processStatOverridePath, { force: true });
    rmSync(signalAttemptPath, { force: true });
  },
);

test(
  "a missing spawn-time root identity is recovered before cancellation signaling",
  { timeout: 15_000 },
  async () => {
    const before = await listBundleDirectories();
    const signalAttemptPath = join(
      tmpdir(),
      `focused-api-signal-attempts-${randomUUID()}.txt`,
    );
    const interrupted = await interruptFocusedTestDuringAssertions(
      "test:validation",
      {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE:
          "reused-root-with-helper-during-esbuild",
        FOCUSED_API_TEST_INJECT_ROOT_IDENTITY_CAPTURE_FAILURE: "true",
        FOCUSED_API_TEST_SIGNAL_ATTEMPT_FILE: signalAttemptPath,
      },
      false,
      "focused-api-missing-root-identity",
    );

    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.code, 143, [
      "focused API test did not complete cleanup after root identity disappeared",
      interrupted.signal ? `signal: ${interrupted.signal}` : "",
      interrupted.stdout,
      interrupted.stderr,
    ].filter(Boolean).join("\n"));
    assert.ok(
      interrupted.helperPid,
      "missing-root fixture did not report its helper",
    );
    assert.match(
      readFileSync(signalAttemptPath, "utf8"),
      new RegExp(`^${interrupted.activeChildPid},SIGTERM,`),
      "cleanup did not recover and verify the active root before signaling",
    );
    await Promise.all([
      waitForProcessExit(interrupted.activeChildPid),
      waitForProcessExit(interrupted.helperPid),
    ]);
    for (const pid of [interrupted.activeChildPid, interrupted.helperPid]) {
      assert.equal(
        processExists(pid),
        false,
        `missing-root fixture process ${pid} remained alive`,
      );
    }
    rmSync(signalAttemptPath, { force: true });

    const after = await listBundleDirectories();
    const leaked = [...after].filter((directory) => !before.has(directory));
    assert.deepEqual(
      leaked,
      [],
      `missing-root cancellation left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "SIGTERM reaps a resistant bundler helper without disrupting a healthy focused API check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interrupted, healthy] = await Promise.all([
      interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE:
            "ignore-sigterm-bundler-helper-during-esbuild",
        },
        false,
        "focused-api-bundler-helper",
      ),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.equal(
      interrupted.interrupted,
      true,
      [
        `${interrupted.script} never reached its helper-backed bundling phase`,
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
    assert.ok(
      interrupted.helperPid,
      "helper-backed bundler did not report its helper process",
    );
    await Promise.all([
      waitForProcessExit(interrupted.activeChildPid),
      waitForProcessExit(interrupted.helperPid),
    ]);
    assert.equal(
      processExists(interrupted.activeChildPid),
      false,
      `signal-resistant bundler child ${interrupted.activeChildPid} remained alive`,
    );
    assert.equal(
      processExists(interrupted.helperPid),
      false,
      `signal-resistant bundler helper ${interrupted.helperPid} remained alive`,
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check reaped its bundler helper`,
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
      `mixed healthy and helper-backed bundler cancellation left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "SIGTERM reaps a helper launched during cancellation without disrupting a healthy focused API check",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interrupted, healthy] = await Promise.all([
      interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE:
            "launch-helper-on-sigterm-during-esbuild",
        },
        false,
        "focused-api-late-bundler-helper",
      ),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.equal(
      interrupted.interrupted,
      true,
      [
        `${interrupted.script} never reached its cancellation-race bundling phase`,
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
    assert.ok(
      interrupted.helperPid,
      "bundler did not report the helper launched from its SIGTERM handler",
    );
    await Promise.all([
      waitForProcessExit(interrupted.activeChildPid),
      waitForProcessExit(interrupted.helperPid),
    ]);
    assert.equal(
      processExists(interrupted.activeChildPid),
      false,
      `signal-resistant bundler child ${interrupted.activeChildPid} remained alive`,
    );
    assert.equal(
      processExists(interrupted.helperPid),
      false,
      `late-launched bundler helper ${interrupted.helperPid} remained alive`,
    );
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while a different focused check reaped a late-launched helper`,
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
      `mixed healthy and cancellation-race focused API tests left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "SIGTERM converges while a bundler continuously launches replacement helpers",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interrupted, healthy] = await Promise.all([
      interruptFocusedTestDuringAssertions(
        "test:validation",
        {
          ...process.env,
          FOCUSED_API_TEST_INJECT_FAILURE:
            "continuously-launch-helpers-during-esbuild",
        },
        false,
        "focused-api-replacement-helpers",
      ),
      runFocusedTest("test:source-ingestion"),
    ]);

    assert.equal(interrupted.interrupted, true);
    assert.equal(
      interrupted.code,
      143,
      [
        `${interrupted.script} did not finish bounded cancellation cleanup`,
        interrupted.signal ? `signal: ${interrupted.signal}` : "",
        interrupted.stdout,
        interrupted.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    assert.ok(
      interrupted.helperPids.length > 1,
      `bundler launched only ${interrupted.helperPids.length} replacement helper(s)`,
    );
    await Promise.all(
      [interrupted.activeChildPid, ...interrupted.helperPids].map((pid) =>
        waitForProcessExit(pid),
      ),
    );
    for (const pid of [interrupted.activeChildPid, ...interrupted.helperPids]) {
      assert.equal(
        processExists(pid),
        false,
        `fixture process ${pid} remained alive`,
      );
    }
    assert.equal(
      healthy.code,
      0,
      [
        `${healthy.script} failed while replacement-helper cleanup ran`,
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
      `replacement-helper cancellation left bundle directories behind: ${leaked.join(", ")}`,
    );
  },
);

test(
  "overlapping SIGTERM and later esbuild failure leave no focused API bundles behind",
  { timeout: 120_000 },
  async () => {
    const before = await listBundleDirectories();
    const [interruptedResult, laterEsbuildResult] = await Promise.all([
      interruptFocusedTestAfterBundles("test:validation", "SIGTERM", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "await-sigterm",
      }),
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
      interruptFocusedTestAfterBundles("test:validation", "SIGINT", {
        ...process.env,
        FOCUSED_API_TEST_INJECT_FAILURE: "await-sigint",
      }),
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
