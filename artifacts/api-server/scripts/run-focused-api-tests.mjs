import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
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

const supportedPermissionFailureCodes = new Set(["EPERM", "EACCES"]);
const supportedPidLimitReadFailureCodes = new Set([
  "EACCES",
  "EISDIR",
  "ENOENT",
  "EPERM",
]);
const supportedCleanupDiagnosticCodes = new Set([
  "EACCES",
  "EISDIR",
  "ENOENT",
  "EPERM",
  "ESRCH",
]);
const cleanupErrorMessageLimit = 240;
const startupErrorMessageLimit = 240;
const injectedPidLimitReadFailureCodes = new Map([
  ["UNEXPECTED_LONG", `E${"X".repeat(1_024)}`],
  ["UNEXPECTED_MALFORMED", { unexpected: "host error label" }],
]);
const injectedCleanupErrorCodes = new Map([
  ["UNEXPECTED_LONG", `E${"X".repeat(1_024)}`],
  ["UNEXPECTED_MALFORMED", { unexpected: "cleanup error label" }],
]);

function normalizeCleanupErrorCode(error) {
  try {
    const code = error?.code;
    return supportedCleanupDiagnosticCodes.has(code) ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function normalizePidLimitReadErrorCode(error) {
  try {
    const code = error?.code;
    return supportedPidLimitReadFailureCodes.has(code) ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function formatStartupErrorMessage(error) {
  try {
    const message = error?.message ?? error;
    const sanitized = String(message)
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (sanitized.length <= startupErrorMessageLimit) {
      return sanitized || "focused API runner failed";
    }
    return `${sanitized.slice(0, startupErrorMessageLimit - 3)}...`;
  } catch {
    return "focused API runner failed with unavailable error message";
  }
}

function normalizeStartupExitCode(error) {
  try {
    const exitCode = error?.exitCode;
    return Number.isSafeInteger(exitCode) && exitCode > 0 && exitCode <= 255
      ? exitCode
      : 1;
  } catch {
    return 1;
  }
}

function formatCleanupErrorMessage(error) {
  try {
    const message = error?.message ?? error;
    const sanitized = String(message)
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (sanitized.length <= cleanupErrorMessageLimit) {
      return sanitized;
    }
    return `${sanitized.slice(0, cleanupErrorMessageLimit - 3)}...`;
  } catch {
    return "unavailable error message";
  }
}

function injectedCleanupError(defaultMessage) {
  const error = new Error(
    process.env.FOCUSED_API_TEST_INJECT_CLEANUP_ERROR_MESSAGE ?? defaultMessage,
  );
  if (
    process.env.FOCUSED_API_TEST_INJECT_MALFORMED_CLEANUP_MESSAGE ===
    "throwing-code-getter"
  ) {
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("injected throwing cleanup code getter");
      },
      set() {},
    });
  } else if (
    process.env.FOCUSED_API_TEST_INJECT_MALFORMED_CLEANUP_MESSAGE ===
    "throwing-getter"
  ) {
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("injected throwing cleanup message getter");
      },
    });
  } else if (
    process.env.FOCUSED_API_TEST_INJECT_MALFORMED_CLEANUP_MESSAGE ===
    "throwing-string-conversion"
  ) {
    error.message = {
      toString() {
        throw new Error("injected throwing cleanup message conversion");
      },
    };
  }
  return error;
}

function injectedCleanupErrorCode(fallback) {
  return (
    injectedCleanupErrorCodes.get(
      process.env.FOCUSED_API_TEST_INJECT_UNUSUAL_CLEANUP_ERROR_CODE,
    ) ?? fallback
  );
}
const supportedFocusedFailureModes = new Set([
  "after-tempdir",
  "esbuild",
  "ignore-sigterm-during-esbuild",
  "ignore-sigterm-bundler-helper-during-esbuild",
  "reused-root-with-helper-during-esbuild",
  "launch-helper-on-sigterm-during-esbuild",
  "continuously-launch-helpers-during-esbuild",
  "prelaunch-four-helpers-during-esbuild",
  "later-esbuild",
  "await-sigint",
  "await-sigterm",
  "bundled-test",
  "during-node-test",
  "await-sigterm-during-node-test",
  "ignore-sigterm-during-node-test",
]);

function validateFocusedFaultSetting(environmentVariable, supportedValues) {
  const configuredValue = process.env[environmentVariable] ?? "";
  if (configuredValue === "" || supportedValues.has(configuredValue)) {
    return;
  }
  throw new Error(
    `${environmentVariable} has unsupported cleanup fault value: ${configuredValue}; supported values are ${[...supportedValues].join(", ")}`,
  );
}

