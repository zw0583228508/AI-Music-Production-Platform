import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDirectory = new URL("..", import.meta.url).pathname;
const harnessPath = `/tmp/music-export-auth-harness-${process.pid}.mjs`;
await build({
  stdin: {
    contents: `
      export { createSession, deleteSession } from "./src/lib/auth";
      export {
        arrangementsTable,
        db,
        musicArtifactsTable,
        musicProjectsTable,
      } from "@workspace/db";
      export { eq } from "drizzle-orm";
    `,
    resolveDir: apiDirectory,
    sourcefile: "authorization-harness.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: harnessPath,
  external: ["pg-native", "@google-cloud/*", "@google/*"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});
const {
  arrangementsTable,
  createSession,
  db,
  deleteSession,
  eq,
  musicArtifactsTable,
  musicProjectsTable,
} = await import(pathToFileURL(harnessPath).href);

let server;
let baseUrl;
let ownerSession;
let otherSession;
let projectId;
let arrangementId;
let exportId;

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) return;
    } catch {
      // The child server has not opened its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Authorization test API did not become ready");
}

function request(path, session, init = {}) {
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: init.redirect ?? "manual" });
}

before(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: apiDirectory,
    env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverError = "";
  server.stderr.on("data", (chunk) => {
    serverError += chunk.toString();
  });
  server.once("exit", (code) => {
    if (code && code !== 0) serverError += `\nserver exited with ${code}`;
  });
  await waitUntilReady(baseUrl).catch((error) => {
    throw new Error(`${error.message}\n${serverError}`);
  });

  ownerSession = await createSession({
    user: {
      id: `export-owner-${process.pid}`,
      email: null,
      firstName: "Export",
      lastName: "Owner",
      profileImageUrl: null,
    },
    access_token: "test",
  });
  otherSession = await createSession({
    user: {
      id: `export-other-${process.pid}`,
      email: null,
      firstName: "Other",
      lastName: "User",
      profileImageUrl: null,
    },
    access_token: "test",
  });

  const createResponse = await request("/api/projects", ownerSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Authorization Test", sourceType: "FULL_SONG" }),
  });
  assert.equal(createResponse.status, 201);
  projectId = (await createResponse.json()).id;
  arrangementId = `auth-arrangement-${process.pid}`;
  exportId = `auth-export-${process.pid}`;
  await db.insert(arrangementsTable).values({
    id: arrangementId,
    projectId,
    name: "Private arrangement",
    style: "Test",
    mode: "STUDIO",
    sections: [],
  });
  await db.insert(musicArtifactsTable).values({
    id: exportId,
    projectId,
    type: "EXPORT",
    label: "private.zip",
    version: 1,
    size: "1 KB",
    format: "ZIP",
    state: "ready",
    url: "/api/storage/objects/exports/private-test.zip",
  });
});

after(async () => {
  if (projectId) {
    await db.delete(musicProjectsTable).where(eq(musicProjectsTable.id, projectId));
  }
  if (ownerSession) await deleteSession(ownerSession);
  if (otherSession) await deleteSession(otherSession);
  if (server && !server.killed) server.kill("SIGTERM");
  await unlink(harnessPath).catch(() => undefined);
});

test("project and export endpoints enforce owner authorization", async () => {
  const anonymousCreate = await request("/api/projects", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Anonymous", sourceType: "FULL_SONG" }),
  });
  assert.equal(anonymousCreate.status, 401);

  assert.equal((await request(`/api/projects/${projectId}`, ownerSession)).status, 200);
  assert.equal((await request(`/api/projects/${projectId}`, otherSession)).status, 404);

  const crossUserExport = await request(`/api/projects/${projectId}/export`, otherSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arrangementId }),
  });
  assert.equal(crossUserExport.status, 404);

  const crossUserLegacy = await request(
    `/api/arrangements/${arrangementId}/export`,
    otherSession,
    { method: "POST" },
  );
  assert.equal(crossUserLegacy.status, 404);

  const ownerLegacy = await request(
    `/api/arrangements/${arrangementId}/export`,
    ownerSession,
    { method: "POST" },
  );
  assert.equal(ownerLegacy.status, 307);
  assert.equal(
    ownerLegacy.headers.get("location"),
    `/api/projects/${projectId}/export?arrangementId=${arrangementId}`,
  );

  assert.equal(
    (await request(`/api/exports/${exportId}/download`, otherSession)).status,
    404,
  );
  assert.equal(
    (await request("/api/storage/objects/exports/private-test.zip", null)).status,
    401,
  );
  assert.equal(
    (await request("/api/storage/objects/exports/private-test.zip", otherSession)).status,
    404,
  );
});