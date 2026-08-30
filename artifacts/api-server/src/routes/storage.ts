import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, musicArtifactsTable } from "@workspace/db";
import { getPrivateObject } from "../lib/objectStorage";

const router: IRouter = Router();

router.get("/storage/objects/*path", async (req, res): Promise<void> => {
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
    .where(eq(musicArtifactsTable.url, downloadUrl))
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
