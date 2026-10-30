import app from "./app.js";
import { geminiService } from "./services/geminiService.js";
import { connectMongo } from "./db.js";

const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectMongo();

const server = app.listen(PORT, () => {
  console.log(`[SchemAI Backend] Server listening on port ${PORT}`);
  console.log(`[SchemAI Backend] Health check: http://localhost:${PORT}/api/health`);
  console.log(`[SchemAI Backend] Schema endpoint: http://localhost:${PORT}/api/schema`);
  // Reuse the service's own key validation (throws MISSING_API_KEY). Only a boolean is logged, never the key.
  let keyConfigured = true;
  try {
    geminiService.getApiKey();
  } catch {
    keyConfigured = false;
  }
  console.log(
    keyConfigured
      ? "[SchemAI Backend] Gemini: API key configured (model is chosen per request from GET /api/models)"
      : "[SchemAI Backend] Gemini: GEMINI_API_KEY is NOT set - model discovery and POST /api/schema/generate will return 503 until it is configured (see backend/.env.example)"
  );
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`[SchemAI Backend] Received ${signal}. Shutting down server gracefully...`);
  server.close(() => {
    console.log("[SchemAI Backend] Server closed.");
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));