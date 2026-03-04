/**
 * Shine Forms — Calculation / Pricing Engine
 *
 * Evaluates pricing formulas defined in form JSON.
 * Supports references to field values and basic arithmetic.
 */

const ShineCalc = (() => {

  /**
   * Evaluate a calculation definition.
   * @param {object} calcDef - the calculations object from form JSON
   * @param {function} getVal - function(fieldId) => current value
   * @param {object} ctx - extra context (e.g., { is_sunday: true })
   * @returns {object} - { total, breakdown[] }
   */
  function evaluate(calcDef, getVal, ctx = {}) {
    if (!calcDef) return { total: 0, breakdown: [] };

    const breakdown = [];
    let total = 0;

    // Get base values from form fields
    const duration = Number(getVal('duration')) || 0;
    const participants = Number(getVal('participants')) || 1;
    const startHour = parseInt(String(getVal('start_time')).replace('H', ''), 10) || 0;

    // Date context
    const dateVal = getVal('date');
    const isSunday = ctx.is_sunday !== undefined ? ctx.is_sunday : _isSunday(dateVal);

    // Room rate
    const baseRate = Number(calcDef.room_base) || 0;
    const surchargeAfter17 = Number(calcDef.surcharge_after_17) || 0;
    const sundayTariff = Number(calcDef.sunday_tariff) || 0;
    const extraPersonRate = Number(calcDef.extra_person_rate) || 0;

    // Calculate hours at normal rate vs surcharge rate
    const endHour = startHour + duration;
    let normalHours = 0;
    let surchargeHours = 0;

    for (let h = startHour; h < endHour; h++) {
      if (h >= 17) {
        surchargeHours++;
      } else {
        normalHours++;
      }
    }

    // Room cost
    const roomNormal = normalHours * baseRate;
    const roomSurcharge = surchargeHours * (baseRate + surchargeAfter17);
    const roomTotal = roomNormal + roomSurcharge;

    if (roomTotal > 0) {
      let roomLabel = `${duration}h × ${baseRate}€`;
      if (surchargeHours > 0 && normalHours > 0) {
        roomLabel = `${normalHours}h × ${baseRate}€ + ${surchargeHours}h × ${baseRate + surchargeAfter17}€`;
      } else if (surchargeHours > 0) {
        roomLabel = `${surchargeHours}h × ${baseRate + surchargeAfter17}€`;
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

    // Sunday tariff
    if (isSunday && duration > 0) {
      breakdown.push({
        label: { en: 'Sunday opening', es: 'Apertura domingo' },
        detail: `+${sundayTariff}€`,
        amount: sundayTariff
      });
      total += sundayTariff;
    }

    // Instrument rentals (from catalog items)
    const instruments = calcDef.instruments || [];
    let instrTotal = 0;
    for (const instr of instruments) {
      const qty = Number(getVal(`instr_${instr.id}`)) || 0;
      if (qty > 0) {
        const cost = qty * (instr.price || instr.price_per_hour);
        breakdown.push({
          label: instr.name,
          detail: `${qty} × ${instr.price || instr.price_per_hour}€`,
          amount: cost
        });
        instrTotal += cost;
      }
    }
    total += instrTotal;

    return { total, breakdown };
  }

  function _isSunday(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d.getDay() === 0;
  }

  return { evaluate };
})();
