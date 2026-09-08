import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { unlink } from "node:fs/promises";
import { build } from "esbuild";
import { formatHostErrorMessage as formatBuildError } from "../scripts/host-error-diagnostics.mjs";

const artifactDir = new URL("..", import.meta.url).pathname;
const bundlePath = new URL(
  `./host-error-diagnostics-${process.pid}.tmp.mjs`,
  import.meta.url,
).pathname;

await build({
  stdin: {
    contents: `
      export { formatHostErrorMessage } from "./src/lib/hostErrorDiagnostics";
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  logLevel: "silent",
});

const { formatHostErrorMessage: formatReconciliationError } =
  await import(bundlePath);

after(() => unlink(bundlePath).catch(() => undefined));

const formatters = [
  ["build", formatBuildError],
  ["export reconciliation", formatReconciliationError],
];

const commands = [
  ["build", ["./build.mjs"], "API build failed"],
  [
    "export reconciliation",
    ["./dist/export-reconciliation.mjs"],
    "Export reconciliation failed",
  ],
];

for (const [command, args, fallback] of commands) {
  for (const hostileCase of ["message-getter", "message-conversion"]) {
    test(`${command} command preserves its root diagnostic for ${hostileCase}`, () => {
      const result = spawnSync(process.execPath, args, {
        cwd: artifactDir,
        encoding: "utf8",
        env: {
          ...process.env,
          API_HOST_ERROR_DIAGNOSTICS_TEST_CASE: hostileCase,
        },
      });

      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, `${fallback}\n`);
      assert.ok(result.stderr.length <= 241);
      assert.doesNotMatch(result.stderr, /hostile .* escaped/u);
    });
  }

  test(`${command} command ignores inspection hooks and bounds stderr`, () => {
    const result = spawnSync(process.execPath, args, {
      cwd: artifactDir,
      encoding: "utf8",
      env: {
        ...process.env,
        API_HOST_ERROR_DIAGNOSTICS_TEST_CASE: "inspection-hook",
      },
    });

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr.length, 241);
    assert.match(result.stderr, /^root diagnostic /u);
    assert.match(result.stderr, /\.\.\.\n$/u);
    assert.doesNotMatch(result.stderr, /hostile inspection escaped/u);
  });
}

for (const [entrypoint, format] of formatters) {
  test(`${entrypoint} diagnostics survive a throwing message getter`, () => {
    const hostile = Object.create(null, {
      message: {
        get() {
          throw new Error("hostile message getter escaped");
        },
      },
    });

    assert.equal(format(hostile, "bounded fallback"), "bounded fallback");
  });

  test(`${entrypoint} diagnostics survive hostile message conversion`, () => {
    const hostileMessage = {
      toString() {
        throw new Error("hostile string conversion escaped");
      },
    };

    assert.equal(
      format({ message: hostileMessage }, "bounded fallback"),
      "bounded fallback",
    );
  });

  test(`${entrypoint} diagnostics never inspect the host error object`, () => {
    const hostile = {
      message: "root diagnostic",
      [Symbol.for("nodejs.util.inspect.custom")]() {
        throw new Error("hostile inspection escaped");
      },
    };

    assert.equal(format(hostile, "bounded fallback"), "root diagnostic");
  });

  test(`${entrypoint} diagnostics survive hostile primitive conversion`, () => {
    const hostile = Object.create(null, {
      message: {
        value: {
          [Symbol.toPrimitive]() {
            throw new Error("hostile primitive conversion escaped");
          },
        },
      },
    });

    assert.equal(format(hostile, "bounded fallback"), "bounded fallback");
  });

  test(`${entrypoint} diagnostics are sanitized and bounded`, () => {
    const diagnostic = format(
      { message: `root\u0000diagnostic ${"x".repeat(400)}` },
      "bounded fallback",
    );

    assert.equal(diagnostic.length, 240);
    assert.doesNotMatch(diagnostic, /[\u0000-\u001f\u007f-\u009f]/u);
    assert.match(diagnostic, /\.\.\.$/u);
  });
}