import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suites = {
  export: {
    bundles: [
      ["src/lib/exportAudioRoles.test.ts", "export-audio-roles.test.mjs"],
      ["src/lib/exportCleanupRate.test.ts", "export-cleanup-rate.test.mjs"],
    ],
    tests: [
      "tests/export-pipeline.test.mjs",
      "tests/export-jobs-pedalboard.test.mjs",
      "tests/export-object-recovery.test.mjs",
    ],
  },
  "music-engines": {
    bundles: [
      ["tests/music-engines.test.ts", "music-engines.test.mjs"],
      ["src/lib/candidateRanking.test.ts", "candidate-ranking.test.mjs"],
      ["src/lib/candidateQuality.test.ts", "candidate-quality.test.mjs"],
      ["src/lib/candidateRepair.test.ts", "candidate-repair.test.mjs"],
    ],
  },
  validation: {
    bundles: [
      ["src/lib/songModelValidation.test.ts", "song-model-validation.test.mjs"],
      ["src/lib/canonicalTimeline.test.ts", "canonical-timeline.test.mjs"],
    ],
  },
  "analysis-providers": {
    bundles: [
      ["src/lib/analysisProviders.test.ts", "analysis-providers.test.mjs"],
      [
        "src/lib/analysisReconciliation.test.ts",
        "analysis-reconciliation.test.mjs",
      ],
      [
        "src/lib/gpuProviderAttestation.test.ts",
        "gpu-provider-attestation.test.mjs",
      ],
      [
        "src/lib/sheetSageCapacityAlerts.test.ts",
        "sheetsage-capacity-alerts.test.mjs",
      ],
      [
        "src/lib/musicProviders.blockedRouting.test.ts",
        "midi-sag-routing.test.mjs",
        ["--alias:@workspace/db=./src/lib/musicProviders.testDbStub.ts"],
      ],
      ["src/lib/clamp3Attestation.test.ts", "clamp3-attestation.test.mjs"],
    ],
  },
  "gpu-promotion": {
    bundles: [
      [
        "src/lib/gpuProviderAttestation.test.ts",
        "gpu-provider-attestation.test.mjs",
      ],
    ],
  },
  "source-ingestion": {
    bundles: [
      ["src/lib/sourceFormats.test.ts", "source-formats.test.mjs"],
      ["src/lib/audioSignal.test.ts", "audio-signal.test.mjs"],
    ],
  },
  "export-lineage": {
    bundles: [["src/lib/exportLineage.test.ts", "export-lineage.test.mjs"]],
  },
  copilot: {
    bundles: [["src/lib/copilotInterpreter.test.ts", "copilot.test.mjs"]],
  },
  revisions: {
    bundles: [
      [
        "src/lib/arrangementRevisions.test.ts",
        "arrangement-revisions.test.mjs",
      ],
    ],
  },
};

let activeChild;
const childTerminationGraceMs = 500;
const childReapingTimeoutMs = 3_000;
let injectedProcessStatReadFailure = false;
let injectedProcessDirectoryReadFailure = false;
const reportedProcessExistenceFailures = new Set();

