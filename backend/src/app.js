import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import schemaRoutes from "./routes/schemaRoutes.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

// Load environment variables
dotenv.config();

const app = express();

// Configure CORS
const allowedOrigins = [
  process.env.CLIENT_ORIGIN || "http://localhost:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (such as mobile apps or curl) or if origin is in whitelist
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin '${origin}' is not allowed by CORS`));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Parse JSON request bodies
app.use(express.json({ limit: "1mb" }));

// Mount schema API routes
app.use("/api", schemaRoutes);

// Fallback 404 for unknown routes
app.use(notFoundHandler);

// Centralized error handling
app.use(errorHandler);

export default app;
