import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  RequestSourceUploadUrlBody,
  RequestSourceUploadUrlResponse,
} from "@workspace/api-zod";
import { db, musicArtifactsTable, musicProjectsTable } from "@workspace/db";
import { createSourceUploadTarget, getPrivateObject } from "../lib/objectStorage";

const router: IRouter = Router();

router.post("/storage/uploads/request-url", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = RequestSourceUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid upload metadata" });
    return;
  }
  const { uploadURL, objectPath } = await createSourceUploadTarget();
  res.json(RequestSourceUploadUrlResponse.parse({
    uploadURL,
    objectPath,
    metadata: parsed.data,
  }));
});

router.get("/storage/objects/*path", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const rawPath = req.params.path;
  const path = Array.isArray(rawPath) ? rawPath.join("/") : rawPath;
  if (!path.startsWith("exports/")) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const downloadUrl = `/api/storage/objects/${path}`;
  const [registeredArtifact] = await db
    .select({ id: musicArtifactsTable.id })
    .from(musicArtifactsTable)
    .innerJoin(
      musicProjectsTable,
      eq(musicProjectsTable.id, musicArtifactsTable.projectId),
    )
    .where(and(
      eq(musicArtifactsTable.url, downloadUrl),
      eq(musicProjectsTable.ownerId, req.user.id),
    ))
    .limit(1);
  if (!registeredArtifact) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const file = await getPrivateObject(path);
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const [metadata] = await file.getMetadata();
  res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(metadata.size || 0));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${file.name.split("/").pop() || "download"}"`,
  );
  res.setHeader("Cache-Control", "private, max-age=3600");
  file.createReadStream().on("error", (error) => {
    req.log.error({ err: error }, "Failed to stream export object");
    if (!res.headersSent) res.status(500).end();
    else res.destroy(error);
  }).pipe(res);
});

export default router;
