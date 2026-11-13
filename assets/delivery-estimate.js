/**
 * delivery-estimate.js
 * <delivery-estimate> custom element for a pincode delivery checker.
 *
 * - The pincode list is a JSON file in the theme's assets. It is fetched only
 *   when the shopper focuses the field, so it costs nothing on page load.
 * - Four outcomes, each with merchant-editable text: fast, standard, other
 *   (a real pincode the courier sheet does not list) and error.
 * - If the list fails to load, the shopper gets the "other" estimate rather
 *   than an error: a vague estimate is better than a broken widget.
 * - Built as a custom element so it initialises itself on first load, after a
 *   theme-editor re-render, and after a Section Rendering API swap.
 */
(function (root) {
  'use strict';

  /* 6 digits; the first digit is the postal region 1-8. 9xxxxx is the Army Postal Service. */
  var VALID_PINCODE = /^[1-8][0-9]{5}$/;
  var STORAGE_KEY = 'delivery-estimate:pincode';

  /** Pure lookup, kept separate so it can be unit tested. Returns 'fast' | 'standard' | 'other' | 'error'. */
  function classify(raw, lists) {
    var pin = String(raw == null ? '' : raw).trim();
    if (!VALID_PINCODE.test(pin)) return 'error';
    if (lists.fast.has(pin)) return 'fast';
    if (lists.standard.has(pin)) return 'standard';
    return 'other';
  }

  function toLists(data) {
    return {
      fast: new Set((data.fast || []).map(String)),
      standard: new Set((data.standard || []).map(String))
    };
  }

  /* One shared request per data URL, however many widgets are on the page. Cleared on failure so a retry is possible. */
  var cache = {};
  function loadLists(src) {
    if (!cache[src]) {
      cache[src] = root.fetch(src)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(toLists)
        .catch(function (err) {
          delete cache[src];
          throw err;
        });
    }
    return cache[src];
  }

  function readSaved() {
    try { return root.localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function save(pin) {
    try { root.localStorage.setItem(STORAGE_KEY, pin); } catch (e) { /* private mode or storage disabled */ }
  }

  if (typeof HTMLElement !== 'undefined') {
    class DeliveryEstimate extends HTMLElement {
      connectedCallback() {
        if (this._wired) return;
        this._wired = true;
        this.form = this.querySelector('form');
        this.input = this.querySelector('input[name="pincode"]');
        this.result = this.querySelector('[data-result]');
        if (!this.form || !this.input || !this.result) return;

        this.input.addEventListener('focus', this.preload.bind(this), { once: true });
        this.input.addEventListener('input', this.sanitise.bind(this));
        this.form.addEventListener('submit', this.onSubmit.bind(this));

        var saved = readSaved();
        if (VALID_PINCODE.test(saved)) {
          this.input.value = saved;
          this.check();
        }
      }

      preload() {
        loadLists(this.dataset.src).catch(function () {});
      }

      sanitise() {
        var digits = this.input.value.replace(/\D/g, '').slice(0, 6);
        if (digits !== this.input.value) this.input.value = digits;
      }

      onSubmit(event) {
        event.preventDefault();
        this.check();
      }

      async check() {
        var pin = this.input.value.trim();
        if (classify(pin, { fast: new Set(), standard: new Set() }) === 'error') {
          this.show('error');
          this.input.setAttribute('aria-invalid', 'true');
          return;
        }
        this.input.removeAttribute('aria-invalid');
        this.show('loading');
        try {
          var lists = await loadLists(this.dataset.src);
          this.show(classify(pin, lists));
          save(pin);
        } catch (e) {
          this.show('other');
        }
      }

      show(state) {
        this.result.dataset.state = state;
        this.result.textContent = this.dataset[state] || '';
      }
    }

    if (!customElements.get('delivery-estimate')) {
      customElements.define('delivery-estimate', DeliveryEstimate);
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { classify: classify, toLists: toLists, VALID_PINCODE: VALID_PINCODE };
  }
})(typeof window !== 'undefined' ? window : globalThis);
