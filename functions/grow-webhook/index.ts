/**
 * grow-webhook — GROW's server-to-server payment callback.
 *
 * Three rules shape this handler:
 *
 * 1. Log first, act second. The event is logged before anything is
 *    interpreted, so a callback that fails mid-processing still leaves
 *    evidence. In a dispute over whether a customer was charged, this is the
 *    record.
 *
 * 2. Verify before settling. Anyone can POST here. GROW does not send a
 *    webhookKey on PaymentLink callbacks (support, 2026-08), so the trust
 *    anchor is the published sender-IP allow-list. The previous version of
 *    this connector had no verification at all: a single unauthenticated POST
 *    with a guessed order id marked any order paid.
 *
 * 3. Check the amount. Sender verification does not bind to the payload's
 *    contents, so the reported sum must match what we recorded when the link
 *    was created.
 *
 * Always answers HTTP 200. A non-200 makes GROW retry a callback we have
 * already handled.
 */

import { createClientFromRequest } from "npm:@base44/sdk@0.8.25";
import {
  approveTransaction,
  normalizeGrowWebhook,
  readGrowConfig,
  verifySenderIp,
  verifyWebhookKey,
} from "../_shared/grow.ts";

/** Parse GET query params, JSON, or form-encoded bodies into one object. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET") {
    return Object.fromEntries(new URL(req.url).searchParams.entries());
  }

  const contentType = req.headers.get("content-type") || "";
  const text = await req.text();

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

Deno.serve(async (req: Request) => {
  const ack = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const body = await readBody(req);

    // 1. Log the raw callback, in both the form-encoded shape GROW sent and as
    //    an object, before interpreting anything.
    console.info(
      "[grow-webhook] callback received\n" +
        `method: ${req.method}\n` +
        `content-type: ${req.headers.get("content-type") ?? "(none)"}\n` +
        `payload: ${JSON.stringify(body, null, 2)}`,
    );

    const event = normalizeGrowWebhook(body);

    // 2. Verify the sender. The IP allow-list is the sanctioned check; a
    //    webhookKey is accepted as an alternative for the formats that carry
    //    one (invoices, recurring charges).
    const ipCheck = verifySenderIp(req);
    const keyValid = verifyWebhookKey(body);

    if (!ipCheck.valid && !keyValid) {
      console.error(
        `[grow-webhook] REJECTED unverified callback: ${ipCheck.reason}; no valid webhookKey`,
      );
      // 200 with matched:false — never reveal to an unverified caller whether
      // the id they guessed exists.
      return ack({ received: true, matched: false });
    }

    if (!event.idempotencyKey) {
      console.warn("[grow-webhook] callback carried no cField1 — cannot match a record");
      return ack({ received: true, matched: false });
    }

    const base44 = createClientFromRequest(req);

    // 3. Find OUR record by the key we generated, not by an id the caller
    //    supplied. The previous version took the order id straight from the
    //    payload.
    const matches = await base44.asServiceRole.entities.Order.filter({
      payment_idempotency_key: event.idempotencyKey,
    });
    const order = Array.isArray(matches) ? matches[0] : matches;

    if (!order) {
      console.warn(`[grow-webhook] no order for idempotency key ${event.idempotencyKey}`);
      return ack({ received: true, matched: false });
    }

    // 4. Already settled? Acknowledge and stop. GROW retries, and a customer
    //    can refresh the success page: re-running settlement would book the
    //    same money twice.
    if (order.status === "completed") {
      console.info(`[grow-webhook] duplicate callback for order ${order.id} — already settled`);
      return ack({ received: true, duplicate: true });
    }

    const config = readGrowConfig();

    if (event.status !== "paid") {
      await base44.asServiceRole.entities.Order.update(order.id, {
        status: "payment_failed",
        payment_failure_reason: event.failureReason || `GROW status: ${event.status}`,
      });
      return ack({ received: true, matched: true, status: event.status });
    }

    // 5. Check the amount against what we recorded. Silence is not agreement:
    //    a callback with no amount does not match.
    const recorded = Number(order.payment_amount_agorot ?? NaN);
    if (
      Number.isFinite(recorded) &&
      (event.amountAgorot === null || event.amountAgorot !== recorded)
    ) {
      console.error(
        `[grow-webhook] amount mismatch for order ${order.id}: ` +
          `callback ${event.amountAgorot}, recorded ${recorded}`,
      );
      await base44.asServiceRole.entities.Order.update(order.id, {
        status: "payment_review",
        payment_failure_reason:
          `סכום ה-webhook (${event.amountAgorot}) אינו תואם לסכום שנרשם (${recorded})`,
      });
      return ack({ received: true, matched: true, amountMismatch: true });
    }

    // 6. Settle.
    await base44.asServiceRole.entities.Order.update(order.id, {
      status: "completed",
      payment_id: event.providerReference || order.payment_id || null,
      payment_card_last4: event.cardLast4,
      payment_auth_number: event.cardAuthNumber,
      amount_paid: event.amountAgorot !== null ? event.amountAgorot / 100 : undefined,
      paid_at: new Date().toISOString(),
    });

    // 7. Acknowledge back to GROW. Required after every successful payment,
    //    and best-effort by GROW's own definition: its outcome is logged but
    //    never changes whether the payment settled.
    if (config) {
      const result = await approveTransaction(event, config);
      console.info(`[grow-webhook] approveTransaction: ${JSON.stringify(result)}`);
    } else {
      console.error("[grow-webhook] GROW not configured — approveTransaction skipped");
    }

    return ack({ received: true, matched: true, status: "completed" });
  } catch (error) {
    // Still 200: an internal failure must not make GROW retry forever.
    console.error("[grow-webhook] error:", (error as Error).message);
    return ack({ received: true, error: true });
  }
});
