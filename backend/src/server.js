import app from "./app.js";
import { geminiService } from "./services/geminiService.js";

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`[SchemAI Backend] Server listening on port ${PORT}`);
  console.log(`[SchemAI Backend] Health check: http://localhost:${PORT}/api/health`);
  console.log(`[SchemAI Backend] Schema endpoint: http://localhost:${PORT}/api/schema`);
  const keyConfigured = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here";
  console.log(
    keyConfigured
      ? `[SchemAI Backend] Gemini: API key configured, model=${geminiService.getModel()}`
      : "[SchemAI Backend] Gemini: GEMINI_API_KEY is NOT set - POST /api/schema/generate will return 503 until it is configured (see backend/.env.example)"
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
