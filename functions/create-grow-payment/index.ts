/**
 * create-grow-payment — creates a GROW (Meshulam) payment link.
 *
 * Flow:
 *   1. Load the order server-side and price it from OUR data, never from the
 *      request body.
 *   2. Record the pending payment attempt before redirecting anywhere.
 *   3. Ask GROW for a payment link (CreatePaymentLink, multipart/form-data).
 *   4. Return the hosted-page URL.
 *
 * Server-side only. Holds merchant secrets and the service-role client.
 */

import { createClientFromRequest } from "npm:@base44/sdk@0.8.25";
import {
  buildCreatePaymentLinkForm,
  createPaymentLinkUrl,
  growErrorMessage,
  isGrowOk,
  readGrowConfig,
} from "../_shared/grow.ts";

/**
 * CORS.
 *
 * `*` was wrong here: this endpoint starts a charge, so any page on the
 * internet could drive it. Set ALLOWED_ORIGIN to the app's own origin; the
 * fallback is the request's origin only when nothing is configured, and never
 * with credentials.
 */
function corsHeaders(req: Request): Record<string, string> {
  const allowed = Deno.env.get("ALLOWED_ORIGIN");
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowed || origin || "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req);

  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  }

  const config = readGrowConfig();
  if (!config) {
    // Explicitly not a 500: "not configured" is a normal state before GROW
    // issues credentials, and it must not look like a bug.
    return new Response(
      JSON.stringify({
        error: "Payments are not configured.",
        detail: "GROW_PAGE_CODE, GROW_USER_ID and GROW_API_KEY are all required.",
      }),
      { status: 503, headers },
    );
  }

  try {
    const body = await req.json();
    const { orderId, successUrl } = body ?? {};

    if (!orderId) {
      return new Response(JSON.stringify({ error: "orderId is required" }), {
        status: 400,
        headers,
      });
    }

    const base44 = createClientFromRequest(req);
    const order = await base44.asServiceRole.entities.Order.get(orderId);

    if (!order) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404,
        headers,
      });
    }

    // Already paid orders must not produce a second payment link.
    if (order.status === "completed") {
      return new Response(
        JSON.stringify({ error: "Order is already paid", status: order.status }),
        { status: 409, headers },
      );
    }

    // Re-price from our own record.
    //
    // The amount the browser sends is a request, not a fact: a client-supplied
    // price is a client-controlled price, and the previous version charged
    // whatever number the caller put in `amount`. Anyone could have paid ₪1 for
    // a ₪1,400 order.
    const amountAgorot =
      typeof order.amount_agorot === "number"
        ? order.amount_agorot
        : Math.round(Number(order.amount ?? 0) * 100);

    if (!Number.isSafeInteger(amountAgorot) || amountAgorot <= 0) {
      return new Response(
        JSON.stringify({ error: "Order has no payable amount" }),
        { status: 400, headers },
      );
    }

    const description = String(order.description || `הזמנה ${orderId}`).slice(0, 120);

    // Generated once per attempt and echoed back by GROW in cField1. This is
    // what lets the webhook find our row and recognise a replay.
    const idempotencyKey = order.payment_idempotency_key || `grow-${crypto.randomUUID()}`;

    const origin = new URL(req.url).origin;
    const notifyUrl = Deno.env.get("GROW_NOTIFY_URL") || `${origin}/grow-webhook`;

    // Record the attempt BEFORE redirecting. A charge that succeeds at GROW but
    // whose callback never arrives is then still visible as pending and can be
    // reconciled, instead of disappearing entirely.
    await base44.asServiceRole.entities.Order.update(orderId, {
      status: "pending_payment",
      payment_idempotency_key: idempotencyKey,
      payment_amount_agorot: amountAgorot,
      payment_provider: "grow",
    });

    const form = buildCreatePaymentLinkForm(
      {
        amountAgorot,
        description,
        idempotencyKey,
        successUrl: successUrl || Deno.env.get("GROW_SUCCESS_URL") || "",
        notifyUrl,
      },
      config,
    );

    const url = createPaymentLinkUrl(config);
    const growResponse = await fetch(url, {
      method: "POST",
      // multipart/form-data — set by fetch from the FormData body. Do NOT set
      // Content-Type by hand; the boundary would be missing.
      headers: { accept: "application/json", "x-api-key": config.apiKey },
      body: form,
    });

    const growBody = await growResponse.json().catch(() => ({}));

    // Log the exact request/response for GROW support. The API key is never
    // logged.
    const formFields: Record<string, string> = {};
    form.forEach((value, key) => {
      formFields[key] = String(value);
    });
    console.info(
      "[create-grow-payment] GROW call\n" +
        `url: ${url}\n` +
        `content-type: multipart/form-data\n` +
        `fields: ${JSON.stringify(formFields, null, 2)}\n` +
        `http: ${growResponse.status}\n` +
        `response: ${JSON.stringify(growBody, null, 2)}`,
    );

    const paymentUrl = growBody?.data?.url;

    if (!growResponse.ok || !isGrowOk(growBody) || !paymentUrl) {
      await base44.asServiceRole.entities.Order.update(orderId, {
        status: "payment_failed",
        payment_failure_reason: growErrorMessage(growBody),
      });
      return new Response(
        JSON.stringify({ error: "Payment provider rejected the request." }),
        { status: 502, headers },
      );
    }

    // Store the process identifiers for reconciliation (getPaymentProcessInfo)
    // and for support. The field is spelled processId on one host and
    // paymentLinkProcessId on the other, so both are accepted.
    const processId = growBody?.data?.processId ?? growBody?.data?.paymentLinkProcessId;
    const processToken =
      growBody?.data?.processToken ?? growBody?.data?.paymentLinkProcessToken;

    await base44.asServiceRole.entities.Order.update(orderId, {
      payment_id: String(processId || ""),
      payment_process_token: String(processToken || ""),
      payment_url: paymentUrl,
    });

    return new Response(
      JSON.stringify({ url: paymentUrl, processId: processId || null }),
      { status: 200, headers },
    );
  } catch (error) {
    // The message is logged, not returned: it can carry internal detail.
    console.error("[create-grow-payment] failed:", (error as Error).message);
    return new Response(
      JSON.stringify({ error: "Internal error creating payment link." }),
      { status: 500, headers },
    );
  }
});
