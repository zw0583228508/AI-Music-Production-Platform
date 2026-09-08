import { readFile, writeFile } from "node:fs/promises";
import {
  cleanupHistoricalExportLeftovers,
  reportHistoricalExportLeftovers,
} from "./lib/artifactLifecycle";
import type { ExportReconciliationReport } from "./lib/objectStorage";
import { formatHostErrorMessage } from "./lib/hostErrorDiagnostics";

function injectedHostError(): unknown {
  switch (process.env.API_HOST_ERROR_DIAGNOSTICS_TEST_CASE) {
    case "message-getter":
      return Object.create(null, {
        message: {
          get() {
            throw new Error("hostile message getter escaped");
          },
        },
      });
    case "message-conversion":
      return {
        message: {
          toString() {
            throw new Error("hostile string conversion escaped");
          },
        },
      };
    case "inspection-hook":
      return {
        message: `root diagnostic ${"x".repeat(400)}`,
        [Symbol.for("nodejs.util.inspect.custom")]() {
          throw new Error("hostile inspection escaped");
        },
      };
    default:
      return undefined;
  }
}

function usage(): never {
  throw new Error(
    "Usage: exports:reconcile report <minimum-age-days> <report.json> | " +
      "cleanup <minimum-age-days> <reviewed-report.json> --confirm-reviewed",
  );
}

function minimumAgeMs(value: string | undefined): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) usage();
  return days * 24 * 60 * 60 * 1000;
}

async function main(): Promise<void> {
  const injectedError = injectedHostError();
  if (injectedError !== undefined) throw injectedError;

  const [command, ageValue, reportPath, confirmation] = process.argv.slice(2);
  if (!reportPath) usage();
  const ageMs = minimumAgeMs(ageValue);
  if (command === "report") {
    const report = await reportHistoricalExportLeftovers(ageMs);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        dryRun: true,
        reportPath,
        entries: report.entries.length,
        cleanupCandidates: report.cleanupCandidates.length,
      }),
    );
    return;
  }
  if (command !== "cleanup" || confirmation !== "--confirm-reviewed") usage();
  const reviewed = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as Partial<ExportReconciliationReport>;
  if (
    reviewed.dryRun !== true ||
    reviewed.minimumAgeMs !== ageMs ||
    !Array.isArray(reviewed.cleanupCandidates) ||
    reviewed.cleanupCandidates.some((value) => typeof value !== "string")
  ) {
    throw new Error(
      "Reviewed report is invalid or does not match the requested age threshold",
    );
  }
  const deleted = await cleanupHistoricalExportLeftovers({
    minimumAgeMs: ageMs,
    reviewedCandidates: reviewed.cleanupCandidates,
    dryRunReviewed: true,
  });
  console.log(JSON.stringify({ deletedCount: deleted.length, deleted }));
}

main().catch((error: unknown) => {
  console.error(formatHostErrorMessage(error, "Export reconciliation failed"));
  process.exitCode = 1;
});