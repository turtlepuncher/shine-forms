/**
 * Shine Forms — Main Renderer Engine
 *
 * Reads a JSON form definition and renders a beautiful, interactive form.
 * Coordinates i18n, conditions, calculations, and validation modules.
 */

class ShineForm {
  constructor(rootId, formDef) {
    this.root = document.getElementById(rootId);
    this.def = formDef;
    this.values = {};       // { fieldId: value }
    this.errors = {};       // { fieldId: errorKey }
    this.visible = {};      // { sectionId|fieldId: boolean }
    this.fieldEls = {};     // { fieldId: DOM element }
    this.sectionEls = {};   // { sectionId: DOM element }
    this._priceBarEl = null;
    this._priceAmountEl = null;
    this._priceDetailEl = null;
    this._breakdownEl = null;

    // Initialize default values from field definitions
    for (const section of (formDef.sections || [])) {
      for (const field of (section.fields || [])) {
        if (field.default !== undefined) {
          let val = field.default;
          if (val === 'today' && field.type === 'date') {
            val = new Date().toISOString().split('T')[0];
          } else if (val === true && field.type === 'checkbox') {
            val = 'yes';
          }
          this.values[field.id] = val;
        }
      }
    }

    // Listen for language changes
    ShineI18n.onChange(() => this.render());

    this.render();
  }

  /** Full re-render */
  render() {
    this.root.innerHTML = '';
    this.fieldEls = {};
    this.sectionEls = {};

    const form = document.createElement('div');
    form.className = 'sf-form';

    // Header
    form.appendChild(this._renderHeader());

    // Sections (before submit)
    const afterSubmit = [];
    for (const section of this.def.sections || []) {
      const el = this._renderSection(section);
      this.sectionEls[section.id] = el;
      if (section.position === 'after_submit') {
        afterSubmit.push(el);
      } else {
        form.appendChild(el);
      }
    }

    // Submit button
    form.appendChild(this._renderSubmit());

    // Sections (after submit)
    for (const el of afterSubmit) {
      form.appendChild(el);
    }

    this.root.appendChild(form);

    // Price bar (sticky bottom)
    if (this.def.calculations) {
      this._renderPriceBar();
    }

    // Initial evaluation
    this._evalConditions();
    this._evalCalculations();
  }

  // ─── Header ──────────────────────────────────────────────

  _renderHeader() {
    const hdr = document.createElement('div');
    hdr.className = 'sf-header';

    // Language toggle
    const toggle = document.createElement('div');
    toggle.className = 'sf-lang-toggle';
    ['ES', 'EN'].forEach(l => {
      const btn = document.createElement('button');
      btn.className = 'sf-lang-btn' + (ShineI18n.lang() === l.toLowerCase() ? ' active' : '');
      btn.textContent = l;
      btn.type = 'button';
      btn.addEventListener('click', () => ShineI18n.setLang(l.toLowerCase()));
      toggle.appendChild(btn);
    });
    hdr.appendChild(toggle);

    // Logo
    if (this.def.logo) {
      const logo = document.createElement('img');
      logo.className = 'sf-header__logo';
      logo.src = this.def.logo;
      logo.alt = 'Shine';
      hdr.appendChild(logo);
    }

    const title = document.createElement('h1');
    title.className = 'sf-header__title';
    title.textContent = ShineI18n.t(this.def.title);
    hdr.appendChild(title);

    if (this.def.subtitle) {
      const sub = document.createElement('p');
      sub.className = 'sf-header__subtitle';
      sub.textContent = ShineI18n.t(this.def.subtitle);
      hdr.appendChild(sub);
    }

    return hdr;
  }

  // ─── Sections ────────────────────────────────────────────

  _renderSection(section) {
    const el = document.createElement('div');
    el.className = 'sf-section';
    el.dataset.sectionId = section.id;

    if (section.title) {
      const title = document.createElement('h2');
      title.className = 'sf-section__title';
      title.textContent = ShineI18n.t(section.title);
      el.appendChild(title);
    }

    // Info box
    if (section.info) {
      const info = document.createElement('div');
      info.className = 'sf-info-box';
      info.innerHTML = ShineI18n.t(section.info);
      el.appendChild(info);
    }

    // Fields — optionally in a grid layout
    let fieldContainer = el;
    if (section.layout === 'grid-2col') {
      fieldContainer = document.createElement('div');
      fieldContainer.className = 'sf-grid-2col';
      el.appendChild(fieldContainer);
    }

    for (const field of section.fields || []) {
      const fieldEl = this._renderField(field);
      if (fieldEl) {
        this.fieldEls[field.id] = fieldEl;
        fieldContainer.appendChild(fieldEl);
      }
    }

    // Catalog items (instruments)
    if (section.catalog) {
      el.appendChild(this._renderCatalog(section.catalog));
    }

    return el;
  }

