/**
 * Shared GROW (Meshulam) Light API helpers.
 *
 * Ported from a live, tested integration (Orbar: src/services/payments/growProvider.ts
 * plus api/payments/*.js) whose wire details were confirmed against GROW's API
 * support and against real transactions. The previous version of this connector
 * was written against an endpoint and payload shape that GROW does not serve.
 *
 * Everything here is server-side only: it reads merchant secrets, and GROW's
 * own docs state that "all requests must be sent exclusively from your
 * server's back end".
 *
 * Docs:
 *   https://developers.grow.business/docs/light-api
 *   https://developers.grow.business/reference/create-payment-link
 *   https://developers.grow.business/reference/approve-transaction
 *   https://developers.grow.business/docs/overview-7          (webhooks)
 *   https://developers.grow.business/reference/ip-address     (webhook senders)
 */

// ─── Configuration ───────────────────────────────────────────────────────────

export interface GrowConfig {
  /** Page code identifying the payment page. */
  pageCode: string;
  /** Merchant/business identifier. */
  userId: string;
  /**
   * Sent as the `x-api-key` header. GROW's server update (2026-08) made this
   * mandatory on CreatePaymentLink; requests without it are rejected.
   */
  apiKey: string;
  /** Anything other than an explicit "production" stays on sandbox. */
  environment: "sandbox" | "production";
  /**
   * The terminal code this merchant expects to charge through.
   *
   * This exists because of a specific, expensive failure on another project on
   * this same gateway: the account was left pointing at a *test* terminal
   * after go-live. Every charge reported success, customers believed they had
   * paid, and no money ever moved. Nothing errored. Production therefore
   * refuses to charge through any terminal a human has not written down.
   */
  expectedTerminal: string | null;
  /** 1 = regular VAT, 3 = VAT-exempt. Required by CreatePaymentLink. */
  vatType: string;
}

/**
 * Read config from the environment. Returns null when a required credential is
 * missing — callers must treat null as "payments are off". There is no safe
 * default for taking money.
 */
export function readGrowConfig(): GrowConfig | null {
  const pageCode = Deno.env.get("GROW_PAGE_CODE");
  const userId = Deno.env.get("GROW_USER_ID");
  const apiKey = Deno.env.get("GROW_API_KEY");

  if (!pageCode || !userId || !apiKey) return null;

  return {
    pageCode,
    userId,
    apiKey,
    environment:
      Deno.env.get("GROW_ENVIRONMENT") === "production" ? "production" : "sandbox",
    expectedTerminal: Deno.env.get("GROW_EXPECTED_TERMINAL") || null,
    vatType: Deno.env.get("GROW_VAT_TYPE") || "1",
  };
}

// ─── Hosts ───────────────────────────────────────────────────────────────────

/**
 * CreatePaymentLink lives on its own host per environment — NOT on
 * api.meshulam.co.il, and not at `/api/light/createPaymentPage`, which is the
 * path the first version of this connector used and which GROW does not serve
 * with this schema.
 */
export function createPaymentLinkUrl(config: GrowConfig): string {
  const override = Deno.env.get("GROW_BASE_URL");
  if (override) {
    return `${override.replace(/\/$/, "")}/CreatePaymentLink`;
  }
  const host =
    config.environment === "production"
      ? "https://api.grow.link"
      : "https://sandboxapi.grow.link";
  return `${host}/api/light/server/1.0/CreatePaymentLink`;
}

/** Host for the remaining Light API calls (approveTransaction, status). */
export function lightApiBaseUrl(config: GrowConfig): string {
  const override = Deno.env.get("GROW_BASE_URL");
  if (override) return override.replace(/\/$/, "");
  return config.environment === "production"
    ? "https://secure.meshulam.co.il/api/light/server/1.0"
    : "https://sandbox.meshulam.co.il/api/light/server/1.0";
}

// ─── Money ───────────────────────────────────────────────────────────────────

/**
 * Amounts are handled as integer agorot everywhere and converted to shekels
 * only on the wire.
 *
 * The previous version sent `Math.round(amount)`, which silently dropped the
 * agorot from every price: ₪149.90 was charged as ₪150.
 */
export function isValidAgorot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function shekelsToAgorot(shekels: number): number {
  return Math.round(shekels * 100);
}

export function agorotToShekels(agorot: number): number {
  return agorot / 100;
}

// ─── Payload building ────────────────────────────────────────────────────────

export interface CreateLinkInput {
  amountAgorot: number;
  description: string;
  /** Echoed back on the webhook; how a callback finds our record. */
  idempotencyKey: string;
  successUrl: string;
  /** Absolute URL GROW posts the server-to-server callback to. */
  notifyUrl: string;
}