function parseOptionalPositiveInteger(environmentVariable) {
  const configuredValue = process.env[environmentVariable] ?? "";
  if (configuredValue === "") {
    return undefined;
  }
  const parsedValue = Number(configuredValue);
  if (
    !/^[1-9]\d*$/u.test(configuredValue) ||
    !Number.isSafeInteger(parsedValue)
  ) {
    throw new Error(
      `${environmentVariable} has invalid process ID target: ${configuredValue}; accepted format is a positive base-10 integer`,
    );
  }
  const pidLimitSetting = "/proc/sys/kernel/pid_max";
  const pidLimitInput =
    process.env.FOCUSED_API_TEST_PID_MAX_OVERRIDE_FILE ?? pidLimitSetting;
  let pidLimitValue;
  try {
    const injectedReadFailure =
      process.env.FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE;
    if (injectedReadFailure) {
      const error = new Error("injected denied host PID limit read");
      if (injectedReadFailure === "THROWING_GETTER") {
        Object.defineProperty(error, "code", {
          get() {
            throw new Error("injected throwing host PID limit code getter");
          },
        });
      } else if (injectedReadFailure !== "UNKNOWN") {
        error.code =
          injectedPidLimitReadFailureCodes.get(injectedReadFailure) ??
          injectedReadFailure;
      }
      throw error;
    }
    pidLimitValue = readFileSync(pidLimitInput, "utf8").trim();
  } catch (error) {
    const errorCode = normalizePidLimitReadErrorCode(error);
    throw new Error(
      `focused API runner could not read host kernel setting ${pidLimitSetting}: ${errorCode}`,
    );
  }
  const pidWrapPoint = Number(pidLimitValue);
  if (
    !/^[1-9]\d*$/u.test(pidLimitValue) ||
    !Number.isSafeInteger(pidWrapPoint) ||
    pidWrapPoint <= 1
  ) {
    throw new Error(
      `focused API runner found malformed host kernel setting ${pidLimitSetting}; expected a base-10 integer greater than 1`,
    );
  }
  const maximumSupportedPid = pidWrapPoint - 1;
  if (parsedValue > maximumSupportedPid) {
    throw new Error(
      `${environmentVariable} has unsupported process ID target: ${configuredValue}; accepted host range is 1-${maximumSupportedPid}`,
    );
  }
  return parsedValue;
}

validateFocusedFaultSetting(
  "FOCUSED_API_TEST_INJECT_FAILURE",
  supportedFocusedFailureModes,
);
for (const environmentVariable of [
  "FOCUSED_API_TEST_INJECT_PROCESS_DIRECTORY_READ_FAILURE",
  "FOCUSED_API_TEST_INJECT_ROOT_IDENTITY_CAPTURE_FAILURE",
]) {
  validateFocusedFaultSetting(environmentVariable, new Set(["true"]));
}
validateFocusedFaultSetting(
  "FOCUSED_API_TEST_INJECT_PID_MAX_READ_FAILURE",
  new Set([
    ...supportedPermissionFailureCodes,
    "UNKNOWN",
    "THROWING_GETTER",
    ...injectedPidLimitReadFailureCodes.keys(),
  ]),
);
validateFocusedFaultSetting(
  "FOCUSED_API_TEST_INJECT_UNUSUAL_CLEANUP_ERROR_CODE",
  new Set(injectedCleanupErrorCodes.keys()),
);
validateFocusedFaultSetting(
  "FOCUSED_API_TEST_INJECT_MALFORMED_CLEANUP_MESSAGE",
  new Set([
    "throwing-code-getter",
    "throwing-getter",
    "throwing-string-conversion",
  ]),
);
validateFocusedFaultSetting(
  "FOCUSED_API_TEST_INJECT_MALFORMED_STARTUP_ERROR",
  new Set([
    "throwing-code-getter",
    "throwing-exit-code-getter",
    "throwing-message-getter",
    "throwing-message-conversion",
  ]),
);

