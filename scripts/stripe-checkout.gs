/**
 * Google Apps Script — Stripe Checkout Backend for Practice Room Booking
 *
 * Setup:
 * 1. Go to https://script.google.com → New project
 * 2. Paste this entire file into Code.gs
 * 3. Go to Project Settings → Script Properties → Add:
 *    - STRIPE_SECRET_KEY = sk_live_...  (your Stripe live secret key)
 * 4. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the deployment URL and set it in practice-room-booking.json
 *    under payment.checkout_endpoint
 *
 * Flow:
 *   Browser POSTs booking data → this script recalculates price server-side
 *   → creates Stripe Checkout Session → redirects browser to Stripe payment page
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var SUCCESS_URL = 'https://forms.shinemusicschool.es/practice-room-booking/success/';
var CANCEL_URL  = 'https://forms.shinemusicschool.es/practice-room-booking/';

// Pricing constants (must match form JSON calculations)
var ROOM_BASE         = 9;   // €/hour
var SURCHARGE_AFTER17 = 4;   // extra €/hour after 17:00 (Mon-Fri only)
var SUNDAY_TARIFF     = 25;  // flat fee for Sunday
var SAME_DAY_SURCHARGE = 1;  // €/hour for same-day booking
var EXTRA_PERSON_RATE = 1;   // €/person/hour for participants > 1

var INSTRUMENT_PRICES = {
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
  saxophone: 2
};

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

function doPost(e) {
  try {
    var data;
    // Support both form-encoded (payload field) and raw JSON
    if (e.parameter && e.parameter.payload) {
      data = JSON.parse(e.parameter.payload);
    } else if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else {
      return errorPage_('No data received');
    }

    // Validate required fields
    if (!data.date || !data.start_time || !data.duration || !data.participants) {
      return errorPage_('Missing required booking fields');
    }
    if (!data.name || !data.email) {
      return errorPage_('Name and email are required');
    }

    // Server-side price calculation (never trust client total)
    var calc = calculateTotal_(data);

    if (calc.total <= 0) {
      return errorPage_('Invalid booking: total is zero');
    }

    // Create Stripe Checkout Session
    var checkoutUrl = createCheckoutSession_(data, calc);

    // Redirect browser to Stripe
    return HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head>' +
      '<meta http-equiv="refresh" content="0;url=' + checkoutUrl + '">' +
      '<style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa}' +
      '.loader{text-align:center}.spinner{width:40px;height:40px;border:4px solid #e0e0e0;border-top:4px solid #1a1a2e;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}' +
      '@keyframes spin{to{transform:rotate(360deg)}}p{color:#555;font-size:16px}</style></head>' +
      '<body><div class="loader"><div class="spinner"></div><p>Redirecting to payment...</p></div>' +
      '<script>window.top.location.href="' + checkoutUrl + '";</script>' +
      '</body></html>'
    ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (err) {
    return errorPage_('Error: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// GET handler (for testing / health check)
// ---------------------------------------------------------------------------

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', service: 'shine-stripe-checkout' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Price Calculation (server-side — mirrors calculations.js)
// ---------------------------------------------------------------------------

function calculateTotal_(data) {
  var duration     = Number(data.duration) || 0;
  var participants = Number(data.participants) || 1;
  var startHour    = parseInt(String(data.start_time).replace('H', ''), 10) || 0;
  var endHour      = startHour + duration;

  // Date checks
  var dateStr   = data.date || '';
  var isSunday  = false;
  var isSaturday = false;
  var isSameDay = false;

  if (dateStr) {
    var d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone issues
    isSunday  = (d.getDay() === 0);
    isSaturday = (d.getDay() === 6);

    var today = new Date();
    isSameDay = (d.getFullYear() === today.getFullYear() &&
                 d.getMonth() === today.getMonth() &&
                 d.getDate() === today.getDate());
  }

  var breakdown = [];
  var total = 0;

  // Room cost
  var normalHours = 0;
  var surchargeHours = 0;

  for (var h = startHour; h < endHour; h++) {
    if (!isSaturday && h >= 17) {
      surchargeHours++;
    } else {
      normalHours++;
    }
  }

  var roomNormal    = normalHours * ROOM_BASE;
  var roomSurcharge = surchargeHours * (ROOM_BASE + SURCHARGE_AFTER17);
  var roomTotal     = roomNormal + roomSurcharge;

  if (roomTotal > 0) {
    var roomDesc = duration + 'h × ' + ROOM_BASE + '€';
    if (surchargeHours > 0 && normalHours > 0) {
      roomDesc = normalHours + 'h × ' + ROOM_BASE + '€ + ' + surchargeHours + 'h × ' + (ROOM_BASE + SURCHARGE_AFTER17) + '€';
    } else if (surchargeHours > 0) {
      roomDesc = surchargeHours + 'h × ' + (ROOM_BASE + SURCHARGE_AFTER17) + '€';
    }
    breakdown.push({ name: 'Room', amount: roomTotal, detail: roomDesc });
  }
  total += roomTotal;

  // Extra participants
  if (participants > 1 && duration > 0) {
    var extraCost = (participants - 1) * EXTRA_PERSON_RATE * duration;
    breakdown.push({
      name: 'Extra participants (' + (participants - 1) + ')',
      amount: extraCost,
      detail: (participants - 1) + ' × ' + EXTRA_PERSON_RATE + '€ × ' + duration + 'h'
    });
    total += extraCost;
  }

  // Sunday tariff
  if (isSunday && duration > 0) {
    breakdown.push({ name: 'Sunday opening fee', amount: SUNDAY_TARIFF, detail: '+' + SUNDAY_TARIFF + '€' });
    total += SUNDAY_TARIFF;
  }

  // Same-day booking
  if (isSameDay && duration > 0 && SAME_DAY_SURCHARGE > 0) {
    var sameDayTotal = SAME_DAY_SURCHARGE * duration;
    breakdown.push({
      name: 'Same-day booking',
      amount: sameDayTotal,
      detail: '+' + SAME_DAY_SURCHARGE + '€/h × ' + duration + 'h'
    });
    total += sameDayTotal;
  }

  // Instruments
  var instruments = data.instruments || {};
  for (var instrId in instruments) {
    var qty = Number(instruments[instrId]) || 0;
    if (qty > 0 && INSTRUMENT_PRICES[instrId]) {
      var price = INSTRUMENT_PRICES[instrId];
      var instrCost = qty * price;
      breakdown.push({
        name: instrId.replace(/_/g, ' '),
        amount: instrCost,
        detail: qty + ' × ' + price + '€'
      });
      total += instrCost;
    }
  }

  return { total: total, breakdown: breakdown };
}

// ---------------------------------------------------------------------------
// Stripe Checkout Session
// ---------------------------------------------------------------------------

function createCheckoutSession_(data, calc) {
  var secretKey = PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY');
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured in Script Properties');
  }

  // Build line items for Stripe
  var params = {
    'mode': 'payment',
    'success_url': SUCCESS_URL + '?session_id={CHECKOUT_SESSION_ID}',
    'cancel_url': CANCEL_URL,
    'customer_email': data.email,
    'metadata[booking_date]': data.date,
    'metadata[start_time]': data.start_time,
    'metadata[duration]': data.duration,
    'metadata[participants]': data.participants,
    'metadata[customer_name]': data.name,
    'metadata[customer_phone]': data.phone || '',
    'metadata[additional_requests]': (data.additional_requests || '').substring(0, 500)
  };

  // Add line items from breakdown
  for (var i = 0; i < calc.breakdown.length; i++) {
    var item = calc.breakdown[i];
    var prefix = 'line_items[' + i + ']';
    params[prefix + '[price_data][currency]'] = 'eur';
    params[prefix + '[price_data][product_data][name]'] = item.name;
    params[prefix + '[price_data][product_data][description]'] = item.detail;
    params[prefix + '[price_data][unit_amount]'] = Math.round(item.amount * 100); // cents
    params[prefix + '[quantity]'] = 1;
  }

  // Build URL-encoded body
  var bodyParts = [];
  for (var key in params) {
    bodyParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
  }

  var response = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'post',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(secretKey + ':')
    },
    payload: bodyParts.join('&'),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());

  if (response.getResponseCode() !== 200) {
    Logger.log('Stripe error: ' + JSON.stringify(result));
    throw new Error('Payment failed: ' + (result.error ? result.error.message : 'Unknown error'));
  }

  return result.url;
}

// ---------------------------------------------------------------------------
// Error page
// ---------------------------------------------------------------------------

function errorPage_(message) {
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head>' +
    '<style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa}' +
    '.error{text-align:center;max-width:400px;padding:32px}.icon{font-size:48px;margin-bottom:16px}' +
    'h2{color:#1a1a2e;margin-bottom:8px}p{color:#555}a{color:#1a1a2e;font-weight:600}</style></head>' +
    '<body><div class="error"><div class="icon">&#9888;</div>' +
    '<h2>Something went wrong</h2>' +
    '<p>' + message + '</p>' +
    '<p style="margin-top:24px"><a href="' + CANCEL_URL + '">Back to booking form</a></p>' +
    '</div></body></html>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