/**
 * Build the CreatePaymentLink request body.
 *
 * Sent as multipart/form-data, never JSON. Sending JSON does not produce a
 * content-type error — the fields simply never parse and GROW answers with a
 * misleading error (typically "userId is required"). That is what the previous
 * version did.
 *
 * The field shape is GROW's documented CreatePaymentLink schema verbatim.
 * GROW's API support rejected the flat `sum` / `pageField[...]` shape (which
 * the meshulam.co.il host happens to accept) as "not relevant" for this call.
 *
 * Notes on values that look arbitrary but are not:
 *   paymentLinkType = 2      GROW support (2026-08-31). The reference implies
 *                            1, which renders a dead payment button.
 *   paymentTypes[0][type]    The literal string "payments". Numeric codes fail
 *                            with err.id 427.
 *   no cancelUrl             The documented schema has successUrl only.
 *
 * Payer name and phone are deliberately NOT pre-filled: GROW's hosted page
 * collects them from whoever actually pays, which is the correct behaviour
 * when the cardholder is not the account holder.
 */
export function buildCreatePaymentLinkForm(
  input: CreateLinkInput,
  config: GrowConfig,
): FormData {
  if (!isValidAgorot(input.amountAgorot) || input.amountAgorot <= 0) {
    throw new Error(
      `Refusing to create a payment link for a non-positive or invalid amount: ${input.amountAgorot}`,
    );
  }

  const form = new FormData();
  form.append("userId", config.userId);
  form.append("pageCode", config.pageCode);
  form.append("paymentLinkType", "2");
  form.append("isActive", "1");
  form.append("title", input.description);
  form.append("paymentTypes[0][type]", "payments");
  form.append("paymentTypes[0][payments][paymentsPaymentNum]", "1");
  form.append("products[data][0][name]", input.description);
  form.append("products[data][0][price]", String(agorotToShekels(input.amountAgorot)));
  form.append("products[data][0][vatType]", config.vatType);
  form.append("successUrl", input.successUrl);
  form.append("notifyUrl", input.notifyUrl);
  form.append("cField1", input.idempotencyKey);
  return form;
}

// ─── Response reading ────────────────────────────────────────────────────────

/**
 * The Light API answers HTTP 200 for failures too, signalling them only in the
 * body: `status` 1 is success, 0 is failure, and it arrives as a number on
 * some inputs and a string on others. Branching on the HTTP code alone reads a
 * declined call as a successful one.
 */
export function isGrowOk(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return String((body as { status?: unknown }).status) === "1";
}

export function growErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "unknown GROW error";
  const err = (body as { err?: { message?: string } | string }).err;
  if (typeof err === "string") return err;
  return err?.message || "unknown GROW error";
}

// ─── Webhook parsing ─────────────────────────────────────────────────────────

/**
 * Flatten GROW's bracket-notation keys.
 *
 * The callback arrives form-encoded, and a body parser turns it into keys that
 * literally contain brackets rather than into nested objects:
 *
 *   "data[sum]": "1"
 *   "data[transactionId]": "542193"
 *   "data[customFields][cField1]": "..."
 *
 * Reading `body.data.transactionId` finds nothing at all against that shape,
 * which is how a real, successful credit-card callback came through with every
 * field null on the reference project. This lifts the leaf name to the top
 * level so both the bracketed and the nested form resolve.
 */
export function flattenBracketKeys(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...body };

  for (const [key, value] of Object.entries(body)) {
    if (!key.includes("[")) continue;
    const leaf = key.replace(/\]/g, "").split("[").pop();
    if (leaf && flat[leaf] === undefined) flat[leaf] = value;
  }

  const data = body.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const leaf = key.includes("[")
        ? key.replace(/\]/g, "").split("[").pop()
        : key;
      if (leaf && flat[leaf] === undefined) flat[leaf] = value;
    }
  }

  return flat;
}

/**
 * Read a field across GROW's inconsistent webhook formats.
 *
 * There is no single webhook format: GROW documents at least four (invoices,
 * recurring charges, failed recurring charges, PaymentLinks) and they disagree
 * on both field names and casing — `webhookKey` vs `webhook_key`, `paymentSum`
 * vs `sum`, flat vs nested under `data`. Every read therefore accepts all the
 * documented spellings rather than assuming one.
 */
export function readField(
  body: Record<string, unknown>,
  ...names: string[]
): unknown {
  const nested =
    body.data && typeof body.data === "object"
      ? (body.data as Record<string, unknown>)
      : {};

  for (const name of names) {
    if (body[name] !== undefined && body[name] !== null && body[name] !== "") {
      return body[name];
    }
    if (nested[name] !== undefined && nested[name] !== null && nested[name] !== "") {
      return nested[name];
    }
  }
  return undefined;
}

