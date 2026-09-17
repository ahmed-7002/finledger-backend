import { createClerkClient, verifyToken } from "@clerk/express";
import "dotenv/config";

// NOTE: migrated from the deprecated @clerk/clerk-sdk-node (end-of-life
// January 2025) to @clerk/express, Clerk's supported package for Express
// apps. Two things differ from the old SDK and matter here:
//   1. verifyToken is a STANDALONE export, not a method on clerkClient.
//   2. It therefore needs secretKey passed explicitly per call.
// clerkClient is still exported below for any future use of Clerk's
// management APIs (e.g. looking up a user's profile).
export const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

/**
 * requireAuth
 * ----------------------------------------------------------------------
 * Verifies the Clerk session JWT sent in the `Authorization: Bearer <token>`
 * header on every protected route. On success it attaches `req.ownerId`
 * (the Clerk user id) which is used everywhere downstream to scope every
 * database query - this is the backbone of tenant data isolation.
 * ----------------------------------------------------------------------
 */
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    // verifyToken checks signature, expiry, and issuer against Clerk's JWKS.
    // clockSkewInMs gives a small allowance for the server's system clock
    // being slightly behind/ahead of real time (a few seconds of drift is
    // common, especially on machines that don't sync time perfectly) - one
    // token issued right at that boundary would otherwise fail with a
    // "JWT cannot be used prior to not before date claim (nbf)" error even
    // though the token is perfectly valid. This does NOT relax expiry
    // security in any meaningful way; it's a small tolerance for clock
    // drift, not a way to accept old/expired tokens.
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
      clockSkewInMs: 10_000,
    });

    if (!payload || !payload.sub) {
      return res.status(401).json({ error: "Invalid session token" });
    }

    req.ownerId = payload.sub; // Clerk user id - the multi-tenant partition key
    req.auth = payload;
    next();
  } catch (err) {
    console.error("[auth] token verification failed:", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }
}
