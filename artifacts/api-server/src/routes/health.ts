import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { sql } from "drizzle-orm";
import {
  analysisJobsTable,
  db,
  musicGenerationJobsTable,
} from "@workspace/db";
import { listProviderCatalog } from "../lib/arrangementGeneration";
import { productionQueueMetrics } from "../lib/productionJobs";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    const [pipelineQueues, analysisQueues, generationQueues, providers] = await Promise.all([
      productionQueueMetrics(),
      db.select({
        status: analysisJobsTable.status,
        count: sql<number>`count(*)::int`,
      }).from(analysisJobsTable).groupBy(analysisJobsTable.status),
      db.select({
        status: musicGenerationJobsTable.status,
        count: sql<number>`count(*)::int`,
      }).from(musicGenerationJobsTable).groupBy(musicGenerationJobsTable.status),
      listProviderCatalog(),
    ]);
    const data = HealthCheckResponse.parse({
      status: "ok",
      database: "ok",
      providers: {
        configured: providers.filter((provider) => provider.configured).length,
        available: providers.filter((provider) => provider.available).length,
      },
      queues: {
        ...Object.fromEntries(
          analysisQueues.map((row) => [`analysis_${row.status}`, row.count]),
        ),
        ...Object.fromEntries(
          generationQueues.map((row) => [`generation_${row.status}`, row.count]),
        ),
        ...Object.fromEntries(
          Object.entries(pipelineQueues).map(([status, count]) => [
            `pipeline_${status}`,
            count,
          ]),
        ),
      },
      timestamp: new Date().toISOString(),
    });
    res.json(data);
  } catch {
    res.status(503).json(HealthCheckResponse.parse({
      status: "degraded",
      database: "unavailable",
      providers: { configured: 0, available: 0 },
      queues: {},
      timestamp: new Date().toISOString(),
    }));
  }
});

export default router;
