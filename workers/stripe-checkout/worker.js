/**
 * Cloudflare Worker — Stripe Checkout for Shine Music School
 *
 * Receives booking data, recalculates price server-side,
 * creates a Stripe Checkout Session, returns the checkout URL.
 *
 * Environment variable (set via wrangler secret):
 *   STRIPE_SECRET_KEY = sk_live_...
 */

// ---------------------------------------------------------------------------
// Pricing constants (must match form JSON calculations)
// ---------------------------------------------------------------------------

const ROOM_BASE          = 9;   // €/hour
const SURCHARGE_AFTER_17 = 4;   // extra €/hour after 17:00 (Mon-Fri only)
const SUNDAY_TARIFF      = 25;  // flat fee for Sunday
const SAME_DAY_SURCHARGE = 1;   // €/hour for same-day booking
const EXTRA_PERSON_RATE  = 1;   // €/person/hour for participants > 1

const INSTRUMENT_PRICES = {
  acoustic_piano: 3,
  digital_piano: 2,
  keyboard: 1,
  nord_keyboard: 8,
  drums: 2,
  microphone: 2,
  mixing_board: 2,
  speakers: 2,
  electric_guitar: 2,
  bass_guitar: 2,
  amp: 1,
  acoustic_guitar: 1,
  classical_guitar: 1,
  dj_set: 12,
  double_bass: 2,
  saxophone: 2,
};

const SUCCESS_URL = 'https://forms.shinemusicschool.es/practice-room-booking/success/';
const CANCEL_URL  = 'https://forms.shinemusicschool.es/practice-room-booking/';
const ALLOWED_ORIGIN = 'https://forms.shinemusicschool.es';

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
      const data = await request.json();

      // Validate required fields
      if (!data.date || !data.start_time || !data.duration || !data.participants) {
        return jsonResponse({ error: 'Missing required booking fields' }, 400);
      }
      if (!data.name || !data.email) {
        return jsonResponse({ error: 'Name and email are required' }, 400);
      }

      // Server-side price calculation
      const calc = calculateTotal(data);
      if (calc.total <= 0) {
        return jsonResponse({ error: 'Invalid booking: total is zero' }, 400);
      }

      // Create Stripe Checkout Session
      const checkoutUrl = await createCheckoutSession(env.STRIPE_SECRET_KEY, data, calc);

      return jsonResponse({ url: checkoutUrl });

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message || 'Internal error' }, 500);
    }
  }
};

// ---------------------------------------------------------------------------
// Price Calculation (mirrors calculations.js)
// ---------------------------------------------------------------------------

function calculateTotal(data) {
  const duration     = Number(data.duration) || 0;
  const participants = Number(data.participants) || 1;
  const startHour    = parseInt(String(data.start_time).replace('H', ''), 10) || 0;
  const endHour      = startHour + duration;

  const dateStr = data.date || '';
  let isSunday = false, isSaturday = false, isSameDay = false;

  if (dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    isSunday   = d.getUTCDay() === 0;
    isSaturday = d.getUTCDay() === 6;

    const today = new Date();
    isSameDay = (d.getUTCFullYear() === today.getUTCFullYear() &&
                 d.getUTCMonth() === today.getUTCMonth() &&
                 d.getUTCDate() === today.getUTCDate());
  }

  const breakdown = [];
  let total = 0;

  // Room cost
  let normalHours = 0, surchargeHours = 0;
  for (let h = startHour; h < endHour; h++) {
    if (!isSaturday && h >= 17) {
      surchargeHours++;
    } else {
      normalHours++;
    }
  }

  const roomNormal    = normalHours * ROOM_BASE;
  const roomSurcharge = surchargeHours * (ROOM_BASE + SURCHARGE_AFTER_17);
  const roomTotal     = roomNormal + roomSurcharge;

  if (roomTotal > 0) {
    let roomDesc = `${duration}h × ${ROOM_BASE}€`;
    if (surchargeHours > 0 && normalHours > 0) {
      roomDesc = `${normalHours}h × ${ROOM_BASE}€ + ${surchargeHours}h × ${ROOM_BASE + SURCHARGE_AFTER_17}€`;
    } else if (surchargeHours > 0) {
      roomDesc = `${surchargeHours}h × ${ROOM_BASE + SURCHARGE_AFTER_17}€`;
    }
    breakdown.push({ name: 'Room', amount: roomTotal, detail: roomDesc });
  }
  total += roomTotal;

  // Extra participants
  if (participants > 1 && duration > 0) {
    const extraCost = (participants - 1) * EXTRA_PERSON_RATE * duration;
    breakdown.push({
      name: `Extra participants (${participants - 1})`,
      amount: extraCost,
      detail: `${participants - 1} × ${EXTRA_PERSON_RATE}€ × ${duration}h`,
    });
    total += extraCost;
  }

  // Sunday tariff
  if (isSunday && duration > 0) {
    breakdown.push({ name: 'Sunday opening fee', amount: SUNDAY_TARIFF, detail: `+${SUNDAY_TARIFF}€` });
    total += SUNDAY_TARIFF;
  }

  // Same-day booking
  if (isSameDay && duration > 0 && SAME_DAY_SURCHARGE > 0) {
    const sameDayTotal = SAME_DAY_SURCHARGE * duration;
    breakdown.push({
      name: 'Same-day booking',
      amount: sameDayTotal,
      detail: `+${SAME_DAY_SURCHARGE}€/h × ${duration}h`,
    });
    total += sameDayTotal;
  }

  // Instruments
  const instruments = data.instruments || {};
  for (const instrId of Object.keys(instruments)) {
    const qty = Number(instruments[instrId]) || 0;
    if (qty > 0 && INSTRUMENT_PRICES[instrId]) {
      const price = INSTRUMENT_PRICES[instrId];
      const instrCost = qty * price;
      breakdown.push({
        name: instrId.replace(/_/g, ' '),
        amount: instrCost,
        detail: `${qty} × ${price}€`,
      });
      total += instrCost;
    }
  }

  return { total, breakdown };
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

  // Add line items from breakdown
  for (let i = 0; i < calc.breakdown.length; i++) {
    const item = calc.breakdown[i];
    const prefix = `line_items[${i}]`;
    params.set(`${prefix}[price_data][currency]`, 'eur');
    params.set(`${prefix}[price_data][product_data][name]`, item.name);
    params.set(`${prefix}[price_data][product_data][description]`, item.detail);
    params.set(`${prefix}[price_data][unit_amount]`, Math.round(item.amount * 100)); // cents
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
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
