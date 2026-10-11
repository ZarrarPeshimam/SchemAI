/**
 * Global error handling middleware.
 * Ensures consistent response format across all errors.
 */
export const errorHandler = (err, req, res, next) => {
  const isProduction = process.env.NODE_ENV === "production";
  
  // Handle JSON parse errors from express.json()
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      error: {
        code: "INVALID_JSON",
        message: "Malformed JSON payload in request body",
      },
    });
  }

  // Handle custom status codes or fallback to 500
  const statusCode = err.statusCode || (err.status && typeof err.status === "number" ? err.status : 500);
  const errorCode = err.code || (statusCode === 501 ? "FEATURE_NOT_IMPLEMENTED" : statusCode === 400 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR");

  const response = {
    success: false,
    error: {
      code: errorCode,
      message: err.message || "An unexpected server error occurred",
    },
  };

  if (err.validation) {
    response.error.validation = err.validation;
  }

  if (err.details) {
    response.error.details = err.details;
  }

  // Only include stack trace in non-production environments
  if (!isProduction && statusCode === 500) {
    response.error.stack = err.stack;
  }

  return res.status(statusCode).json(response);
};

/**
 * 404 Not Found middleware for unmatched routes
 */
export const notFoundHandler = (req, res) => {
  return res.status(404).json({
    success: false,
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `Cannot ${req.method} ${req.originalUrl}`,
    },
  });
};
