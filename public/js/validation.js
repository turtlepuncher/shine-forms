/**
 * Shine Forms — Field Validation
 */

const ShineValidation = (() => {

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^[+]?[\d\s\-().]{7,20}$/;

  /**
   * Validate a single field.
   * @param {object} fieldDef - field definition from JSON
   * @param {*} value - current field value
   * @returns {string|null} - error message key, or null if valid
   */
  function validateField(fieldDef, value) {
    const strVal = String(value || '').trim();

    // Required check
    if (fieldDef.required && !strVal) {
      return 'required';
    }

    // Skip further checks if empty and not required
    if (!strVal) return null;

    // Type-specific validation
    if (fieldDef.type === 'email' && !EMAIL_RE.test(strVal)) {
      return 'invalid_email';
    }

    if (fieldDef.type === 'phone' && !PHONE_RE.test(strVal)) {
      return 'invalid_phone';
    }

    if (fieldDef.type === 'number') {
      const n = Number(strVal);
      if (isNaN(n)) return 'invalid_number';
      if (fieldDef.min !== undefined && n < fieldDef.min) return 'too_low';
      if (fieldDef.max !== undefined && n > fieldDef.max) return 'too_high';
    }

    return null;
  }

  /** Validation error messages (bilingual) */
  const MESSAGES = {
    required: { en: 'This field is required', es: 'Este campo es obligatorio' },
    invalid_email: { en: 'Please enter a valid email', es: 'Introduce un email v\u00e1lido' },
    invalid_phone: { en: 'Please enter a valid phone number', es: 'Introduce un n\u00famero de tel\u00e9fono v\u00e1lido' },
    invalid_number: { en: 'Please enter a valid number', es: 'Introduce un n\u00famero v\u00e1lido' },
    too_low: { en: 'Value is too low', es: 'El valor es demasiado bajo' },
    too_high: { en: 'Value is too high', es: 'El valor es demasiado alto' },
  };

  function getMessage(key) {
    return MESSAGES[key] || { en: key, es: key };
  }

  return { validateField, getMessage };
})();
