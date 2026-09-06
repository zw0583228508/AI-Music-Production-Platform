import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import storageRouter from "./storage";
import studioRouter from "./studio";
import clamp3Router from "./clamp3";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(storageRouter);
router.use(studioRouter);
router.use(clamp3Router);

export default router;
