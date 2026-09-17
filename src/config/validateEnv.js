/**
 * validateEnv
 * ----------------------------------------------------------------------
 * Fails loudly and immediately at boot if a required secret is missing,
 * instead of the app starting "successfully" and then producing confusing
 * runtime errors (or worse, silently running with a broken security check)
 * the first time a request needs that variable. This is called once at the
 * very top of server.js, before the Express app is even built.
 * ----------------------------------------------------------------------
 */
const REQUIRED_IN_ALL_ENVS = ["DATABASE_URL", "CLERK_SECRET_KEY"];

// These are only required once you actually wire up the corresponding
// feature - missing them doesn't break the core app, so we warn rather
// than hard-exit, but still call it out clearly at startup.
const REQUIRED_FOR_FULL_FEATURE_SET = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "PAYMENT_WEBHOOK_SECRET",
];

export function validateEnv() {
  const missing = REQUIRED_IN_ALL_ENVS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `\n[startup] Missing required environment variable(s): ${missing.join(", ")}\n` +
        `Copy backend/.env.example to backend/.env and fill these in before starting the server.\n`
    );
    process.exit(1);
  }

  const missingOptional = REQUIRED_FOR_FULL_FEATURE_SET.filter((key) => !process.env[key]);
  if (missingOptional.length > 0) {
    console.warn(
      `[startup] Warning: missing ${missingOptional.join(", ")} - related features ` +
        `(receipt uploads, payment webhooks) will fail until these are set.`
    );
  }
}