export type PaymentStatus = "paid" | "failed" | "cancelled" | "refunded";

/**
 * Map GROW's status vocabulary onto ours.
 *
 * Covers the documented numeric codes, English words, and the Hebrew values
 * GROW returns in the PaymentLinks format ("שולם" = paid, "בוטל" = cancelled).
 *
 * Anything unrecognised becomes "failed", never "paid". A wrong "failed" is a
 * support call; a wrong "paid" is an unpaid order shipped as settled.
 */
export function mapGrowStatus(rawStatus: unknown): PaymentStatus {
  const status = String(rawStatus ?? "").trim().toLowerCase();

  switch (status) {
    case "1":
    case "2":
    case "success":
    case "approved":
    case "paid":
    case "שולם":
      return "paid";
    case "cancel":
    case "cancelled":
    case "canceled":
    case "בוטל":
      return "cancelled";
    case "refund":
    case "refunded":
    case "זוכה":
      return "refunded";
    default:
      return "failed";
  }
}

export interface NormalizedWebhook {
  providerReference: string;
  /** Our cField1 — the key that matches this callback to a local record. */
  idempotencyKey: string | null;
  status: PaymentStatus;
  /** Integer agorot, or null when the callback carried no amount. */
  amountAgorot: number | null;
  cardLast4: string | null;
  cardAuthNumber: string | null;
  failureReason: string | null;
  transactionId: string | null;
  transactionToken: string | null;
  raw: unknown;
}

/**
 * Turn a GROW callback into a normalised shape.
 *
 * Never throws on malformed input: a webhook body is attacker-controllable,
 * and a thrown exception would lose the audit-log entry recording the attempt.
 */
export function normalizeGrowWebhook(body: unknown): NormalizedWebhook {
  const payload = flattenBracketKeys(
    body && typeof body === "object" ? (body as Record<string, unknown>) : {},
  );

  const referenceRaw = readField(
    payload,
    "transactionCode",
    "transactionId",
    "asmachta",
    "transactionToken",
  );
  const idempotencyKeyRaw = readField(payload, "cField1", "cfield1", "customField1");
  const statusRaw = readField(payload, "status", "statusCode", "transactionType");
  const sumRaw = readField(payload, "paymentSum", "sum", "amount");
  const last4Raw = readField(payload, "cardSuffix", "last4");
  const authRaw = readField(payload, "approvalNum", "authNumber", "cardBrand");
  const errRaw = readField(payload, "error_message", "err", "errorMessage", "message");
  const transactionId = readField(payload, "transactionId", "transaction_id");
  const transactionToken = readField(payload, "transactionToken", "transaction_token");

  const sum = Number(sumRaw);
  const status = mapGrowStatus(statusRaw);

  return {
    providerReference: referenceRaw ? String(referenceRaw) : "",
    idempotencyKey: idempotencyKeyRaw ? String(idempotencyKeyRaw) : null,
    status,
    amountAgorot:
      sumRaw !== undefined && Number.isFinite(sum) ? shekelsToAgorot(sum) : null,
    cardLast4: last4Raw ? String(last4Raw).slice(-4) : null,
    cardAuthNumber: authRaw ? String(authRaw) : null,
    failureReason: status === "paid" ? null : errRaw ? String(errRaw) : null,
    transactionId: transactionId ? String(transactionId) : null,
    transactionToken: transactionToken ? String(transactionToken) : null,
    raw: body,
  };
}

// ─── Webhook sender verification ─────────────────────────────────────────────

/**
 * GROW's published webhook sender IPs.
 *
 * GROW support (2026-08) confirmed they do NOT send a `webhookKey` on
 * PaymentLink callbacks, and that getTransactionInfo must not be used as a
 * per-callback check. The sanctioned trust anchor is the network layer:
 *   https://developers.grow.business/reference/ip-address
 *
 * GROW_WEBHOOK_IPS overrides the list (comma/space separated) if GROW
 * publishes new ranges. GROW_DISABLE_IP_CHECK=1 turns the check off — local
 * testing only; it makes the endpoint forgeable by anyone.
 */
const GROW_PUBLISHED_WEBHOOK_IPS = [
  "3.123.194.128", "3.124.62.248", "18.198.97.252", "3.75.43.49",
  "18.156.94.176", "18.158.107.17", "3.121.149.170", "3.76.166.104",
  "3.69.160.29", "3.78.79.166", "3.71.221.153", "3.78.131.18",
  "3.67.110.47", "18.192.112.151", "52.59.95.229", "18.158.145.146",
  "3.75.128.58", "3.78.28.179", "3.122.21.187", "3.66.126.119",
  "35.158.249.118", "52.29.70.254", "52.59.159.234", "3.76.183.119",
  "18.157.106.67", "18.197.238.68", "3.66.129.154", "3.77.123.153",
  "3.70.40.72",
];

