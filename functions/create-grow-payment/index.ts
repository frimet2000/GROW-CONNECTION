// Grow (Meshulam) Payment Function for BASE44
// Based on the successful implementation in groupy-loopy

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

serve(async (req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  try {
    const { amount, description, travelerName, travelerPhone, successUrl, cancelUrl } = await req.json();

    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: "Missing or invalid amount" }), { 
        status: 400, 
        headers 
      });
    }

    const growResponse = await fetch('https://api.meshulam.co.il/api/light/createPaymentPage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: Deno.env.get('GROW_USER_ID'),
        pageCode: Deno.env.get('GROW_PAGE_CODE'),
        sum: Math.round(amount),
        description: description || "Payment",
        paymentNum: 1,
        fullName: travelerName || "",
        phone: travelerPhone || "",
        successUrl: successUrl || "",
        cancelUrl: cancelUrl || "",
      })
    });

    const data = await growResponse.json();

    if (data.status === 1 && data.data?.url) {
      return new Response(JSON.stringify({ url: data.data.url }), { 
        status: 200, 
        headers 
      });
    } else {
      return new Response(JSON.stringify({ 
        error: data.err?.message || 'Failed to create payment page',
        details: data 
      }), { 
        status: 400, 
        headers 
      });
    }

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers 
    });
  }
});
