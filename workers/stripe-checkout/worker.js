/**
 * Cloudflare Worker — Stripe Checkout for Shine Music School
 *
 * Receives booking data, gets the AUTHORITATIVE price from the control panel
 * (V2: POST /api/public/room-booking/quote, single source of truth, no
 * hardcoded rates), creates a Stripe Checkout Session, returns the checkout URL.
 * On payment Stripe calls the V2 webhook (/api/public/stripe-webhook), which
 * records the booking + sends the emails.
 *
 * Environment variable (set via wrangler secret):
 *   STRIPE_SECRET_KEY = sk_live_...
 */

const QUOTE_URL   = 'https://shine-music-school.fly.dev/api/public/room-booking/quote';
const SUCCESS_URL = 'https://forms.shinemusicschool.es/practice-room-booking/success/';
const CANCEL_URL  = 'https://forms.shinemusicschool.es/practice-room-booking/';
const ALLOWED_ORIGIN = 'https://forms.shinemusicschool.es';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
      const data = await request.json();

      if (!data.date || !data.start_time || !data.duration || !data.participants) {
        return jsonResponse({ error: 'Missing required booking fields' }, 400);
      }
      if (!data.name || !data.email) {
        return jsonResponse({ error: 'Name and email are required' }, 400);
      }

      // Authoritative price from the control panel (never hardcoded here).
      const calc = await fetchQuote(data);
      if (!calc || !Array.isArray(calc.breakdown) || calc.total <= 0) {
        return jsonResponse({ error: 'Invalid booking: total is zero' }, 400);
      }

      const checkoutUrl = await createCheckoutSession(env.STRIPE_SECRET_KEY, data, calc);
      return jsonResponse({ url: checkoutUrl });

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message || 'Internal error' }, 500);
    }
  }
};

// ---------------------------------------------------------------------------
// Authoritative price from V2 (the rates source of truth)
// ---------------------------------------------------------------------------

async function fetchQuote(data) {
  const lang = (data.language || data.lang) === 'es' ? 'es' : 'en';
  const resp = await fetch(`${QUOTE_URL}?lang=${lang}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: data.date,
      start_time: data.start_time,
      duration: data.duration,
      participants: data.participants,
      instruments: data.instruments || {},
    }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    throw new Error((result && result.detail) || 'Could not price booking');
  }
  return result; // { total, currency, breakdown: [{ name, detail, amount }] }
}

// ---------------------------------------------------------------------------
// Stripe Checkout Session
// ---------------------------------------------------------------------------

async function createCheckoutSession(secretKey, data, calc) {
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}');
  params.set('cancel_url', CANCEL_URL);
  params.set('customer_email', data.email);
  params.set('metadata[booking_date]', data.date);
  params.set('metadata[start_time]', data.start_time);
  params.set('metadata[duration]', data.duration);
  params.set('metadata[participants]', data.participants);
  params.set('metadata[customer_name]', data.name);
  params.set('metadata[customer_phone]', data.phone || '');
  params.set('metadata[additional_requests]', (data.additional_requests || '').substring(0, 500));
  // Carry the equipment + language so the V2 webhook can record the full booking.
  params.set('metadata[instruments]', JSON.stringify(data.instruments || {}).substring(0, 490));
  params.set('metadata[lang]', (data.language || data.lang) === 'es' ? 'es' : 'en');

  const currency = (calc.currency || 'EUR').toLowerCase();
  for (let i = 0; i < calc.breakdown.length; i++) {
    const item = calc.breakdown[i];
    const prefix = `line_items[${i}]`;
    params.set(`${prefix}[price_data][currency]`, currency);
    params.set(`${prefix}[price_data][product_data][name]`, item.name);
    if (item.detail) {
      params.set(`${prefix}[price_data][product_data][description]`, item.detail);
    }
    params.set(`${prefix}[price_data][unit_amount]`, Math.round(item.amount * 100));
    params.set(`${prefix}[quantity]`, '1');
  }

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(secretKey + ':'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const result = await response.json();
  if (!response.ok) {
    console.error('Stripe error:', JSON.stringify(result));
    throw new Error('Payment failed: ' + (result.error ? result.error.message : 'Unknown error'));
  }
  return result.url;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
