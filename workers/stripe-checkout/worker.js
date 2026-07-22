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
const CLAIM_URL = 'https://shine-music-school.fly.dev/api/public/room-booking/last-minute-link/claim';

// Same-day (last-minute) bookings are only allowed through the hidden
// last-minute pages, whose links carry a one-time token minted on the
// control panel. The gate lives HERE, at the money step: a same-day
// checkout without a claimable token is refused, so old or forwarded
// links die server-side no matter what the client-side form allows.
const LM_MESSAGES = {
  missing: {
    en: 'Same-day bookings need a valid last-minute link. Please contact us to get one.',
    es: 'Las reservas para el mismo día necesitan un enlace de última hora válido. Contáctanos para conseguir uno.',
    ca: 'Les reserves per al mateix dia necessiten un enllaç d’última hora vàlid. Contacta amb nosaltres per aconseguir-ne un.',
    it: 'Le prenotazioni in giornata richiedono un link last minute valido. Contattaci per riceverne uno.',
  },
  dead: {
    en: 'This last-minute link has already been used or has expired. Please contact us for a new one.',
    es: 'Este enlace de última hora ya se ha utilizado o ha caducado. Contáctanos para conseguir uno nuevo.',
    ca: 'Aquest enllaç d’última hora ja s’ha fet servir o ha caducat. Contacta amb nosaltres per aconseguir-ne un de nou.',
    it: 'Questo link last minute è già stato usato o è scaduto. Contattaci per riceverne uno nuovo.',
  },
  busy: {
    en: 'This link is already being used in another checkout. If that payment was not completed, try again in about half an hour, or contact us.',
    es: 'Este enlace ya se está utilizando en otro pago. Si ese pago no se completó, inténtalo de nuevo en una media hora, o contáctanos.',
    ca: 'Aquest enllaç ja s’està fent servir en un altre pagament. Si aquell pagament no es va completar, torna-ho a provar d’aquí a mitja hora, o contacta amb nosaltres.',
    it: 'Questo link è già in uso in un altro pagamento. Se quel pagamento non è stato completato, riprova tra circa mezz’ora, o contattaci.',
  },
  error: {
    en: 'We could not verify your booking link. Please try again in a moment.',
    es: 'No hemos podido verificar tu enlace de reserva. Inténtalo de nuevo en un momento.',
    ca: 'No hem pogut verificar el teu enllaç de reserva. Torna-ho a provar d’aquí a un moment.',
    it: 'Non siamo riusciti a verificare il tuo link di prenotazione. Riprova tra un momento.',
  },
};

// The Music Room is multilingual; redirect to the language-correct pages.
// (Live since 2026-07-05: the native form runs on the live booking pages, so a
// cancelled checkout returns there. The CA page kept its slug at the flip.)
const TMR_CONFIRM = {
  en: '/booking-confirmation/',
  es: '/es/confirmacion-reserva/',
  ca: '/ca/confirmacio-reserva/',
  it: '/it/conferma-prenotazione/',
};
const TMR_CANCEL = {
  en: '/booking/',
  es: '/es/reservar/',
  ca: '/ca/reserva-sala/',
  it: '/it/prenota-sala/',
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

// Booking language for redirects: en / es / ca / it (defaults to en).
function bookingLang(data) {
  const l = data.language || data.lang;
  return l === 'es' || l === 'ca' || l === 'it' ? l : 'en';
}

// Today in Europe/Madrid as YYYY-MM-DD (en-CA locale gives ISO order),
// matching the payload's date format and the V2 backend's Madrid clock.
function madridToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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
      // A malformed date could slip past the same-day gate below (string
      // comparison), so insist on the YYYY-MM-DD the forms always send.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) {
        return jsonResponse({ error: 'Invalid booking date' }, 400, origin);
      }

      // Authoritative price from the control panel (never hardcoded here).
      const calc = await fetchQuote(data);
      if (!calc || !Array.isArray(calc.breakdown) || calc.total <= 0) {
        return jsonResponse({ error: 'Invalid booking: total is zero' }, 400, origin);
      }

      // Same-day gate: claim the one-time last-minute token right before
      // money changes hands. Quoting first means a booking the backend
      // would reject never burns a token.
      if (data.date === madridToday()) {
        const lang = bookingLang(data);
        const token = String(data.last_minute_token || '').trim();
        if (!token) {
          return jsonResponse({ error: LM_MESSAGES.missing[lang] }, 403, origin);
        }
        const claim = await claimLastMinuteToken(token, env.LM_CLAIM_KEY);
        if (!claim.ok) {
          const key = claim.reason === 'busy' ? 'busy'
            : claim.reason === 'error' ? 'error' : 'dead';
          return jsonResponse({ error: LM_MESSAGES[key][lang] }, claim.status, origin);
        }
        // The claim nonce rides into Stripe metadata so the V2 webhook can
        // tell a payment from a superseded (re-claimed) session apart.
        data.lm_nonce = claim.nonce || '';
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
  // The claimed one-time token rides along so the V2 webhook can mark it
  // used (and flag the booking last-minute) once the payment lands. The
  // session must die BEFORE the 35-min claim TTL frees the token, or one
  // token could fund two payable sessions (Stripe minimum expiry: 30 min).
  if (data.last_minute_token) {
    params.set('metadata[last_minute_token]', String(data.last_minute_token).substring(0, 100));
    if (data.lm_nonce) {
      params.set('metadata[lm_nonce]', String(data.lm_nonce).substring(0, 64));
    }
    params.set('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60));
  }
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
// Last-minute token claim (V2 backend enforces single use + expiry)
// ---------------------------------------------------------------------------

async function claimLastMinuteToken(token, claimKey) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    // Shared secret: the V2 backend skips rate limiting for the real Worker,
    // so anonymous junk traffic can never 429 a legitimate checkout.
    if (claimKey) {
      headers['X-LM-Claim-Key'] = claimKey;
    }
    const resp = await fetch(CLAIM_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token }),
    });
    let body = null;
    try {
      body = await resp.json();
    } catch {
      // non-JSON response; fall through on status alone
    }
    if (resp.ok) {
      return { ok: true, nonce: (body && body.nonce) || '' };
    }
    // Branch on HTTP status FIRST; detail is only a reason enum on 403/409.
    if (resp.status === 409) {
      return { ok: false, reason: 'busy', status: 409 };
    }
    if (resp.status === 429 || resp.status >= 500) {
      return { ok: false, reason: 'error', status: 503 };
    }
    const reason = body && typeof body.detail === 'string' ? body.detail : 'unknown';
    return { ok: false, reason, status: 403 };
  } catch (err) {
    // Backend unreachable: fail CLOSED (this is the enforcement point) with
    // a retryable message.
    console.error('last-minute claim error:', err);
    return { ok: false, reason: 'error', status: 503 };
  }
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
