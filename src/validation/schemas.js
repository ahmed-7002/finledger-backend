import { z } from "zod";

// Strict allow-list style validation - reject anything that doesn't match,
// never attempt to "clean" dangerous input and pass it through.

/**
 * stripControlChars
 * ----------------------------------------------------------------------
 * Defense-in-depth for free-text fields that don't have a tight regex
 * (unlike name/phone/accountNumber, which already only allow a strict
 * character set). React already escapes everything it renders, so this
 * isn't preventing XSS by itself - it's about not persisting null bytes,
 * escape sequences, or other control characters into fields that might
 * later be exported (CSV, PDF receipts, the public Share Record page,
 * etc.), where a downstream renderer might not be as safe as React.
 * ----------------------------------------------------------------------
 */
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

export const customerCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100)
    .regex(/^[a-zA-Z\s.'-]+$/, "Name may only contain letters and spaces"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{7,14}$/, "Enter a valid international phone number (E.164)"),
  // Free, no-API "verification": the owner sends a wa.me click-to-chat link
  // and the customer replies from their own WhatsApp, proving the number is
  // real and reachable. There's no webhook confirming the reply landed, so
  // this is a self-reported flag the owner ticks manually after seeing it - 
  // never trust it as a strong identity guarantee, just a light sanity check.
  phoneVerified: z.boolean().optional().default(false),
  nationalId: z.string().trim().max(30).transform(stripControlChars).optional().nullable(),
  clientUuid: z.string().uuid().optional(), // for offline optimistic sync reconciliation
});

export const customerUpdateSchema = z.object({
  name: customerCreateSchema.shape.name.optional(),
  phone: customerCreateSchema.shape.phone.optional(),
  // No .default() here on purpose - an omitted field must mean "leave the
  // currently stored value alone" (see customers.js PATCH handler's
  // COALESCE). Defaulting it would silently reset phone_verified to false
  // on every unrelated profile edit.
  phoneVerified: z.boolean().optional(),
  nationalId: z.string().trim().max(30).transform(stripControlChars).optional().nullable(),
});

export const transactionCreateSchema = z.object({
  customerId: z.string().uuid(),
  type: z.enum(["add", "deduct"]),
  amount: z.coerce.number().positive().max(100000000),
  paymentMethod: z.literal("cash").default("cash"),
  receiptUrl: z.string().url().optional().nullable(),
  reference: z.string().trim().max(200).transform(stripControlChars).optional().nullable(),
  clientUuid: z.string().uuid().optional(),
});

export const tenantOnboardingSchema = z.object({
  countryCode: z.string().length(2, "ISO 3166-1 alpha-2 code required"),
  currencyCode: z.string().length(3, "ISO 4217 code required"),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  bankName: z.string().trim().min(2).max(100).transform(stripControlChars),
  accountNumber: z
    .string()
    .trim()
    .min(4)
    .max(34)
    .regex(/^[A-Za-z0-9\-\s]+$/, "Account number contains invalid characters"),
  shopName: z.string().trim().max(100).transform(stripControlChars).optional(),
});

/**
 * tenantSettingsUpdateSchema
 * ----------------------------------------------------------------------
 * Used by the ongoing Settings screen (PATCH /api/tenant/settings) - 
 * distinct from tenantOnboardingSchema, which only runs once at first
 * login and additionally requires countryCode/currencyCode/coordinates.
 * Every field here is optional with NO .default() - an omitted field
 * means "leave it as it currently is" (see the PATCH handler's COALESCE),
 * the same pattern used by customerUpdateSchema.
 * ----------------------------------------------------------------------
 */
export const tenantSettingsUpdateSchema = z.object({
  shopName: z.string().trim().min(1).max(100).transform(stripControlChars).optional(),
  bankName: z.string().trim().min(2).max(100).transform(stripControlChars).optional(),
  accountHolderName: z.string().trim().min(2).max(100).transform(stripControlChars).optional(),
  accountNumber: z
    .string()
    .trim()
    .min(4)
    .max(34)
    .regex(/^[A-Za-z0-9\-\s]+$/, "Account number contains invalid characters")
    .optional(),
});

export const idParamSchema = z.object({
  id: z.string().uuid("Invalid identifier"),
});

// ---------------------------------------------------------------------------
// Point of Sale: items catalog + sales/checkout
// ---------------------------------------------------------------------------

export const itemCreateSchema = z.object({
  name: z.string().trim().min(1, "Item name is required").max(100).transform(stripControlChars),
  price: z.coerce.number().min(0).max(100000000),
  clientUuid: z.string().uuid().optional(),
});

export const itemUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).transform(stripControlChars).optional(),
  price: z.coerce.number().min(0).max(100000000).optional(),
  isActive: z.boolean().optional(),
});

// A single line in the cart. itemId is optional - present when the line came
// from the saved catalog, absent for a one-off ad-hoc item typed during
// checkout. name/unitPrice are always required regardless, since sale_items
// snapshots them either way (see schema.sql comment on sale_items).
export const saleLineItemSchema = z.object({
  itemId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(100).transform(stripControlChars),
  unitPrice: z.coerce.number().min(0).max(100000000),
  quantity: z.coerce.number().positive().max(100000),
});

// Reuses the same field-level rules as customerCreateSchema, for the
// "create a new customer inline, as part of checkout" path - kept as its
// own schema (rather than importing customerCreateSchema directly) since a
// sale's inline customer never carries its own clientUuid or phoneVerified
// flag; those aren't meaningful in this context.
export const newCustomerForSaleSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100)
    .regex(/^[a-zA-Z\s.'-]+$/, "Name may only contain letters and spaces"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{7,14}$/, "Enter a valid international phone number (E.164)"),
  nationalId: z.string().trim().max(30).transform(stripControlChars).optional().nullable(),
});

export const saleCreateSchema = z
  .object({
    // Exactly one of these may be set, and only when there's a pending
    // balance to attach - see routes/sales.js for the full enforcement.
    customerId: z.string().uuid().optional().nullable(),
    newCustomer: newCustomerForSaleSchema.optional().nullable(),
    items: z.array(saleLineItemSchema).min(1, "A sale needs at least one item"),
    // How much cash was actually handed over right now. Deliberately NOT
    // validated against the total here - the total is computed server-side
    // from `items` (never trusted from the client), so the cross-check
    // "amountPaid <= total" happens in the route after that computation.
    amountPaid: z.coerce.number().min(0).max(100000000),
    clientUuid: z.string().uuid().optional(),
  })
  .refine((data) => !(data.customerId && data.newCustomer), {
    message: "Provide either an existing customerId or a newCustomer, not both",
    path: ["customerId"],
  });