export function clientIpOf(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip");
}

/**
 * Verify a callback really came from GROW's network.
 *
 * Returns a reason alongside the verdict because the failure modes need
 * different fixes: a disabled check, no readable IP, and a stranger's IP.
 */
export function verifySenderIp(req: Request): { valid: boolean; reason: string } {
  if (Deno.env.get("GROW_DISABLE_IP_CHECK") === "1") {
    return { valid: true, reason: "ip check disabled (GROW_DISABLE_IP_CHECK=1)" };
  }

  const ip = clientIpOf(req);
  if (!ip) return { valid: false, reason: "no client IP could be read from the request" };

  const configured = Deno.env.get("GROW_WEBHOOK_IPS");
  const allowed = configured
    ? configured.split(/[\s,]+/).filter(Boolean)
    : GROW_PUBLISHED_WEBHOOK_IPS;

  if (!allowed.includes(ip)) {
    return { valid: false, reason: `sender IP ${ip} is not in GROW's published webhook IP list` };
  }
  return { valid: true, reason: `sender IP ${ip} is in GROW's published webhook IP list` };
}

/**
 * Constant-time string comparison, for the formats that DO carry a webhookKey.
 *
 * A plain `===` on a secret leaks its prefix through timing.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Verify the shared secret on the webhook formats that include one (invoices,
 * recurring charges). Returns false when no key is configured: not verifiable
 * must never read as verified.
 */
export function verifyWebhookKey(body: Record<string, unknown>): boolean {
  const configured = Deno.env.get("GROW_WEBHOOK_KEY");
  if (!configured) return false;
  const provided = readField(flattenBracketKeys(body), "webhookKey", "webhook_key");
  if (!provided) return false;
  return timingSafeEquals(String(provided), configured);
}

// ─── approveTransaction ──────────────────────────────────────────────────────

/**
 * Acknowledge the transaction back to GROW after a successful payment.
 *
 * GROW's docs mark this required after every successful payment, and are
 * equally explicit that it gates nothing: "the transaction will still be
 * processed even if the ApproveTransaction request is not executed or fails".
 * So it is best-effort — logged, never allowed to change whether the payment
 * settles, and never allowed to turn the webhook response into an error (GROW
 * would simply retry the original callback).
 *
 * The previous version of this connector omitted this call entirely, which is
 * the single most commonly missed step in a Grow integration.
 *
 * Both identifiers are required: sending only one fails with err.id 54 naming
 * the other.
 */
export async function approveTransaction(
  event: NormalizedWebhook,
  config: GrowConfig,
): Promise<{ attempted: boolean; ok?: boolean; reason?: string }> {
  if (!event.transactionId || !event.transactionToken) {
    return { attempted: false, reason: "callback carried no transactionId/transactionToken" };
  }

  const form = new FormData();
  form.append("pageCode", config.pageCode);
  form.append("transactionId", event.transactionId);
  form.append("transactionToken", event.transactionToken);

  try {
    const response = await fetch(`${lightApiBaseUrl(config)}/approveTransaction`, {
      method: "POST",
      headers: { accept: "application/json", "x-api-key": config.apiKey },
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    return { attempted: true, ok: isGrowOk(body), reason: growErrorMessage(body) };
  } catch (error) {
    return { attempted: true, ok: false, reason: (error as Error).message };
  }
}

// ─── Terminal guard ──────────────────────────────────────────────────────────

/**
 * Refuse to charge through an unverified terminal in production.
 *
 * There is no signal in the API response that distinguishes a virtual charge
 * from a real one, so the only defence against a live site quietly charging
 * through a test terminal is to compare against a value a human wrote down.
 */
export function assertLiveTerminal(
  config: GrowConfig,
  liveTerminal: string | null | undefined,
): void {
  if (config.environment !== "production") return;

  if (!config.expectedTerminal) {
    throw new Error(
      "GROW_EXPECTED_TERMINAL is not set. Production charges are refused until the " +
        "terminal code issued for this merchant is recorded, because a test terminal " +
        "reports every charge as successful while collecting nothing.",
    );
  }
  if (!liveTerminal) {
    throw new Error(
      "GROW did not report a terminal code for these credentials, so it cannot be " +
        "confirmed that charges will actually settle.",
    );
  }
  if (String(liveTerminal) !== String(config.expectedTerminal)) {
    throw new Error(
      `GROW terminal mismatch: charging through "${liveTerminal}" but ` +
        `GROW_EXPECTED_TERMINAL is "${config.expectedTerminal}". Refusing.`,
    );
  }
}
