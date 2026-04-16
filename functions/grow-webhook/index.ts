// Grow (Meshulam) Webhook Handler for BASE44
// This handles the async update from Grow after the user completes payment.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    let data;
    
    // 1. Parse data from GET (query params) or POST (json/urlencoded)
    if (req.method === 'GET') {
      const url = new URL(req.url);
      data = Object.fromEntries(url.searchParams.entries());
    } else {
      const contentType = req.headers.get('content-type') || '';
      const bodyText = await req.text();
      
      if (contentType.includes('application/json')) {
        data = JSON.parse(bodyText);
      } else {
        data = Object.fromEntries(new URLSearchParams(bodyText));
      }
    }

    console.log('Grow webhook data:', JSON.stringify(data));

    const base44 = createClientFromRequest(req);

    // 2. Extract key fields (Grow uses various names depending on API version)
    const transactionId = data.transactionId || data.asmachta || data.transaction_id;
    const status = String(data.status || data.paymentStatus); // "1" is success
    const sum = data.sum || data.amount;
    
    // 3. Extract our custom field where we stored the Order/Registration ID
    const orderId = data.cField1 || data.cfield1 || data.customFields?.order_id;

    if (!orderId) {
      console.warn('Webhook skipped: No orderId found in custom fields');
      return Response.json({ success: true, message: 'No ID found' });
    }

    // 4. Update the entity in BASE44 (change 'Order' to your entity name)
    if (status === '1') {
      console.log(`Payment success for Order ${orderId}`);
      await base44.asServiceRole.entities.Order.update(orderId, {
        status: 'completed',
        payment_id: String(transactionId),
        amount_paid: parseFloat(sum) || 0,
        paid_at: new Date().toISOString()
      });
      
      // Pro-tip: Invoke a confirmation email function here if needed
    } else {
      console.log(`Payment failed for Order ${orderId}`);
      await base44.asServiceRole.entities.Order.update(orderId, {
        status: 'failed'
      });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Webhook Error:', error.message);
    // Always return 200 to Grow to stop retries, even on internal errors
    return Response.json({ success: false, error: error.message });
  }
});
