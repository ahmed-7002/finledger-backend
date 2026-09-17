import rateLimit from "express-rate-limit";

/**
 * Rate limiting strategy
 * ----------------------------------------------------------------------
 * server.js applies one GENEROUS global limiter to every request (300 /
 * 15 min per IP) as a baseline DDoS/abuse backstop. On top of that, this
 * file defines TIGHTER limiters for specific route categories, applied
 * directly in each route file - because a GET that just reads cached data
 * is far cheaper (and far less abusable) than a POST that writes to the
 * database, uploads a file, or triggers a Cloudinary/Safepay call.
 * ----------------------------------------------------------------------
 */

// Applied to every write action (POST/PATCH/DELETE) on customers,
// transactions, and tenant onboarding. Generous enough for a real shop
// owner's normal usage (recording several transactions a minute during a
// busy period) while still blunting scripted abuse from a single IP.
export const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many requests. Please slow down and try again shortly." },
});

// Slightly tighter still, applied to receipt-image uploads specifically - 
// these are the most expensive requests in the app (multipart parsing +
// an outbound Cloudinary call), so they're the first thing worth
// throttling harder if something is abusing the API.
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many uploads. Please slow down and try again shortly." },
});
