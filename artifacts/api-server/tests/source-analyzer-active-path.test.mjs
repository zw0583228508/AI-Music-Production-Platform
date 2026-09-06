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