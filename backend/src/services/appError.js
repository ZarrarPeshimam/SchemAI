/**
 * Dependency-free error helpers shared by the Gemini services, the model catalog and the retry helper.
 * (Kept separate from geminiService.js so they can be imported without pulling in the Gemini SDK.)
 */

/** Error carrying an HTTP status and a client-safe message. `expose` marks the message as safe to return. */
export function createAppError(code, message, statusCode, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.expose = true;
  Object.assign(error, extra);
  return error;
}

/** Removes anything that looks like the configured API key / a Google API key from text destined for logs. */
export function redact(text) {
  let out = String(text ?? "");
  const key = process.env.GEMINI_API_KEY;
  if (key && key.length > 6) out = out.split(key).join("[redacted]");
  return out
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]")
    .slice(0, 300);
}
