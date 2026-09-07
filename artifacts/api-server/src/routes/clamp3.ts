import { Router, type IRouter, type Request, type Response } from "express";
import {
  fetchAttestedClamp3Health,
  forwardAttestedClamp3Similarity,
} from "../lib/clamp3Attestation";

const router: IRouter = Router();

function configured() {
  const endpoint = process.env.CLAMP3_API_URL;
  const token = process.env.MUSIC_AI_WORKER_TOKEN;
  if (!endpoint || !token) return null;
  return { endpoint, token };
}

router.get("/providers/clamp3/health", async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const runtime = configured();
  if (!runtime) {
    res.status(503).json({ error: "CLAMP3 is not configured" });
    return;
  }
  try {
    const health = await fetchAttestedClamp3Health(runtime);
    if (!health.valid) {
      res.status(503).json({ error: "CLAMP3 runtime identity or readiness attestation is invalid" });
      return;
    }
    res.status(health.status).json(health.payload);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? `CLAMP3 health request failed: ${error.message}` : "CLAMP3 health request failed",
    });
  }
});

router.post("/providers/clamp3/similarity", async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const runtime = configured();
  if (!runtime) {
    res.status(503).json({ error: "CLAMP3 is not configured" });
    return;
  }
  try {
    const result = await forwardAttestedClamp3Similarity(runtime, req.body);
    res.status(result.status).json(result.payload);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? `CLAMP3 request failed: ${error.message}` : "CLAMP3 request failed",
    });
  }
});

export default router;