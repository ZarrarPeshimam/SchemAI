// db.js – MongoDB connection using Mongoose
import mongoose from "mongoose";

/**
 * Connect to MongoDB using the URI defined in the environment variable MONGODB_URI.
 * If the variable is missing, the connection attempt is skipped and the server
 * will still start, but any persistence endpoint will return a 503 with a clear
 * error message. This respects the security rule of never reading .env files –
 * we only reference process.env.
 */
export async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri || uri.trim() === "" || uri.includes("your_mongo_uri")) {
    console.warn(
      "[SchemAI] MONGODB_URI not configured – persistence endpoints will be unavailable."
    );
    return; // No connection; callers should handle missing connection.
  }
  try {
    await mongoose.connect(uri, {});
    console.log("[SchemAI] Connected to MongoDB");
  } catch (err) {
    console.error("[SchemAI] MongoDB connection error:", err);
  }
}

export const db = mongoose;
export function isConnected() {
  return mongoose.connection.readyState === 1;
}