function parsePermissionFailureCodes(
  environmentVariable,
  passthroughValues = [],
  allowMultiple = true,
) {
  const configuredValue = process.env[environmentVariable] ?? "";
  if (configuredValue === "" || passthroughValues.includes(configuredValue)) {
    return [];
  }
  const errorCodes = configuredValue.split(",");
  const unsupportedCodes = errorCodes.filter(
    (errorCode) => !supportedPermissionFailureCodes.has(errorCode),
  );
  if (unsupportedCodes.length > 0 || (!allowMultiple && errorCodes.length > 1)) {
    throw new Error(
      `${environmentVariable} has unsupported cleanup fault value: ${configuredValue}; supported values are ${passthroughValues.length > 0 ? `${passthroughValues.join(", ")}, ` : ""}EPERM and EACCES${allowMultiple ? " (including comma-separated combinations)" : ""}`,
    );
  }
  return errorCodes;
}

function parseDirectSignalFailureConfiguration() {
  const environmentVariable =
    "FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE";
  const configuredValue = process.env[environmentVariable] ?? "";
  if (
    configuredValue === "" ||
    configuredValue === "true" ||
    supportedPermissionFailureCodes.has(configuredValue)
  ) {
    return new Map();
  }
  const configuration = new Map();
  const unsupportedEntries = [];
  for (const entry of configuredValue.split(",")) {
    const [signal, errorCode, ...extraParts] = entry.split(":");
    if (
      extraParts.length > 0 ||
      (signal !== "SIGTERM" && signal !== "SIGKILL") ||
      !supportedPermissionFailureCodes.has(errorCode)
    ) {
      unsupportedEntries.push(entry);
      continue;
    }
    const errorCodes = configuration.get(signal) ?? [];
    if (!errorCodes.includes(errorCode)) {
      errorCodes.push(errorCode);
    }
    configuration.set(signal, errorCodes);
  }
  if (unsupportedEntries.length > 0) {
    throw new Error(
      `${environmentVariable} has unsupported cleanup fault entr${unsupportedEntries.length === 1 ? "y" : "ies"}: ${unsupportedEntries.join(", ")}; supported values are true, EPERM, EACCES, or comma-separated SIGTERM or SIGKILL entries with EPERM or EACCES`,
    );
  }
  return configuration;
}

let activeChild;
const childTerminationGraceMs = 500;
const childReapingTimeoutMs = 3_000;
let injectedProcessStatReadFailure = false;
let injectedProcessDirectoryReadFailure = false;
const reportedProcessExistenceFailures = new Set();
const processExistenceFailureDetailLimit = 1;
const processExistenceFailureSummaryPidLimit = 10;
const processExistenceFailureGroups = new Map();
const processExistenceFailureConfiguration = parsePermissionFailureCodes(
  "FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE",
  ["true"],
);
const processExistenceFailureAssignments = new Map();
const reportedProcessStatReadFailures = new Set();
const processStatReadFailureDetailLimit = 1;
const processStatReadFailureSummaryPidLimit = 10;
const processStatReadFailureGroups = new Map();
const processStatReadFailureConfiguration = parsePermissionFailureCodes(
  "FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE",
  ["true", "all"],
);
const processStatReadFailureAssignments = new Map();
const reportedDirectSignalFailures = new Set();
const directSignalFailureDetailLimit = 1;
const directSignalFailureSummaryPidLimit = 10;
const directSignalFailureGroups = new Map();
const reportedReusedPids = new Set();
const reusedPidTarget = parseOptionalPositiveInteger(
  "FOCUSED_API_TEST_INJECT_REUSED_PID_TARGET",
);
const directSignalFailureConfiguration =
  parseDirectSignalFailureConfiguration();
parsePermissionFailureCodes(
  "FOCUSED_API_TEST_INJECT_PROCESS_GROUP_SIGNAL_FAILURE",
  ["true"],
  false,
);
const directSignalFailureAssignments = new Map();
const reportedProcessGroupSignalFailures = new Set();

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseProcessStat(stat) {
  const match = stat.trim().match(/^(\d+) \(.*\) (.+)$/u);
  if (!match) {
    return undefined;
  }
  const fields = match[2].split(" ");
  if (fields.length < 20) {
    return undefined;
  }
  return {
    pid: Number(match[1]),
    parentPid: Number(fields[1]),
    sessionId: Number(fields[3]),
    startTime: fields[19],
  };
}

