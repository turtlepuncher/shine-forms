/**
 * Cloudflare Worker — Stripe Checkout for Shine Music School / The Music Room
 *
 * Receives booking data, gets the AUTHORITATIVE price from the control panel
 * (V2: POST /api/public/room-booking/quote, single source of truth, no
 * hardcoded rates), creates a Stripe Checkout Session, returns the checkout URL
 * + session id. On payment Stripe calls the V2 webhook (/api/public/stripe-webhook),
 * which records the booking + sends the emails.
 *
 * Multi-origin: every allowed origin has its own success/cancel redirect targets.
 * For The Music Room origins those targets are language-aware (en / es / ca) so a
 * customer lands on the confirmation page in the language they booked in.
 *
 * Environment variable (set via wrangler secret):
 *   STRIPE_SECRET_KEY = sk_live_...
 */

const QUOTE_URL = 'https://shine-music-school.fly.dev/api/public/room-booking/quote';

// The Music Room is multilingual; redirect to the language-correct pages.
// (Test phase: cancel returns to the -test / reserva booking pages. At the live
// flip, swap these for the live booking slugs: en -> /booking/, es -> /es/reservar/,
// ca -> /ca/<live-slug>/.)
const TMR_CONFIRM = {
  en: '/booking-confirmation/',
  es: '/es/confirmacion-reserva/',
  ca: '/ca/confirmacio-reserva/',
};
const TMR_CANCEL = {
  en: '/booking-test/',
  es: '/es/reservar-test/',
  ca: '/ca/reserva-sala/',
};

// Resolver for a Music Room origin: same paths across origins, only the base differs.
function tmrOrigin(base) {
  return {
    urls(lang) {
      const l = TMR_CONFIRM[lang] ? lang : 'en';
      return { success: base + TMR_CONFIRM[l], cancel: base + TMR_CANCEL[l] };
    },
  };
}

// Allowed origins. forms.shinemusicschool.es keeps its own single (Spanish)
// booking flow; the Music Room origins are language-aware.
const ORIGINS = {
  'https://forms.shinemusicschool.es': {
    urls() {
      return {
        success: 'https://forms.shinemusicschool.es/practice-room-booking/success/',
        cancel: 'https://forms.shinemusicschool.es/practice-room-booking/',
      };
    },
  },
  'https://themusicroombcn.com': tmrOrigin('https://themusicroombcn.com'),
  'https://www.themusicroombcn.com': tmrOrigin('https://www.themusicroombcn.com'),
  'https://stg-themusicroom-staging.kinsta.cloud': tmrOrigin('https://stg-themusicroom-staging.kinsta.cloud'),
};

// Booking language for redirects: en / es / ca (defaults to en).
function bookingLang(data) {
  const l = data.language || data.lang;
  return l === 'es' || l === 'ca' ? l : 'en';
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const originConfig = ORIGINS[origin];

    if (request.method === 'OPTIONS') {
      if (!originConfig) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }
    if (!originConfig) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, origin);
    }

    try {
      const data = await request.json();

      if (!data.date || !data.start_time || !data.duration || !data.participants) {
        return jsonResponse({ error: 'Missing required booking fields' }, 400, origin);
      }
      if (!data.name || !data.email) {
        return jsonResponse({ error: 'Name and email are required' }, 400, origin);
      }

      // Authoritative price from the control panel (never hardcoded here).
      const calc = await fetchQuote(data);
      if (!calc || !Array.isArray(calc.breakdown) || calc.total <= 0) {
        return jsonResponse({ error: 'Invalid booking: total is zero' }, 400, origin);
      }

      const redirect = originConfig.urls(bookingLang(data));
      const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, data, calc, redirect);
      return jsonResponse({ url: session.url, session_id: session.id }, 200, origin);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message || 'Internal error' }, 500, origin);
    }
  },
};

// ---------------------------------------------------------------------------
// Authoritative price from V2 (the rates source of truth)
// ---------------------------------------------------------------------------

async function fetchQuote(data) {
  // Quote line-item labels are localized by the V2 backend (en / es / ca).
  const lang = bookingLang(data);
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

async function createCheckoutSession(secretKey, data, calc, redirect) {
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', redirect.success + '?session_id={CHECKOUT_SESSION_ID}');
  params.set('cancel_url', redirect.cancel);
  params.set('customer_email', data.email);
  params.set('metadata[booking_date]', data.date);
  params.set('metadata[start_time]', data.start_time);
  params.set('metadata[duration]', data.duration);
  params.set('metadata[participants]', data.participants);
  params.set('metadata[customer_name]', data.name);
  params.set('metadata[customer_phone]', data.phone || '');
  params.set('metadata[additional_requests]', (data.additional_requests || '').substring(0, 500));
  // Carry the equipment + language so the V2 webhook can record the full booking
  // and send the confirmation email in the booking language (en / es / ca).
  params.set('metadata[instruments]', JSON.stringify(data.instruments || {}).substring(0, 490));
  params.set('metadata[lang]', bookingLang(data));
  // Tags this session as ours so the V2 webhook ignores other businesses'
  // checkouts on the shared Stripe account.
  params.set('metadata[booking_source]', 'shine_room_booking');

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
  return { url: result.url, id: result.id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(origin) {
  const allowed = ORIGINS[origin] ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status = 200, origin = '') {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
