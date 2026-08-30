import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studioRouter from "./studio";

const router: IRouter = Router();

router.use(healthRouter);
router.use(studioRouter);

export default router;
