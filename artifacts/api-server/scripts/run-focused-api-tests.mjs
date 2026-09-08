import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const handleTermination = (signal) => {
    activeChild?.kill("SIGTERM");
    rmSync(bundleDirectory, { recursive: true, force: true });
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.kill(process.pid, signal);
  };
  const handleSigint = () => handleTermination("SIGINT");
  const handleSigterm = () => handleTermination("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
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
      process.env.FOCUSED_API_TEST_INJECT_FAILURE === "during-node-test"
    ) {
      const failingTest = join(bundleDirectory, "intentional-failure.test.mjs");
      const failureMessage =
        process.env.FOCUSED_API_TEST_INJECT_FAILURE === "during-node-test"
          ? "injected focused API assertion failure after bundling"
          : "injected bundled-test failure";
      await writeFile(
        failingTest,
        `import test from "node:test";\ntest(${JSON.stringify(failureMessage)}, () => { throw new Error(${JSON.stringify(failureMessage)}); });\n`,
      );
      bundledTests.push(failingTest);
    }

    const testEnvironment = { ...process.env };
    delete testEnvironment.NODE_TEST_CONTEXT;
    await Promise.race([
      run(
        process.execPath,
        ["--test", ...bundledTests, ...(suite.tests ?? [])],
        { env: testEnvironment },
      ),
      termination,
    ]);
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    await rm(bundleDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
});