function readProcessRecord(pid) {
  const processRecord = parseProcessStat(
    readFileSync(`/proc/${pid}/stat`, "utf8"),
  );
  const overridePath = process.env.FOCUSED_API_TEST_PROCESS_STAT_OVERRIDE_FILE;
  if (!processRecord || !overridePath) {
    return processRecord;
  }
  try {
    const override = JSON.parse(readFileSync(overridePath, "utf8"));
    return override.pid === pid
      ? { ...processRecord, startTime: override.startTime }
      : processRecord;
  } catch (error) {
    if (
      process.env.FOCUSED_API_TEST_INJECT_MALFORMED_STARTUP_ERROR ===
      "throwing-code-getter"
    ) {
      Object.defineProperty(error, "code", {
        get() {
          throw new Error("injected throwing startup code getter");
        },
      });
    }
    if (normalizeCleanupErrorCode(error) === "ENOENT") {
      return processRecord;
    }
    throw error;
  }
}

function reportReusedPid(pid) {
  if (reportedReusedPids.has(pid)) {
    return;
  }
  reportedReusedPids.add(pid);
  console.error(
    `focused API cleanup skipped reused process ID ${pid}; process identity changed`,
  );
}

function listIsolatedChildProcesses(rootPid) {
  const childrenByParent = new Map();
  const processesByPid = new Map();
  const pidsInSession = [];
  let entries;
  try {
    if (
      !injectedProcessDirectoryReadFailure &&
      process.env.FOCUSED_API_TEST_INJECT_PROCESS_DIRECTORY_READ_FAILURE ===
        "true"
    ) {
      injectedProcessDirectoryReadFailure = true;
      const error = injectedCleanupError("injected unreadable process table");
      error.code = injectedCleanupErrorCode("EACCES");
      throw error;
    }
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch (error) {
    const errorCode = normalizeCleanupErrorCode(error);
    console.error(
      `focused API cleanup could not enumerate /proc: ${errorCode} ${formatCleanupErrorMessage(error)}`,
    );
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    try {
      let assignedFailure = processStatReadFailureAssignments.get(entry.name);
      if (
        !assignedFailure &&
        processStatReadFailureConfiguration.length > 0
      ) {
        assignedFailure =
          processStatReadFailureConfiguration[
            processStatReadFailureAssignments.size %
              processStatReadFailureConfiguration.length
          ];
        processStatReadFailureAssignments.set(entry.name, assignedFailure);
      }
      if (
        (process.env.FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE ===
          "all" ||
          (!injectedProcessStatReadFailure &&
            process.env.FOCUSED_API_TEST_INJECT_PROCESS_STAT_READ_FAILURE ===
              "true" &&
            entry.name === String(rootPid)) ||
          assignedFailure)
      ) {
        injectedProcessStatReadFailure = true;
        const error = injectedCleanupError(
          "injected unreadable process record",
        );
        error.code = injectedCleanupErrorCode(assignedFailure ?? "EACCES");
        throw error;
      }
      const processRecord = parseProcessStat(
        readFileSync(`/proc/${entry.name}/stat`, "utf8"),
      );
      if (!processRecord) {
        continue;
      }
      const { pid, parentPid, sessionId } = processRecord;
      processesByPid.set(pid, processRecord);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
      if (sessionId === rootPid) {
        pidsInSession.push(pid);
      }
    } catch (error) {
      const errorCode = normalizeCleanupErrorCode(error);
      if (errorCode === "ENOENT" || errorCode === "ESRCH") {
        continue;
      }
      const failureKey = `${entry.name}:${errorCode}`;
      if (!reportedProcessStatReadFailures.has(failureKey)) {
        reportedProcessStatReadFailures.add(failureKey);
        const group = processStatReadFailureGroups.get(errorCode) ?? {
          errorCode,
          detailedCount: 0,
          additionalPids: new Set(),
        };
        processStatReadFailureGroups.set(errorCode, group);
        if (group.detailedCount < processStatReadFailureDetailLimit) {
          group.detailedCount += 1;
          console.error(
            `focused API cleanup could not read /proc/${entry.name}/stat: ${errorCode} ${formatCleanupErrorMessage(error)}`,
          );
        } else {
          group.additionalPids.add(Number(entry.name));
        }
      }
    }
  }

  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return [...new Set([rootPid, ...pidsInSession, ...descendants])]
    .map((pid) => processesByPid.get(pid))
    .filter(Boolean);
}

function reportProcessStatReadFailureSummaries() {
  for (const group of processStatReadFailureGroups.values()) {
    if (group.additionalPids.size === 0) {
      continue;
    }
    const sampledPids = [...group.additionalPids].slice(
      0,
      processStatReadFailureSummaryPidLimit,
    );
    const remainingCount = group.additionalPids.size - sampledPids.length;
    console.error(
      `focused API cleanup suppressed detailed ${group.errorCode} process record read failures for ${group.additionalPids.size} additional processes; affected PIDs: ${sampledPids.join(", ")}${remainingCount > 0 ? `, and ${remainingCount} more` : ""}`,
    );
  }
}

function checkProcessState(
  pid,
  expectedStartTime,
  rootPid,
  ignoreInjectedFailure = false,
) {
  try {
    const injectedFailure =
      process.env.FOCUSED_API_TEST_INJECT_PROCESS_EXISTENCE_CHECK_FAILURE;
    let assignedFailure = processExistenceFailureAssignments.get(pid);
    if (
      !assignedFailure &&
      processExistenceFailureConfiguration.length > 1
    ) {
      assignedFailure =
        processExistenceFailureConfiguration[
          processExistenceFailureAssignments.size %
            processExistenceFailureConfiguration.length
        ];
      processExistenceFailureAssignments.set(pid, assignedFailure);
    }
    if (
      !ignoreInjectedFailure &&
      (
      injectedFailure === "true" ||
      injectedFailure === "EPERM" ||
      injectedFailure === "EACCES" ||
      assignedFailure
      )
    ) {
      const error = injectedCleanupError(
        "injected denied process existence check",
      );
      error.code = injectedCleanupErrorCode(
        assignedFailure ??
          (injectedFailure === "true" ? "EPERM" : injectedFailure),
      );
      throw error;
    }
    const processRecord = readProcessRecord(pid);
    if (!processRecord) {
      throw new Error(`unparseable /proc/${pid}/stat`);
    }
    if (processRecord.startTime !== expectedStartTime) {
      reportReusedPid(pid);
      return "reused";
    }
    return "alive";
  } catch (error) {
    const errorCode = normalizeCleanupErrorCode(error);
    if (errorCode === "ENOENT" || errorCode === "ESRCH") {
      return "absent";
    }
    const failureKey = `${pid}:${errorCode}`;
    if (!reportedProcessExistenceFailures.has(failureKey)) {
      reportedProcessExistenceFailures.add(failureKey);
      const group = processExistenceFailureGroups.get(errorCode) ?? {
        errorCode,
        detailedCount: 0,
        additionalPids: new Set(),
      };
      processExistenceFailureGroups.set(errorCode, group);
      if (group.detailedCount < processExistenceFailureDetailLimit) {
        group.detailedCount += 1;
        console.error(
          `focused API cleanup could not check whether process ${pid} exists: ${errorCode} ${formatCleanupErrorMessage(error)}`,
        );
      } else {
        group.additionalPids.add(pid);
      }
    }
    return "unknown";
  }
}

function reportProcessExistenceFailureSummaries() {
  for (const group of processExistenceFailureGroups.values()) {
    if (group.additionalPids.size === 0) {
      continue;
    }
    const sampledPids = [...group.additionalPids].slice(
      0,
      processExistenceFailureSummaryPidLimit,
    );
    const remainingCount = group.additionalPids.size - sampledPids.length;
    console.error(
      `focused API cleanup suppressed detailed ${group.errorCode} process existence-check failures for ${group.additionalPids.size} additional processes; affected PIDs: ${sampledPids.join(", ")}${remainingCount > 0 ? `, and ${remainingCount} more` : ""}`,
    );
  }
}

function signalProcess(
  pid,
  expectedStartTime,
  signal,
  processGroup = false,
  isRoot = false,
) {
  try {
    const injectedDirectFailure =
      process.env.FOCUSED_API_TEST_INJECT_DIRECT_PROCESS_SIGNAL_FAILURE;
    const configuredSignalFailures =
      directSignalFailureConfiguration.get(signal) ?? [];
    const assignmentKey = `${signal}:${pid}`;
    let signalFailure = directSignalFailureAssignments.get(assignmentKey);
    if (!signalFailure && configuredSignalFailures.length > 0) {
      signalFailure =
        configuredSignalFailures[
          directSignalFailureAssignments.size %
            configuredSignalFailures.length
        ];
      directSignalFailureAssignments.set(assignmentKey, signalFailure);
    }
    const injectedProcessGroupFailure =
      process.env.FOCUSED_API_TEST_INJECT_PROCESS_GROUP_SIGNAL_FAILURE;
    const processRecord = readProcessRecord(pid);
    if (!processRecord) {
      throw new Error(`unparseable /proc/${pid}/stat`);
    }
    const injectSignalRace = reusedPidTarget === pid;
    if (
      injectSignalRace ||
      processRecord.startTime !== expectedStartTime
    ) {
      reportReusedPid(pid);
      return "reused";
    }
    if (process.env.FOCUSED_API_TEST_SIGNAL_ATTEMPT_FILE) {
      appendFileSync(
        process.env.FOCUSED_API_TEST_SIGNAL_ATTEMPT_FILE,
        `${pid},${signal},${processGroup ? "group" : "direct"}\n`,
      );
    }
    if (
      (injectedDirectFailure === "true" ||
        injectedDirectFailure === "EPERM" ||
        injectedDirectFailure === "EACCES" ||
        signalFailure) &&
      !isRoot
    ) {
      const error = injectedCleanupError(
        "injected denied direct process signal",
      );
      error.code = injectedCleanupErrorCode(
        signalFailure ??
        (injectedDirectFailure === "true"
          ? "EPERM"
          : injectedDirectFailure),
      );
      throw error;
    }
    if (
      processGroup &&
      isRoot &&
      (injectedProcessGroupFailure === "true" ||
        injectedProcessGroupFailure === "EPERM" ||
        injectedProcessGroupFailure === "EACCES")
    ) {
      const error = injectedCleanupError(
        "injected denied process-group signal",
      );
      error.code = injectedCleanupErrorCode(
        injectedProcessGroupFailure === "true"
          ? "EPERM"
          : injectedProcessGroupFailure,
      );
      throw error;
    }
    // Node has no pidfd signal API. Keep the verified /proc identity check and
    // numeric signal adjacent so no runner work widens the unavoidable syscall race.
    process.kill(processGroup ? -pid : pid, signal);
    return "signaled";
  } catch (error) {
    const errorCode = normalizeCleanupErrorCode(error);
    if (errorCode === "ENOENT" || errorCode === "ESRCH") {
      return "absent";
    }
    if (processGroup && isRoot) {
      const failureKey = `${pid}:${signal}:${errorCode}`;
      if (!reportedProcessGroupSignalFailures.has(failureKey)) {
        reportedProcessGroupSignalFailures.add(failureKey);
        console.error(
          `focused API cleanup could not signal process group ${pid} with ${signal}: ${errorCode} ${formatCleanupErrorMessage(error)}`,
        );
      }
      return "unknown";
    }
    const failureKey = `${pid}:${signal}:${errorCode}`;
    if (!reportedDirectSignalFailures.has(failureKey)) {
      reportedDirectSignalFailures.add(failureKey);
      const groupKey = `${signal}:${errorCode}`;
      const group = directSignalFailureGroups.get(groupKey) ?? {
        signal,
        errorCode,
        detailedCount: 0,
        additionalPids: new Set(),
      };
      directSignalFailureGroups.set(groupKey, group);
      if (group.detailedCount < directSignalFailureDetailLimit) {
        group.detailedCount += 1;
        console.error(
          `focused API cleanup could not signal process ${pid} with ${signal}: ${errorCode} ${formatCleanupErrorMessage(error)}`,
        );
      } else {
        group.additionalPids.add(pid);
      }
    }
    return "unknown";
  }
}

function reportDirectSignalFailureSummaries() {
  for (const group of directSignalFailureGroups.values()) {
    if (group.additionalPids.size === 0) {
      continue;
    }
    const sampledPids = [...group.additionalPids].slice(
      0,
      directSignalFailureSummaryPidLimit,
    );
    const remainingCount = group.additionalPids.size - sampledPids.length;
    console.error(
      `focused API cleanup suppressed detailed ${group.signal} ${group.errorCode} signal failures for ${group.additionalPids.size} additional processes; affected PIDs: ${sampledPids.join(", ")}${remainingCount > 0 ? `, and ${remainingCount} more` : ""}`,
    );
  }
}

async function reapIsolatedProcessTree(rootPid, knownPids) {
  const deadline = Date.now() + childReapingTimeoutMs;
  while (Date.now() < deadline) {
    discoverChildPids(rootPid, knownPids);
    const states = [...knownPids].map(([pid, startTime]) => [
      pid,
      checkProcessState(pid, startTime, rootPid),
    ]);
    const survivors = states.filter(([, state]) => state === "alive");
    const unconfirmed = states.filter(([, state]) => state === "unknown");
    if (survivors.length === 0 && unconfirmed.length === 0) {
      return;
    }
    for (const [pid] of survivors.toReversed()) {
      const signalState = signalProcess(
        pid,
        knownPids.get(pid),
        "SIGKILL",
      );
      if (signalState === "reused") {
        knownPids.delete(pid);
      }
    }
    await delay(10);
  }
  const states = [...knownPids].map(([pid, startTime]) => [
    pid,
    checkProcessState(pid, startTime, rootPid),
  ]);
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
    const sampledPids = unconfirmed.slice(
      0,
      processExistenceFailureSummaryPidLimit,
    );
    const remainingCount = unconfirmed.length - sampledPids.length;
    console.error(
      `focused API cleanup could not confirm process exit after bounded reaping: ${sampledPids.join(", ")}${remainingCount > 0 ? `, and ${remainingCount} more` : ""}`,
    );
  }
}

