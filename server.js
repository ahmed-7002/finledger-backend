import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import hpp from "hpp";

import { validateEnv } from "./src/config/validateEnv.js";
import { requireAuth } from "./src/middleware/auth.js";
import { errorHandler, notFound } from "./src/middleware/errorHandler.js";
import webhookRoutes from "./src/routes/webhooks.js";
import tenantRoutes from "./src/routes/tenant.js";
import customerRoutes from "./src/routes/customers.js";
import transactionRoutes from "./src/routes/transactions.js";
import publicRoutes from "./src/routes/public.js";
import itemRoutes from "./src/routes/items.js";
import saleRoutes from "./src/routes/sales.js";
import paymentSubmissionRoutes from "./src/routes/paymentSubmissions.js";

// Fail fast if a required secret is missing - before the app even starts,
// not on the first request that happens to need it.
validateEnv();

const app = express();
const PORT = process.env.PORT || 4000;

app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
app.use(helmet());

// ---------------------------------------------------------------------------
// HTTP Parameter Pollution protection - strips duplicate query-string keys
// down to the last occurrence (e.g. ?id=1&id=2 -> id=2) so a handler can't
// be tricked by an array sneaking in where a single value was expected.
// ---------------------------------------------------------------------------
app.use(hpp());

// ---------------------------------------------------------------------------
// Strict CORS - only the configured frontend origin may call this API.
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ---------------------------------------------------------------------------
// Rate limiting - generous for normal use, tight enough to blunt brute force
// / DDoS attempts. Applied globally; webhook + auth-heavy routes could get
// tighter, dedicated limiters in a larger deployment.
// ---------------------------------------------------------------------------
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ---------------------------------------------------------------------------
// Webhook route MUST receive the raw body (for HMAC signature verification)
// and MUST be mounted before express.json() so the body is never parsed
// into an object first.
// ---------------------------------------------------------------------------
app.use(
  "/api/webhooks",
  express.raw({ type: "application/json" }),
  webhookRoutes
);

// All other routes use standard JSON body parsing.
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Public share-link route - deliberately has NO requireAuth, since a
// customer opening their WhatsApp-shared ledger link has no Clerk account.
// It gets its own tighter rate limiter (on top of the global one above)
// specifically because it's the one endpoint reachable with no credentials
// at all, so it's the most exposed to token-guessing / scraping attempts - 
// tokens are already unguessable 48-char random hex (see routes/public.js),
// this is just defense in depth on top of that.
// ---------------------------------------------------------------------------
const publicShareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/public", publicShareLimiter, publicRoutes);

// ---------------------------------------------------------------------------
// Protected API surface - every route below requires a verified Clerk JWT,
// and every handler scopes its queries to req.ownerId.
// ---------------------------------------------------------------------------
app.use("/api/tenant", requireAuth, tenantRoutes);
app.use("/api/customers", requireAuth, customerRoutes);
app.use("/api/transactions", requireAuth, transactionRoutes);
app.use("/api/items", requireAuth, itemRoutes);
app.use("/api/sales", requireAuth, saleRoutes);
app.use("/api/payment-submissions", requireAuth, paymentSubmissionRoutes);

app.use(notFound);
app.use(errorHandler);

// Vercel's Fluid compute wraps this exported app as a single serverless
// function - it does NOT need app.listen() to actually work there (Vercel
// intercepts requests before they'd ever reach a real socket), but keeping
// the guard below means the exact same file still runs correctly as a
// normal, always-on server locally or on any other host (Render, Railway,
// a VPS) with zero changes. Skipping app.listen() specifically in
// production avoids attempting to bind a port in an environment that
// doesn't expect one.
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`[server] Khaatabook API listening on port ${PORT}`);
  });
}

// Required for Vercel's zero-configuration Express detection - it looks
// for a default export of the app (or a plain app.listen() call - either
// pattern works) in server.js/app.js/index.js at the project root.
export default app;