  // ─── Field Router ────────────────────────────────────────

  _renderField(field) {
    const wrap = document.createElement('div');
    wrap.className = 'sf-field';
    wrap.dataset.fieldId = field.id;

    // Label
    if (field.label && field.type !== 'checkbox') {
      const label = document.createElement('label');
      label.className = 'sf-label';
      label.textContent = ShineI18n.t(field.label);
      if (field.required) {
        const req = document.createElement('span');
        req.className = 'sf-label__required';
        req.textContent = ' *';
        label.appendChild(req);
      }
      wrap.appendChild(label);
    }

    // Description
    if (field.description) {
      const desc = document.createElement('p');
      desc.className = 'sf-description';
      desc.textContent = ShineI18n.t(field.description);
      wrap.appendChild(desc);
    }

    // Render by type
    switch (field.type) {
      case 'text':
      case 'email':
      case 'phone':
        wrap.appendChild(this._renderTextInput(field));
        break;
      case 'textarea':
        wrap.appendChild(this._renderTextarea(field));
        break;
      case 'number':
        wrap.appendChild(this._renderNumberInput(field));
        break;
      case 'date':
        wrap.appendChild(this._renderDateInput(field));
        break;
      case 'radio-pills':
        wrap.appendChild(this._renderPills(field));
        break;
      case 'radio':
        wrap.appendChild(this._renderRadioList(field));
        break;
      case 'dropdown':
        wrap.appendChild(this._renderDropdown(field));
        break;
      case 'checkbox':
        wrap.appendChild(this._renderCheckbox(field));
        break;
      case 'heading':
        return this._renderHeading(field);
      case 'info':
        return this._renderInfoBox(field);
      default:
        break;
    }

    // Error container
    const errEl = document.createElement('div');
    errEl.className = 'sf-error';
    errEl.style.display = 'none';
    errEl.dataset.errorFor = field.id;
    wrap.appendChild(errEl);

    return wrap;
  }

  // ─── Text Input ──────────────────────────────────────────

  _renderTextInput(field) {
    const input = document.createElement('input');
    input.type = field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text';
    input.className = 'sf-input';
    input.placeholder = ShineI18n.t(field.placeholder) || '';
    input.value = this.values[field.id] || '';
    input.addEventListener('input', (e) => {
      this.values[field.id] = e.target.value;
      this._clearError(field.id);
      this._evalConditions();
      this._evalCalculations();
    });
    return input;
  }

  _renderTextarea(field) {
    const ta = document.createElement('textarea');
    ta.className = 'sf-input';
    ta.placeholder = ShineI18n.t(field.placeholder) || '';
    ta.rows = field.rows || 3;
    ta.value = this.values[field.id] || '';
    ta.addEventListener('input', (e) => {
      this.values[field.id] = e.target.value;
      this._clearError(field.id);
    });
    return ta;
  }

