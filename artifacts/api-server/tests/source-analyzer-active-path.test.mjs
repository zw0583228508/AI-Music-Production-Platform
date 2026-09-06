import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("source analysis exposes only the current analysis entry point", async () => {
  const source = await readFile(
    new URL("../src/lib/sourceAnalyzer.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("analyzeProjectSourceBeforeTask1"), false);
  assert.equal(
    (source.match(/export async function analyzeProjectSource\s*\(/g) ?? []).length,
    1,
  );
});

test("verified bass external calls are fenced before and after by the owned source attempt", async () => {
  const source = await readFile(
    new URL("../src/lib/sourceAnalyzer.ts", import.meta.url),
    "utf8",
  );
  const before = source.indexOf('updateOwnedStage("bass_provider_analysis", 78)');
  const external = source.indexOf("await analyzeVerifiedBassStem({");
  const after = source.indexOf('updateOwnedStage("bass_provider_analysis_complete", 82)');
  assert.ok(before >= 0 && before < external);
  assert.ok(external < after);
  assert.match(source, /eq\(projectSourcesTable\.analysisLeaseId, attempt\.id\)/);
  assert.match(source, /gt\(projectSourcesTable\.analysisLeaseExpiresAt, now\)/);
});