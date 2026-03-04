/**
 * Shine Forms — Conditional Visibility Engine
 *
 * Evaluates show_if rules on sections and fields.
 * Rules can reference other field values.
 */

const ShineConditions = (() => {

  /**
   * Evaluate a single condition.
   * @param {object} cond - { field, equals|not_equals|gt|lt|gte|lte|filled|empty, value }
   * @param {function} getVal - function(fieldId) => current value
   * @returns {boolean}
   */
  function evalCondition(cond, getVal) {
    if (!cond || !cond.field) return true;
    const val = getVal(cond.field);

    if ('equals' in cond) {
      return String(val).toLowerCase() === String(cond.equals).toLowerCase();
    }
    if ('not_equals' in cond) {
      return String(val).toLowerCase() !== String(cond.not_equals).toLowerCase();
    }
    if ('gt' in cond) return Number(val) > Number(cond.gt);
    if ('lt' in cond) return Number(val) < Number(cond.lt);
    if ('gte' in cond) return Number(val) >= Number(cond.gte);
    if ('lte' in cond) return Number(val) <= Number(cond.lte);
    if ('filled' in cond) return val !== '' && val !== null && val !== undefined;
    if ('empty' in cond) return val === '' || val === null || val === undefined;

    return true; // no recognized operator → visible
  }

  /**
   * Evaluate a show_if rule (single condition or array with all/any).
   * @param {object|array} rule
   * @param {function} getVal
   * @returns {boolean}
   */
  function evaluate(rule, getVal) {
    if (!rule) return true;

    // Single condition object
    if (rule.field) return evalCondition(rule, getVal);

    // { all: [...] } or { any: [...] }
    if (rule.all) return rule.all.every(c => evalCondition(c, getVal));
    if (rule.any) return rule.any.some(c => evalCondition(c, getVal));

    return true;
  }

  return { evaluate };
})();
