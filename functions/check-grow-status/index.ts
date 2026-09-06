/**
 * check-grow-status — ask GROW directly what happened to a payment.
 *
 * For polling and for a manual "Verify payment" button: the reconciliation
 * path for when a callback never arrived (the customer closed the tab, the
 * webhook was down). Because the answer comes from GROW over a server-to-server
 * call rather than from an inbound request, it can settle an order on its own.
 */

import { createClientFromRequest } from "npm:@base44/sdk@0.8.25";
import {
  isGrowOk,
  lightApiBaseUrl,
  mapGrowStatus,
  readField,
  readGrowConfig,
  shekelsToAgorot,
} from "../_shared/grow.ts";

Deno.serve(async (req: Request) => {
  const json = (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const config = readGrowConfig();
  if (!config) {
    return json({ error: "Payments are not configured." }, 503);
  }

  try {
    const { orderId } = await req.json();
    if (!orderId) return json({ error: "Missing orderId" }, 400);

    const base44 = createClientFromRequest(req);
    const order = await base44.asServiceRole.entities.Order.get(orderId);

    if (!order) return json({ error: "Order not found" }, 404);
    if (order.status === "completed") return json({ status: "completed" });
    if (!order.payment_id) return json({ status: "pending", message: "No process id yet" });

    // getPaymentProcessInfo lives on the per-environment Light API host, not on
    // api.meshulam.co.il. FormData, like every Light API call.
    const form = new FormData();
    form.append("userId", config.userId);
    form.append("pageCode", config.pageCode);
    form.append("processId", String(order.payment_id));
    if (order.payment_process_token) {
      form.append("processToken", String(order.payment_process_token));
    }

    const response = await fetch(`${lightApiBaseUrl(config)}/getPaymentProcessInfo`, {
      method: "POST",
      headers: { accept: "application/json", "x-api-key": config.apiKey },
      body: form,
    });

    const data = await response.json().catch(() => ({}));
    console.info(`[check-grow-status] order ${orderId}: ${JSON.stringify(data)}`);

    // The Light API answers HTTP 200 for failures too — the body's `status`
    // field is what decides.
    if (!isGrowOk(data)) {
      return json({ status: order.status || "pending", provider: "no_confirmation" });
    }

    const payload = (data.data ?? {}) as Record<string, unknown>;
    const transactionStatus = readField(payload, "transactionStatus", "status");
    const settled = mapGrowStatus(transactionStatus) === "paid";

    if (!settled) {
      return json({ status: order.status || "pending" });
    }

    // Same amount check as the webhook: GROW confirming *a* payment is not
    // confirmation it was for the right amount.
    const sumRaw = readField(payload, "sum", "paymentSum", "amount");
    const paidAgorot = Number.isFinite(Number(sumRaw)) ? shekelsToAgorot(Number(sumRaw)) : null;
    const recorded = Number(order.payment_amount_agorot ?? NaN);

    if (Number.isFinite(recorded) && (paidAgorot === null || paidAgorot !== recorded)) {
      console.error(
        `[check-grow-status] amount mismatch on order ${orderId}: GROW ${paidAgorot}, recorded ${recorded}`,
      );
      await base44.asServiceRole.entities.Order.update(orderId, {
        status: "payment_review",
        payment_failure_reason: `סכום שהתקבל (${paidAgorot}) אינו תואם לסכום שנרשם (${recorded})`,
      });
      return json({ status: "payment_review", amountMismatch: true });
    }

    await base44.asServiceRole.entities.Order.update(orderId, {
      status: "completed",
      amount_paid: paidAgorot !== null ? paidAgorot / 100 : order.amount_paid,
      paid_at: new Date().toISOString(),
    });

    return json({ status: "completed" });
  } catch (error) {
    console.error("[check-grow-status] failed:", (error as Error).message);
    return json({ error: "Internal error checking payment status." }, 500);
  }
});
