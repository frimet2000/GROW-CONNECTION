// Grow (Meshulam) Status Manual Check for BASE44
// Use this for polling or manual "Verify Payment" buttons.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const { orderId } = await req.json();
    if (!orderId) return Response.json({ error: 'Missing orderId' }, { status: 400 });

    const base44 = createClientFromRequest(req);
    const order = await base44.asServiceRole.entities.Order.get(orderId);
    
    if (!order || !order.payment_id) {
       return Response.json({ status: 'pending', message: 'No transaction ID yet' });
    }

    // Prepare FormData for the check status API
    const form = new FormData();
    form.append('userId', Deno.env.get('GROW_USER_ID') || '');
    form.append('pageCode', Deno.env.get('GROW_PAGE_CODE') || '');
    form.append('processId', order.payment_id);

    const response = await fetch('https://api.meshulam.co.il/api/light/server/1.0/getPaymentProcessInfo', {
      method: 'POST',
      body: form
    });

    const data = await response.json();
    console.log('Grow status check:', JSON.stringify(data));

    if (data.status === 1 && data.data?.transactionStatus === 1) {
      // Transaction is confirmed as successful
      await base44.asServiceRole.entities.Order.update(orderId, {
        status: 'completed',
        amount_paid: parseFloat(data.data.sum) || order.amount_paid
      });
      return Response.json({ status: 'completed' });
    }

    return Response.json({ status: order.status || 'pending' });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
