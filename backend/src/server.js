import app from "./app.js";

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`[SchemAI Backend] Server listening on port ${PORT}`);
  console.log(`[SchemAI Backend] Health check: http://localhost:${PORT}/api/health`);
  console.log(`[SchemAI Backend] Schema endpoint: http://localhost:${PORT}/api/schema`);
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
