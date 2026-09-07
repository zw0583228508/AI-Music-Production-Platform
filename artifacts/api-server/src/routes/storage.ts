import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  RequestSourceUploadUrlBody,
  RequestSourceUploadUrlResponse,
} from "@workspace/api-zod";
import {
  db,
  musicArtifactsTable,
  musicProjectsTable,
  projectUploadReservationsTable,
} from "@workspace/db";
import {
  createSourceUploadTarget,
  getPrivateObject,
  isSourceObjectPath,
  saveSourceUploadStream,
} from "../lib/objectStorage";
import { signalProjectStorageRaceEvent } from "../lib/projectStorageRaceTestHook";

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
  const target = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${parsed.data.projectId}))`,
    );
    const [project] = await tx
      .select({ id: musicProjectsTable.id })
      .from(musicProjectsTable)
      .where(and(
        eq(musicProjectsTable.id, parsed.data.projectId),
        eq(musicProjectsTable.ownerId, req.user!.id),
      ))
      .limit(1);
    if (!project) return null;
    const created = await createSourceUploadTarget();
    await tx.insert(projectUploadReservationsTable).values({
      objectPath: created.objectPath,
      projectId: project.id,
      ownerId: req.user!.id,
      contentType: parsed.data.contentType,
      size: parsed.data.size,
      expiresAt: created.expiresAt,
    });
    return created;
  });
  if (!target) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const { uploadURL, objectPath } = target;
  res.json(RequestSourceUploadUrlResponse.parse({
    uploadURL,
    objectPath,
    metadata: parsed.data,
  }));
});

router.put("/storage/uploads/:uploadId", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const objectPath = `/objects/uploads/${req.params.uploadId}`;
  if (!isSourceObjectPath(objectPath)) {
    res.status(400).json({ error: "Invalid upload target" });
    return;
  }
  const [reservation] = await db
    .select()
    .from(projectUploadReservationsTable)
    .where(and(
      eq(projectUploadReservationsTable.objectPath, objectPath),
      eq(projectUploadReservationsTable.ownerId, req.user.id),
    ))
    .limit(1);
  if (!reservation || reservation.expiresAt <= new Date()) {
    res.status(404).json({ error: "Upload target not found or expired" });
    return;
  }
  await signalProjectStorageRaceEvent("source-upload-requested", objectPath);
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (contentLength !== reservation.size) {
    res.status(400).json({ error: "Upload size does not match the reservation" });
    return;
  }
  const stored = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${reservation.projectId}))`,
    );
    const [activeReservation] = await tx
      .select({ projectId: projectUploadReservationsTable.projectId })
      .from(projectUploadReservationsTable)
      .innerJoin(
        musicProjectsTable,
        eq(musicProjectsTable.id, projectUploadReservationsTable.projectId),
      )
      .where(and(
        eq(projectUploadReservationsTable.objectPath, objectPath),
        eq(projectUploadReservationsTable.ownerId, req.user!.id),
        eq(musicProjectsTable.ownerId, req.user!.id),
      ))
      .limit(1);
    if (!activeReservation) return false;
    await saveSourceUploadStream(
      objectPath,
      req,
      reservation.contentType,
    );
    return true;
  });
  if (!stored) {
    res.status(404).json({ error: "Project was deleted before upload" });
    return;
  }
  res.status(204).end();
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
    .select({
      id: musicArtifactsTable.id,
      type: musicArtifactsTable.type,
    })
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
  const inlineAudio =
    registeredArtifact.type === "AUDIO_TRACK" &&
    (metadata.contentType === "audio/wav" || metadata.contentType === "audio/mpeg");
  res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(metadata.size || 0));
  res.setHeader(
    "Content-Disposition",
    `${inlineAudio ? "inline" : "attachment"}; filename="${file.name.split("/").pop() || "download"}"`,
  );
  res.setHeader("Cache-Control", "private, max-age=3600");
  file.createReadStream().on("error", (error) => {
    req.log.error({ err: error }, "Failed to stream export object");
    if (!res.headersSent) res.status(500).end();
    else res.destroy(error);
  }).pipe(res);
});

export default router;