function discoverChildPids(rootPid, knownPids) {
  const rootStartTime = knownPids.get(rootPid);
  if (
    rootStartTime === undefined ||
    checkProcessState(rootPid, rootStartTime, rootPid, true) !== "alive"
  ) {
    return;
  }
  for (const { pid, startTime } of listIsolatedChildProcesses(rootPid)) {
    if (!knownPids.has(pid)) {
      knownPids.set(pid, startTime);
    }
  }
  if (reusedPidTarget === undefined || knownPids.has(reusedPidTarget)) {
    return;
  }
  try {
    const processRecord = parseProcessStat(
      readFileSync(`/proc/${reusedPidTarget}/stat`, "utf8"),
    );
    if (processRecord) {
      knownPids.set(reusedPidTarget, processRecord.startTime);
    }
  } catch (error) {
    const errorCode = normalizeCleanupErrorCode(error);
    if (errorCode !== "ENOENT" && errorCode !== "ESRCH") {
      throw error;
    }
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.focusedIsolatedProcessGroup = options.detached === true;
    try {
      if (
        process.env.FOCUSED_API_TEST_INJECT_ROOT_IDENTITY_CAPTURE_FAILURE ===
        "true"
      ) {
        const error = injectedCleanupError(
          "injected root identity capture failure",
        );
        error.code = injectedCleanupErrorCode("ENOENT");
        throw error;
      }
      child.focusedProcessStartTime = readProcessRecord(child.pid)?.startTime;
    } catch (error) {
      const errorCode = normalizeCleanupErrorCode(error);
      if (errorCode !== "ENOENT" && errorCode !== "ESRCH") {
        console.error(
          `focused API cleanup could not capture root process ${child.pid} identity: ${errorCode} ${formatCleanupErrorMessage(error)}`,
        );
      }
    }
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
    throw new Error(
      `unknown focused API test suite: ${suiteName ?? "(missing)"}`,
    );
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
      const childPids = new Map();
      let rootStartTime = child.focusedProcessStartTime;
      if (
        rootStartTime === undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          rootStartTime = readProcessRecord(child.pid)?.startTime;
        } catch (error) {
          const errorCode = normalizeCleanupErrorCode(error);
          if (errorCode !== "ENOENT" && errorCode !== "ESRCH") {
            console.error(
              `focused API cleanup could not recover root process ${child.pid} identity: ${errorCode} ${formatCleanupErrorMessage(error)}`,
            );
          }
        }
      }
      if (rootStartTime !== undefined) {
        childPids.set(child.pid, rootStartTime);
        discoverChildPids(child.pid, childPids);
        signalProcess(
          child.pid,
          rootStartTime,
          "SIGTERM",
          child.focusedIsolatedProcessGroup,
          true,
        );
        const graceDeadline = Date.now() + childTerminationGraceMs;
        while (Date.now() < graceDeadline) {
          await delay(10);
          discoverChildPids(child.pid, childPids);
        }
        for (const [pid, startTime] of [...childPids].toReversed()) {
          if (pid === child.pid) {
            continue;
          }
          const signalState = signalProcess(pid, startTime, "SIGTERM");
          if (signalState === "reused") {
            childPids.delete(pid);
          }
        }
        for (const [pid, startTime] of [...childPids].toReversed()) {
          if (pid === child.pid) {
            continue;
          }
          const signalState = signalProcess(pid, startTime, "SIGKILL");
          if (signalState === "reused") {
            childPids.delete(pid);
          }
        }
        const rootSignalState = signalProcess(
          child.pid,
          rootStartTime,
          "SIGKILL",
          child.focusedIsolatedProcessGroup,
          true,
        );
        if (rootSignalState === "reused") {
          childPids.delete(child.pid);
        }
        discoverChildPids(child.pid, childPids);
        await reapIsolatedProcessTree(child.pid, childPids);
      } else {
        child.kill("SIGTERM");
        await delay(childTerminationGraceMs);
        child.kill("SIGKILL");
      }
      reportProcessStatReadFailureSummaries();
      reportProcessExistenceFailureSummaries();
      reportDirectSignalFailureSummaries();
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
      const malformedStartupError =
        process.env.FOCUSED_API_TEST_INJECT_MALFORMED_STARTUP_ERROR;
      if (malformedStartupError === "throwing-exit-code-getter") {
        Object.defineProperty(error, "exitCode", {
          get() {
            throw new Error("injected throwing startup exit code getter");
          },
        });
      } else {
        error.exitCode = 73;
      }
      if (malformedStartupError === "throwing-message-getter") {
        Object.defineProperty(error, "message", {
          get() {
            throw new Error("injected throwing startup message getter");
          },
        });
      } else if (malformedStartupError === "throwing-message-conversion") {
        error.message = {
          toString() {
            throw new Error("injected throwing startup message conversion");
          },
        };
      }
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
        'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1_000);\n',
      );
      await writeFile(
        resistantBundler,
        'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nconst helper = spawn(process.execPath, [process.env.FOCUSED_API_TEST_HELPER_SCRIPT], { stdio: "ignore" });\nhelper.on("spawn", () => { writeFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid + "," + helper.pid); });\nsetInterval(() => {}, 1_000);\n',
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
    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
      "reused-root-with-helper-during-esbuild"
    ) {
      const unrelatedHelper = join(
        bundleDirectory,
        "reused-root-unrelated-helper.mjs",
      );
      const reusedRoot = join(bundleDirectory, "reused-root-bundler.mjs");
      await writeFile(unrelatedHelper, "setInterval(() => {}, 1_000);\n");
      await writeFile(
        reusedRoot,
        'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst helper = spawn(process.execPath, [process.env.FOCUSED_API_TEST_HELPER_SCRIPT], { stdio: "ignore" });\nhelper.on("spawn", () => { setTimeout(() => { if (process.env.FOCUSED_API_TEST_PROCESS_STAT_OVERRIDE_FILE) writeFileSync(process.env.FOCUSED_API_TEST_PROCESS_STAT_OVERRIDE_FILE, JSON.stringify({ pid: process.pid, startTime: "simulated-reused-root" })); writeFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid + "," + helper.pid); }, 50); });\nsetInterval(() => {}, 1_000);\n',
      );
      const bundlerEnvironment = {
        ...process.env,
        FOCUSED_API_TEST_RUNNER_PID: String(process.pid),
        FOCUSED_API_TEST_HELPER_SCRIPT: unrelatedHelper,
      };
      await Promise.race([
        run(process.execPath, [reusedRoot], {
          env: bundlerEnvironment,
          stdio: "ignore",
        }),
        termination,
      ]);
    }
    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
      "launch-helper-on-sigterm-during-esbuild"
    ) {
      const resistantHelper = join(
        bundleDirectory,
        "late-resistant-helper.mjs",
      );
      const resistantBundler = join(
        bundleDirectory,
        "resistant-bundler-with-late-helper.mjs",
      );
      await writeFile(
        resistantHelper,
        'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1_000);\n',
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
        'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1_000);\n',
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
    if (
      process.env.FOCUSED_API_TEST_INJECT_FAILURE ===
      "prelaunch-four-helpers-during-esbuild"
    ) {
      const resistantHelper = join(
        bundleDirectory,
        "prelaunched-resistant-helper.mjs",
      );
      const resistantBundler = join(
        bundleDirectory,
        "prelaunched-helper-bundler.mjs",
      );
      await writeFile(
        resistantHelper,
        'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1_000);\n',
      );
      await writeFile(
        resistantBundler,
        'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nconst launch = () => new Promise((resolve) => { const helper = spawn(process.execPath, [process.env.FOCUSED_API_TEST_HELPER_SCRIPT], { stdio: "ignore" }); helper.on("spawn", () => resolve(helper.pid)); });\nconst helpers = await Promise.all(Array.from({ length: 4 }, launch));\nwriteFileSync(process.env.FOCUSED_API_TEST_HANDSHAKE_FILE, process.env.FOCUSED_API_TEST_RUNNER_PID + "," + process.pid + "," + helpers.join(","));\nsetInterval(() => {}, 1_000);\n',
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
    for (const [
      bundleIndex,
      [entry, output, extraArguments = []],
    ] of suite.bundles.entries()) {
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
      await writeFile(failingTest, testBody);
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
  console.error(formatStartupErrorMessage(error));
  process.exitCode = normalizeStartupExitCode(error);
});
