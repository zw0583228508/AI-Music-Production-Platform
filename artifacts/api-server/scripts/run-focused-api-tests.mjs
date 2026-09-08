import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
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

function killChild(child, signal) {
  try {
    if (child.spawnargs[1] === "--test") {
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

async function listIsolatedChildPids(rootPid) {
  const childrenByParent = new Map();
  const pidsInSession = [];
  const entries = await readdir("/proc", { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry) => {
        try {
          const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
          const match = stat.match(/^(\d+) \(.*\) \S+ (\d+) \d+ (\d+) /u);
          if (!match) {
            return;
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
          if (error?.code !== "ENOENT" && error?.code !== "ESRCH") {
            throw error;
          }
        }
      }),
  );

  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return [...new Set([rootPid, ...pidsInSession, ...descendants])];
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

function killProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForProcessesToExit(pids) {
  const deadline = Date.now() + childReapingTimeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) {
      return;
    }
    await delay(10);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
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
      const childPids = await listIsolatedChildPids(child.pid);
      killChild(child, "SIGTERM");
      await delay(childTerminationGraceMs);
      killChild(child, "SIGKILL");
      for (const pid of childPids.toReversed()) {
        killProcess(pid, "SIGKILL");
      }
      await waitForProcessesToExit(childPids);
    }
    rmSync(bundleDirectory, { recursive: true, force: true });
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.kill(process.pid, signal);
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
        'import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid);\nawait new Promise(() => {});\n',
      );
      const bundlerEnvironment = {
        ...process.env,
        FOCUSED_API_TEST_RUNNER_PID: String(process.pid),
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