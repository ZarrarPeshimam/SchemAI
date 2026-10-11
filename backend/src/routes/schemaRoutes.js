import { Router } from "express";
import {
  getHealth,
  getSchema,
  validateSchema,
  generateSql,
  refineSchema,
  generateSchema,
} from "../controllers/schemaController.js";

const router = Router();

// Health check
router.get("/health", getHealth);

// Schema endpoints
router.get("/schema", getSchema);
router.post("/schema/validate", validateSchema);
router.post("/schema/sql", generateSql);
router.post("/schema/refine", refineSchema);
router.post("/schema/generate", generateSchema);

export default router;
