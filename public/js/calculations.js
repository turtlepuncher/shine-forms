/**
 * Shine Forms — Calculation / Pricing Engine
 *
 * Evaluates pricing formulas defined in form JSON. Rates come from the live
 * control-panel API (overlaid onto calcDef in index.html); the legacy bundled
 * fields (room_base / surcharge_after_17 / sunday_tariff) are kept as a fallback
 * so the calculator still works if the API is unreachable.
 *
 * Pricing rule: base rate Mon-Fri before peak_start_hour and all Saturday; peak
 * rate Mon-Fri from peak_start_hour; Sundays AND public holidays use the peak
 * rate all day plus the opening fee, charged once. Extra participants per
 * person/hour, same-day surcharge per hour, equipment a flat per-booking add-on.
 */

const ShineCalc = (() => {

  /**
   * Evaluate a calculation definition.
   * @param {object} calcDef - the calculations object from form JSON / API overlay
   * @param {function} getVal - function(fieldId) => current value
   * @param {object} ctx - extra context (e.g., { is_sunday: true })
   * @returns {object} - { total, breakdown[] }
   */
  function evaluate(calcDef, getVal, ctx = {}) {
    if (!calcDef) return { total: 0, breakdown: [] };

    const breakdown = [];
    let total = 0;

    const duration = Number(getVal('duration')) || 0;
    const participants = Number(getVal('participants')) || 1;
    const startHour = parseInt(String(getVal('start_time')).replace('H', ''), 10) || 0;

    // Date context
    const dateVal = getVal('date');
    const isSaturday = ctx.is_saturday !== undefined ? ctx.is_saturday : _isSaturday(dateVal);
    const isSunday = ctx.is_sunday !== undefined ? ctx.is_sunday : _isSunday(dateVal);
    const isHoliday = ctx.is_holiday !== undefined ? ctx.is_holiday : _isHoliday(dateVal, calcDef.holidays);
    const isSameDay = ctx.is_same_day !== undefined ? ctx.is_same_day : _isToday(dateVal);
    const isPremium = isSunday || isHoliday;   // Sundays and public holidays

    // Rates: prefer the live-API fields, fall back to the legacy bundled ones.
    const baseRate = Number(calcDef.base_rate != null ? calcDef.base_rate : calcDef.room_base) || 0;
    const peakRate = Number(
      calcDef.peak_rate != null
        ? calcDef.peak_rate
        : (Number(calcDef.room_base) || 0) + (Number(calcDef.surcharge_after_17) || 0)
    ) || 0;
    const peakStartHour = Number(calcDef.peak_start_hour != null ? calcDef.peak_start_hour : 17);
    const saturdayIsPeak = !!calcDef.saturday_is_peak;
    const openingFee = Number(calcDef.opening_fee != null ? calcDef.opening_fee : calcDef.sunday_tariff) || 0;
    const sameDaySurcharge = Number(calcDef.same_day_surcharge) || 0;
    const extraPersonRate = Number(calcDef.extra_person_rate) || 0;
    // The "premium day = peak all day" rule is opt-in via the live-rates overlay
    // (premium_all_day_peak). The legacy bundled path keeps its original
    // behaviour (Sunday daytime at base), so any form NOT reading the rates API
    // is byte-for-byte unchanged.
    const premiumAllDayPeak = calcDef.premium_all_day_peak === true;

    // Per-hour base vs peak. With the overlay, Sundays + holidays are peak ALL
    // day; Saturday is base (unless configured peak); weekdays are peak from
    // peak_start_hour.
    const endHour = startHour + duration;
    let baseHours = 0;
    let peakHours = 0;
    for (let h = startHour; h < endHour; h++) {
      let peakHour;
      if (isPremium && premiumAllDayPeak) peakHour = true;
      else if (isSaturday) peakHour = saturdayIsPeak;
      else peakHour = h >= peakStartHour;
      if (peakHour) peakHours++; else baseHours++;
    }

    const roomTotal = baseHours * baseRate + peakHours * peakRate;
    if (roomTotal > 0) {
      let roomLabel = `${duration}h × ${baseRate}€`;
      if (peakHours > 0 && baseHours > 0) {
        roomLabel = `${baseHours}h × ${baseRate}€ + ${peakHours}h × ${peakRate}€`;
      } else if (peakHours > 0) {
        roomLabel = `${peakHours}h × ${peakRate}€`;
      }
      breakdown.push({ label: { en: 'Room', es: 'Sala' }, detail: roomLabel, amount: roomTotal });
    }
    total += roomTotal;

    // Extra participants
    if (participants > 1 && duration > 0) {
      const extraCost = (participants - 1) * extraPersonRate * duration;
      breakdown.push({
        label: { en: 'Extra participants', es: 'Participantes extra' },
        detail: `${participants - 1} × ${extraPersonRate}€ × ${duration}h`,
        amount: extraCost
      });
      total += extraCost;
    }

    // Opening fee: Sundays and public holidays, charged once.
    if (isPremium && duration > 0 && openingFee > 0) {
      breakdown.push({
        label: { en: 'Sunday / holiday opening', es: 'Apertura domingo / festivo' },
        detail: `+${openingFee}€`,
        amount: openingFee
      });
      total += openingFee;
    }

    // Same-day booking surcharge
    if (isSameDay && duration > 0 && sameDaySurcharge > 0) {
      const sameTotal = sameDaySurcharge * duration;
      breakdown.push({
        label: { en: 'Same-day booking', es: 'Reserva mismo día' },
        detail: `+${sameDaySurcharge}€/h × ${duration}h`,
        amount: sameTotal
      });
      total += sameTotal;
    }

    // Instrument / equipment rentals (flat per booking, qty x price)
    const instruments = calcDef.instruments || [];
    let instrTotal = 0;
    for (const instr of instruments) {
      const qty = Number(getVal(`instr_${instr.id}`)) || 0;
      if (qty > 0) {
        const price = instr.price != null ? instr.price : instr.price_per_hour;
        const cost = qty * price;
        breakdown.push({
          label: instr.name,
          detail: `${qty} × ${price}€`,
          amount: cost
        });
        instrTotal += cost;
      }
    }
    total += instrTotal;

    return { total, breakdown };
  }

  function _isSaturday(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d.getDay() === 6;
  }

  function _isSunday(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d.getDay() === 0;
  }

  function _isHoliday(dateStr, holidays) {
    if (!dateStr || !Array.isArray(holidays)) return false;
    return holidays.indexOf(dateStr) !== -1;
  }

  function _isToday(dateStr) {
    if (!dateStr) return false;
    const today = new Date();
    const d = new Date(dateStr);
    return d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth()
      && d.getDate() === today.getDate();
  }

  return { evaluate };
})();
