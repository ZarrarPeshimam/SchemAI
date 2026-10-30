import { Router } from "express";
import {
  getHealth,
  getSchema,
  validateSchema,
  generateSql,
  refineSchema,
  generateSchema,
} from "../controllers/schemaController.js";
import { listModels } from "../controllers/modelController.js";
import {
  listConversations,
  getConversation,
  addMessage,
} from "../controllers/conversationController.js";

const router = Router();

// Health check
router.get("/health", getHealth);

// Gemini model discovery (server-side, cached)
router.get("/models", listModels);

// Schema endpoints
router.get("/schema", getSchema);
router.post("/schema/validate", validateSchema);
router.post("/schema/sql", generateSql);
router.post("/schema/refine", refineSchema);
router.post("/schema/generate", generateSchema);

// Conversation endpoints
router.get("/conversations", listConversations);
router.get("/conversations/:id", getConversation);
router.post("/conversations/:id/messages", addMessage);

export default router;