function killChild(child, signal) {
  try {
    if (child.focusedIsolatedProcessGroup) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function listIsolatedChildPids(rootPid) {
  const childrenByParent = new Map();
  const pidsInSession = [];
  let entries;
  try {
    if (
      !injectedProcessDirectoryReadFailure &&
      process.env.FOCUSED_API_TEST_INJECT_PROCESS_DIRECTORY_READ_FAILURE ===
        "true"
    ) {
      injectedProcessDirectoryReadFailure = true;
      const error = new Error("injected unreadable process table");
      error.code = "EACCES";
      throw error;
    }
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch (error) {
    console.error(
      `focused API cleanup could not enumerate /proc: ${error?.code ?? "UNKNOWN"} ${error?.message ?? String(error)}`,
    );
    return [rootPid];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    try {
      if (
        !injectedProcessStatReadFailure &&
        process.env.FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE ===
          "true" &&
        entry.name === String(rootPid)
      ) {
        injectedProcessStatReadFailure = true;
        const error = new Error("injected unreadable process record");
        error.code = "EACCES";
        throw error;
      }
      const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
      const match = stat.match(/^(\d+) \(.*\) \S+ (\d+) \d+ (\d+) /u);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const sessionId = Number(match[3]);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
      if (sessionId === rootPid) {
        pidsInSession.push(pid);
      }
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") {
        continue;
      }
      console.error(
        `focused API cleanup could not read /proc/${entry.name}/stat: ${error?.code ?? "UNKNOWN"} ${error?.message ?? String(error)}`,
      );
    }
  }

  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return [...new Set([rootPid, ...pidsInSession, ...descendants])];
}

function checkProcessState(pid) {
  try {
    if (
      process.env.FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE ===
        "true"
    ) {
      const error = new Error("injected denied process existence check");
      error.code = "EPERM";
      throw error;
    }
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") {
      return "absent";
    }
    const failureKey = `${pid}:${error?.code ?? "UNKNOWN"}`;
    if (!reportedProcessExistenceFailures.has(failureKey)) {
      reportedProcessExistenceFailures.add(failureKey);
      console.error(
        `focused API cleanup could not check whether process ${pid} exists: ${error?.code ?? "UNKNOWN"} ${error?.message ?? String(error)}`,
      );
    }
    return "unknown";
  }
}

function killProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

async function reapIsolatedProcessTree(rootPid, knownPids) {
  const deadline = Date.now() + childReapingTimeoutMs;
  while (Date.now() < deadline) {
    discoverChildPids(rootPid, knownPids);
    const survivors = [...knownPids].filter(
      (pid) => checkProcessState(pid) !== "absent",
    );
    if (survivors.length === 0) {
      return;
    }
    for (const pid of survivors.toReversed()) {
      killProcess(pid, "SIGKILL");
    }
    await delay(10);
  }
  const states = [...knownPids].map((pid) => [pid, checkProcessState(pid)]);
  const survivors = states
    .filter(([, state]) => state === "alive")
    .map(([pid]) => pid);
  if (survivors.length > 0) {
    throw new Error(
      `focused API cleanup timed out with surviving processes: ${survivors.join(", ")}`,
    );
  }
  const unconfirmed = states
    .filter(([, state]) => state === "unknown")
    .map(([pid]) => pid);
  if (unconfirmed.length > 0) {
    console.error(
      `focused API cleanup could not confirm process exit after bounded reaping: ${unconfirmed.join(", ")}`,
    );
  }
}

function discoverChildPids(rootPid, knownPids) {
  for (const pid of listIsolatedChildPids(rootPid)) {
    knownPids.add(pid);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.focusedIsolatedProcessGroup = options.detached === true;
    activeChild = child;
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (activeChild === child) {
        activeChild = undefined;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(
        signal
          ? `${command} terminated by signal ${signal}`
          : `${command} exited with code ${code}`,
      );
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}

async function main() {
  const suiteName = process.argv[2];
  const suite = suites[suiteName];
  if (!suite) {
    throw new Error(`unknown focused API test suite: ${suiteName ?? "(missing)"}`);
  }

  const bundleDirectory =
    process.argv[3] ??
    (await mkdtemp(join(tmpdir(), "music-studio-api-tests.")));
  const termination = new Promise(() => {});
  let terminationStarted = false;
  const handleTermination = async (signal) => {
    if (terminationStarted) {
      return;
    }
    terminationStarted = true;
    const child = activeChild;
    if (child) {
      const childPids = new Set();
      discoverChildPids(child.pid, childPids);
      killChild(child, "SIGTERM");
      const graceDeadline = Date.now() + childTerminationGraceMs;
      while (Date.now() < graceDeadline) {
        await delay(10);
        discoverChildPids(child.pid, childPids);
      }
      killChild(child, "SIGKILL");
      discoverChildPids(child.pid, childPids);
      await reapIsolatedProcessTree(child.pid, childPids);
    }
    await rm(bundleDirectory, { recursive: true, force: true });
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const handleSigint = () => {
    void handleTermination("SIGINT");
  };
  const handleSigterm = () => {
    void handleTermination("SIGTERM");
  };
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  try {
    if (process.env.FOCUSED_API_TEST_INJECT_FAILURE === "after-tempdir") {
      const error = new Error(
        "injected focused API failure after tempdir creation",
      );
      error.exitCode = 73;
      throw error;
    }
    if (process.env.FOCUSED_API_TEST_INJECT_FAILURE === "esbuild") {
      await Promise.race([
        run("esbuild", [
          join(bundleDirectory, "intentional-missing-entry.ts"),
          "--bundle",
          "--platform=node",
          "--format=esm",
          `--outfile=${join(bundleDirectory, "intentional-missing-entry.test.mjs")}`,
        ]),
        termination,
      ]);
    }
    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
      "ignore-sigterm-during-esbuild"
    ) {
      const resistantBundler = join(bundleDirectory, "resistant-bundler.mjs");
      await writeFile(
        resistantBundler,
        'import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid);\nsetInterval(() => {}, 1_000);\n',
      );
      const bundlerEnvironment = {
        ...process.env,
        FOCUSED_API_TEST_RUNNER_PID: String(process.pid),
      };
      await Promise.race([
        run(process.execPath, [resistantBundler], {
          env: bundlerEnvironment,
          detached: true,
        }),
        termination,
      ]);
    }
    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
      "ignore-sigterm-bundler-helper-during-esbuild"
    ) {
      const resistantHelper = join(bundleDirectory, "resistant-helper.mjs");
      const resistantBundler = join(
        bundleDirectory,
        "resistant-bundler-with-helper.mjs",
      );
      await writeFile(
        resistantHelper,
        'process.on("SIGTERM", () => {});\nawait new Promise(() => {});\n',
      );
      await writeFile(
        resistantBundler,
        'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nconst helper = spawn(process.execPath, [process.env.FOCUSED_API_TEST_HELPER_SCRIPT], { stdio: "ignore" });\nhelper.on("spawn", () => { writeFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid + "," + helper.pid); });\nawait new Promise(() => {});\n',
      );
      const bundlerEnvironment = {
        ...process.env,
        FOCUSED_API_TEST_RUNNER_PID: String(process.pid),
        FOCUSED_API_TEST_HELPER_SCRIPT: resistantHelper,
      };
      await Promise.race([
        run(process.execPath, [resistantBundler], {
          env: bundlerEnvironment,
        }),
        termination,
      ]);
    }
    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
      "launch-helper-on-sigterm-during-esbuild"
    ) {
      const resistantHelper = join(bundleDirectory, "late-resistant-helper.mjs");
      const resistantBundler = join(
        bundleDirectory,
        "resistant-bundler-with-late-helper.mjs",
      );
      await writeFile(
        resistantHelper,
        'process.on("SIGTERM", () => {});\nawait new Promise(() => {});\n',
      );
      await writeFile(
        resistantBundler,
        'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nlet launched = false;\nprocess.on("SIGTERM", () => { if (launched) return; launched = true; const helper = spawn(process.execPath, [process.env.FOCUSED_API_TEST_HELPER_SCRIPT], { stdio: "ignore" }); writeFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid + "," + helper.pid); });\nwriteFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid);\nsetInterval(() => {}, 1_000);\n',
      );
      const bundlerEnvironment = {
        ...process.env,
        FOCUSED_API_TEST_RUNNER_PID: String(process.pid),
        FOCUSED_API_TEST_HELPER_SCRIPT: resistantHelper,
      };
      await Promise.race([
        run(process.execPath, [resistantBundler], {
          env: bundlerEnvironment,
        }),
        termination,
      ]);
    }
    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
      "continuously-launch-helpers-during-esbuild"
    ) {
      const resistantHelper = join(
        bundleDirectory,
        "replacement-resistant-helper.mjs",
      );
      const resistantBundler = join(
        bundleDirectory,
        "replacement-helper-bundler.mjs",
      );
      await writeFile(
        resistantHelper,
        'process.on("SIGTERM", () => {});\nawait new Promise(() => {});\n',
      );
      await writeFile(
        resistantBundler,
        'import { spawn } from "node:child_process";\nimport { appendFileSync, writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => { const launch = () => { const helper = spawn(process.execPath, [process.env.FOCUSED_API_TEST_HELPER_SCRIPT], { stdio: "ignore" }); helper.on("spawn", () => appendFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, "," + helper.pid)); }; launch(); setInterval(launch, 15); });\nwriteFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid);\nsetInterval(() => {}, 1_000);\n',
      );
      const bundlerEnvironment = {
        ...process.env,
        FOCUSED_API_TEST_RUNNER_PID: String(process.pid),
        FOCUSED_API_TEST_HELPER_SCRIPT: resistantHelper,
      };
      await Promise.race([
        run(process.execPath, [resistantBundler], {
          env: bundlerEnvironment,
          detached: true,
        }),
        termination,
      ]);
    }

    const bundledTests = [];
    for (const [bundleIndex, [entry, output, extraArguments = []]] of
      suite.bundles.entries()) {
      const outputPath = join(bundleDirectory, output);
      await Promise.race([
        run("esbuild", [
          entry,
          "--bundle",
          "--platform=node",
          "--format=esm",
          ...extraArguments,
          `--outfile=${outputPath}`,
        ]),
        termination,
      ]);
      bundledTests.push(outputPath);

      if (
        bundleIndex === 0 &&
        process.env.FOCUSED_API_TEST_INJECT_FAILURE === "later-esbuild"
      ) {
        console.error(
          "focused API first bundle ready before later esbuild failure",
        );
        await Promise.race([
          run("esbuild", [
            join(bundleDirectory, "intentional-missing-later-entry.ts"),
            "--bundle",
            "--platform=node",
            "--format=esm",
            `--outfile=${join(bundleDirectory, "intentional-missing-later-entry.test.mjs")}`,
          ]),
          termination,
        ]);
      }
    }

    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE === "await-sigint" ||
      process.env.FOCUSED_API_TEST_INJECT_FAILURE === "await-sigterm"
    ) {
      const awaitedSignal =
        process.env.FOCUSED_API_TEST_INJECT_FAILURE === "await-sigint"
          ? "SIGINT"
          : "SIGTERM";
      console.error(`focused API bundles ready for ${awaitedSignal}`);
      await termination;
    }

    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE === "bundled-test" ||
      process.env.FOCUSED_API_TEST_INJECT_FAILURE === "during-node-test" ||
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
        "await-sigterm-during-node-test" ||
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
        "ignore-sigterm-during-node-test"
    ) {
      const failingTest = join(bundleDirectory, "intentional-failure.test.mjs");
      const injection = process.env.FOCUSED_API_TEST_INJECT_FAILURE;
      const failureMessage =
        injection === "during-node-test"
          ? "injected focused API assertion failure after bundling"
          : "injected bundled-test failure";
      const testBody =
        injection === "await-sigterm-during-node-test" ||
        injection === "ignore-sigterm-during-node-test"
          ? `import { writeFileSync } from "node:fs";\nimport test from "node:test";\n${injection === "ignore-sigterm-during-node-test" ? 'process.on("SIGTERM", () => {});\n' : ""}test("wait for focused API SIGTERM", async () => { writeFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid); await new Promise(() => {}); });\n`
          : `import test from "node:test";\ntest(${JSON.stringify(failureMessage)}, () => { throw new Error(${JSON.stringify(failureMessage)}); });\n`;
      await writeFile(
        failingTest,
        testBody,
      );
      bundledTests.push(failingTest);
    }

    const testEnvironment = { ...process.env };
    delete testEnvironment.NODE_TEST_CONTEXT;
    testEnvironment.FOCUSED_API_TEST_RUNNER_PID = String(process.pid);
    await Promise.race([
      run(
        process.execPath,
        ["--test", ...bundledTests, ...(suite.tests ?? [])],
        { detached: true, env: testEnvironment },
      ),
      termination,
    ]);
  } finally {
    if (!terminationStarted) {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    }
    await rm(bundleDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
});