  _renderNumberInput(field) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'sf-input';
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    input.value = this.values[field.id] || '';
    input.addEventListener('input', (e) => {
      this.values[field.id] = e.target.value;
      this._clearError(field.id);
      this._evalConditions();
      this._evalCalculations();
    });
    return input;
  }

  // ─── Date Input ──────────────────────────────────────────

  _renderDateInput(field) {
    const wrap = document.createElement('div');
    wrap.className = 'sf-date-input';
    const input = document.createElement('input');
    input.type = 'date';
    if (field.min_date === 'today') {
      input.min = new Date().toISOString().split('T')[0];
    }
    input.value = this.values[field.id] || '';
    input.addEventListener('change', (e) => {
      this.values[field.id] = e.target.value;
      this._clearError(field.id);
      this._evalConditions();
      this._evalCalculations();
    });
    wrap.appendChild(input);
    return wrap;
  }

  // ─── Radio Pills ─────────────────────────────────────────

  _renderPills(field) {
    const container = document.createElement('div');
    container.className = 'sf-pills';
    container.dataset.fieldId = field.id;

    const options = this._resolveOptions(field);
    const currentVal = this.values[field.id] || '';

    for (const opt of options) {
      const val = typeof opt === 'object' ? opt.value : opt;
      const label = typeof opt === 'object' ? ShineI18n.t(opt.label) : opt;

      const pill = document.createElement('label');
      pill.className = 'sf-pill' + (currentVal === String(val) ? ' selected' : '');

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `sf_${field.id}`;
      radio.value = val;
      radio.checked = currentVal === String(val);
      radio.addEventListener('change', () => {
        this.values[field.id] = String(val);
        this._clearError(field.id);
        // Update pill selection visuals
        container.querySelectorAll('.sf-pill').forEach(p => p.classList.remove('selected'));
        pill.classList.add('selected');
        this._evalConditions();
        this._evalCalculations();

        // If this field has dynamic dependents, re-render them
        this._updateDynamicFields(field.id);
      });

      pill.appendChild(radio);
      pill.appendChild(document.createTextNode(label));
      container.appendChild(pill);
    }

    return container;
  }

  // ─── Radio List (vertical) ───────────────────────────────

  _renderRadioList(field) {
    const container = document.createElement('div');
    container.className = 'sf-radio-list';

    const options = this._resolveOptions(field);
    const currentVal = this.values[field.id] || '';

    for (const opt of options) {
      const val = typeof opt === 'object' ? opt.value : opt;
      const label = typeof opt === 'object' ? ShineI18n.t(opt.label) : opt;

      const option = document.createElement('label');
      option.className = 'sf-radio-option' + (currentVal === String(val) ? ' selected' : '');

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `sf_${field.id}`;
      radio.value = val;
      radio.checked = currentVal === String(val);
      radio.style.marginRight = '8px';
      radio.addEventListener('change', () => {
        this.values[field.id] = String(val);
        this._clearError(field.id);
        container.querySelectorAll('.sf-radio-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        this._evalConditions();
        this._evalCalculations();
      });

      option.appendChild(radio);
      option.appendChild(document.createTextNode(label));
      container.appendChild(option);
    }

    return container;
  }

  // ─── Dropdown ────────────────────────────────────────────

  _renderDropdown(field) {
    const sel = document.createElement('select');
    sel.className = 'sf-select';
    const currentVal = this.values[field.id] || '';

    // Disabled until another field is filled
    const isDisabled = field.disabled_until && !this.values[field.disabled_until];
    sel.disabled = isDisabled;

    // Placeholder option
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = ShineI18n.t(field.placeholder) || '—';
    ph.disabled = true;
    ph.selected = !currentVal;
    sel.appendChild(ph);

    const options = this._resolveOptions(field);
    for (const opt of options) {
      const val = typeof opt === 'object' ? opt.value : opt;
      const label = typeof opt === 'object' ? ShineI18n.t(opt.label) : opt;
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      o.selected = currentVal === String(val);
      sel.appendChild(o);
    }

    sel.addEventListener('change', (e) => {
      this.values[field.id] = e.target.value;
      this._clearError(field.id);
      this._evalConditions();
      this._evalCalculations();
      this._updateDynamicFields(field.id);
    });

    return sel;
  }

  // ─── Checkbox ────────────────────────────────────────────

  _renderCheckbox(field) {
    const wrap = document.createElement('label');
    wrap.className = 'sf-checkbox-wrap';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'sf-checkbox';
    cb.checked = this.values[field.id] === 'yes' || this.values[field.id] === true;
    cb.addEventListener('change', (e) => {
      this.values[field.id] = e.target.checked ? 'yes' : '';
      this._clearError(field.id);
      this._evalConditions();
      this._evalCalculations();
    });

    const label = document.createElement('span');
    label.className = 'sf-checkbox-label';
    label.textContent = ShineI18n.t(field.label);

    wrap.appendChild(cb);
    wrap.appendChild(label);
    return wrap;
  }

  // ─── Heading (inline) ────────────────────────────────────

  _renderHeading(field) {
    const h = document.createElement('h3');
    h.className = 'sf-section__title';
    h.style.marginTop = 'var(--space-lg)';
    h.textContent = ShineI18n.t(field.label);
    return h;
  }

  // ─── Info Box ────────────────────────────────────────────

  _renderInfoBox(field) {
    const box = document.createElement('div');
    box.className = 'sf-info-box';
    box.innerHTML = ShineI18n.t(field.content);
    return box;
  }

  // ─── Instrument Catalog ──────────────────────────────────

  _renderCatalog(items) {
    const grid = document.createElement('div');
    grid.className = 'sf-catalog';

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'sf-catalog-item';
      card.dataset.instrId = item.id;

      // Image
      if (item.image) {
        const img = document.createElement('img');
        img.className = 'sf-catalog-item__img';
        img.src = item.image;
        img.alt = ShineI18n.t(item.name);
        img.loading = 'lazy';
        card.appendChild(img);
      }

      // Body
      const body = document.createElement('div');
      body.className = 'sf-catalog-item__body';

      const name = document.createElement('div');
      name.className = 'sf-catalog-item__name';
      name.textContent = ShineI18n.t(item.name);
      body.appendChild(name);

      const price = document.createElement('div');
      price.className = 'sf-catalog-item__price';
      price.textContent = `${item.price || item.price_per_hour}\u20AC`;
      body.appendChild(price);

      // Quantity stepper
      const qty = document.createElement('div');
      qty.className = 'sf-catalog-item__qty';

      const fieldId = `instr_${item.id}`;
      const currentQty = Number(this.values[fieldId]) || 0;

      const minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'sf-qty-btn';
      minusBtn.textContent = '\u2212';
      minusBtn.disabled = currentQty <= 0;

      const qtyDisplay = document.createElement('span');
      qtyDisplay.className = 'sf-qty-value';
      qtyDisplay.textContent = currentQty;

      const plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'sf-qty-btn';
      plusBtn.textContent = '+';
      plusBtn.disabled = currentQty >= (item.max_qty || 99);

      const updateQty = (delta) => {
        let val = (Number(this.values[fieldId]) || 0) + delta;
        val = Math.max(0, Math.min(val, item.max_qty || 99));
        this.values[fieldId] = val;
        qtyDisplay.textContent = val;
        minusBtn.disabled = val <= 0;
        plusBtn.disabled = val >= (item.max_qty || 99);
        card.classList.toggle('selected', val > 0);
        this._evalCalculations();
      };

      minusBtn.addEventListener('click', () => updateQty(-1));
      plusBtn.addEventListener('click', () => updateQty(1));

      qty.appendChild(minusBtn);
      qty.appendChild(qtyDisplay);
      qty.appendChild(plusBtn);
      body.appendChild(qty);

      card.appendChild(body);
      grid.appendChild(card);
    }

    return grid;
  }

  // ─── Price Bar (sticky bottom) ───────────────────────────

  _renderPriceBar() {
    // Remove existing bar
    const existing = document.querySelector('.sf-price-bar');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.className = 'sf-price-bar hidden';

    const left = document.createElement('div');

    const label = document.createElement('div');
    label.className = 'sf-price-bar__label';
    label.textContent = ShineI18n.t({ en: 'Total', es: 'Total' });
    left.appendChild(label);

    const detail = document.createElement('div');
    detail.className = 'sf-price-bar__detail';
    this._priceDetailEl = detail;
    left.appendChild(detail);

    bar.appendChild(left);

    const amount = document.createElement('div');
    amount.className = 'sf-price-bar__amount';
    amount.textContent = '0\u20AC';
    this._priceAmountEl = amount;
    bar.appendChild(amount);

    this._priceBarEl = bar;
    document.body.appendChild(bar);
  }

  // ─── Dynamic Options (e.g., duration based on start time) ─

  _resolveOptions(field) {
    if (field.options) {
      return Array.isArray(field.options) ? field.options : [field.options];
    }

    if (field.options_dynamic) {
      const dyn = field.options_dynamic;
      const sourceVal = this.values[dyn.source] || '';

      if (dyn.rule === 'duration_from_start') {
        const startHour = parseInt(String(sourceVal).replace('H', ''), 10);
        if (!startHour) return [];
        const maxHours = 21 - startHour;
        const opts = [];
        for (let i = 1; i <= maxHours; i++) {
          const label = i === 1
            ? ShineI18n.t({ en: '1 hour', es: '1 hora' })
            : ShineI18n.t({ en: `${i} hours`, es: `${i} horas` });
          opts.push({ value: String(i), label });
        }
        return opts;
      }
    }

    return [];
  }

  /** Re-render fields that depend on a changed source field */
  _updateDynamicFields(changedFieldId) {
    for (const section of this.def.sections || []) {
      for (const field of section.fields || []) {
        if (field.options_dynamic && field.options_dynamic.source === changedFieldId) {
          // Clear previous selection if options changed
          const oldVal = this.values[field.id];
          const newOpts = this._resolveOptions(field);
          const validVals = newOpts.map(o => typeof o === 'object' ? o.value : o);
          if (oldVal && !validVals.includes(oldVal)) {
            this.values[field.id] = '';
          }

          // Re-render this field's pills/options
          const el = this.fieldEls[field.id];
          if (el) {
            const oldContainer = el.querySelector('.sf-pills, .sf-radio-list, .sf-select');
            if (oldContainer) {
              let newContainer;
              if (field.type === 'radio-pills') newContainer = this._renderPills(field);
              else if (field.type === 'radio') newContainer = this._renderRadioList(field);
              else if (field.type === 'dropdown') newContainer = this._renderDropdown(field);
              if (newContainer) oldContainer.replaceWith(newContainer);
            }
          }

          this._evalCalculations();
        }
      }
    }
  }

  // ─── Conditions Evaluation ───────────────────────────────

  _evalConditions() {
    const getVal = (id) => this.values[id] || '';

    // Sections
    for (const section of this.def.sections || []) {
      if (section.show_if) {
        const vis = ShineConditions.evaluate(section.show_if, getVal);
        const el = this.sectionEls[section.id];
        if (el) {
          el.classList.toggle('hidden', !vis);
        }
      }

      // Fields within sections
      for (const field of section.fields || []) {
        if (field.show_if) {
          const vis = ShineConditions.evaluate(field.show_if, getVal);
          const el = this.fieldEls[field.id];
          if (el) {
            el.classList.toggle('hidden', !vis);
          }
        }
      }
    }
  }

  // ─── Calculations Evaluation ─────────────────────────────

  _evalCalculations() {
    if (!this.def.calculations) return;

    const getVal = (id) => this.values[id] || '';
    const result = ShineCalc.evaluate(this.def.calculations, getVal);

    // Update price bar
    if (this._priceBarEl) {
      const hasPrice = result.total > 0;
      this._priceBarEl.classList.toggle('hidden', !hasPrice);
      if (this._priceAmountEl) {
        this._priceAmountEl.textContent = `${result.total}\u20AC`;
      }
      if (this._priceDetailEl && result.breakdown.length > 0) {
        this._priceDetailEl.textContent = result.breakdown
          .map(b => `${ShineI18n.t(b.label)}: ${b.amount}\u20AC`)
          .join(' + ');
      }
    }

    // Store total for payment
    this.values['_total'] = result.total;
    this.values['_breakdown'] = result.breakdown;
  }

  // ─── Validation ──────────────────────────────────────────

  _validateAll() {
    let valid = true;
    this.errors = {};

    for (const section of this.def.sections || []) {
      // Skip hidden sections
      const secEl = this.sectionEls[section.id];
      if (secEl && secEl.classList.contains('hidden')) continue;

      for (const field of section.fields || []) {
        // Skip hidden fields
        const fEl = this.fieldEls[field.id];
        if (fEl && fEl.classList.contains('hidden')) continue;

        const err = ShineValidation.validateField(field, this.values[field.id]);
        if (err) {
          this.errors[field.id] = err;
          this._showError(field.id, err);
          valid = false;
        }
      }
    }

    return valid;
  }

  _showError(fieldId, errKey) {
    const el = this.root.querySelector(`[data-error-for="${fieldId}"]`);
    if (el) {
      el.style.display = 'flex';
      el.textContent = ShineI18n.t(ShineValidation.getMessage(errKey));
    }
    // Add error class to input
    const fieldEl = this.fieldEls[fieldId];
    if (fieldEl) {
      const input = fieldEl.querySelector('.sf-input, .sf-select, input[type="date"]');
      if (input) input.classList.add('error');
    }
  }

  _clearError(fieldId) {
    delete this.errors[fieldId];
    const el = this.root.querySelector(`[data-error-for="${fieldId}"]`);
    if (el) el.style.display = 'none';
    const fieldEl = this.fieldEls[fieldId];
    if (fieldEl) {
      const input = fieldEl.querySelector('.sf-input, .sf-select, input[type="date"]');
      if (input) input.classList.remove('error');
    }
  }

  // ─── Submit ──────────────────────────────────────────────

  _renderSubmit() {
    const wrap = document.createElement('div');
    wrap.style.marginTop = 'var(--space-lg)';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sf-submit';
    btn.textContent = ShineI18n.t(this.def.submit_label || { en: 'Submit', es: 'Enviar' });
    btn.addEventListener('click', () => this._handleSubmit());

    wrap.appendChild(btn);
    return wrap;
  }

  _handleSubmit() {
    if (!this._validateAll()) {
      // Scroll to first error
      const firstErr = this.root.querySelector('.sf-error[style*="flex"]');
      if (firstErr) {
        firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    // Collect submission data
    const data = {
      form_id: this.def.id,
      values: { ...this.values },
      total: this.values['_total'] || 0,
      breakdown: this.values['_breakdown'] || [],
      language: ShineI18n.lang(),
      submitted_at: new Date().toISOString(),
    };

    console.log('Form submission:', data);

    // TODO: Send to backend API / Stripe
    alert(ShineI18n.t({
      en: `Thank you! Total: ${data.total}\u20AC`,
      es: `\u00a1Gracias! Total: ${data.total}\u20AC`
    }));
  }
}
