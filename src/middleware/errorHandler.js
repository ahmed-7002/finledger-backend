export function notFound(req, res) {
  res.status(404).json({ error: "Route not found" });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error("[error]", err);

  if (err?.name === "ZodError") {
    return res.status(400).json({
      error: "validation_error",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  // Postgres foreign key / unique violations
  if (err?.code === "23505") {
    return res.status(409).json({ error: "duplicate_record" });
  }
  if (err?.code === "23503") {
    return res.status(400).json({ error: "invalid_reference" });
  }

  res.status(err.status || 500).json({
    error: err.publicMessage || "internal_server_error",
  });
}
