/**
 * product-card.js
 * <product-card> custom element: an in-card variant picker for collection grids.
 *
 * Choosing an option swaps the image, price, compare-at price, "% OFF" badge,
 * product links and the variant id the Add to cart button submits, with no
 * network request: the card's variant data is embedded as JSON by Liquid.
 *
 * Without JavaScript the card is still a working form that posts to /cart/add.
 * With cart-api.js loaded, Add to cart stays on the page and the cart updates
 * through the shared `cart:updated` event.
 */
(function (root) {
  'use strict';

  /** The variant whose options match every selected value, or undefined. */
  function findVariant(variants, selected) {
    return variants.find(function (v) {
      return v.options.every(function (value, i) { return value === selected[i]; });
    });
  }

  /** Whole-number discount, rounded to nearest. Prices are integers in the smallest currency unit. */
  function percentOff(price, compareAt) {
    if (!compareAt || compareAt <= price) return 0;
    return Math.round(((compareAt - price) * 100) / compareAt);
  }

  /** Shopify money format, e.g. "Rs. {{amount}}" or "₹{{amount_no_decimals}}". */
  function formatMoney(cents, format) {
    var match = /\{\{\s*(\w+)\s*\}\}/.exec(format || '{{amount}}');
    var group = function (n, decimals, thousands, decimal) {
      var parts = (n / 100).toFixed(decimals).split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      return parts.join(decimal);
    };
    var value;
    switch (match ? match[1] : 'amount') {
      case 'amount_no_decimals': value = group(cents, 0, ',', '.'); break;
      case 'amount_with_comma_separator': value = group(cents, 2, '.', ','); break;
      case 'amount_no_decimals_with_comma_separator': value = group(cents, 0, '.', ','); break;
      case 'amount_with_apostrophe_separator': value = group(cents, 2, "'", '.'); break;
      default: value = group(cents, 2, ',', '.');
    }
    return (format || '{{amount}}').replace(/\{\{\s*\w+\s*\}\}/, value);
  }

  if (typeof HTMLElement !== 'undefined') {
    class ProductCard extends HTMLElement {
      connectedCallback() {
        if (this._wired) return;
        this._wired = true;
        var json = this.querySelector('script[data-variants]');
        this.variants = json ? JSON.parse(json.textContent) : [];
        this.form = this.querySelector('form[data-add]');
        if (!this.form || !this.variants.length) return;
        this.idInput = this.form.querySelector('input[name="id"]');
        this.button = this.form.querySelector('button[type="submit"]');
        this.status = this.querySelector('[data-status]');
        this.labels = {
          add: this.dataset.addLabel || 'Add to cart',
          soldOut: this.dataset.soldOut || 'Sold out',
          unavailable: this.dataset.unavailable || 'Unavailable',
          added: this.dataset.added || 'Added to cart'
        };

        var current = this.variants.find(function (v) { return String(v.id) === this.idInput.value; }, this) || this.variants[0];
        this.selected = current.options.slice();

        this.addEventListener('click', this.onChoose.bind(this));
        this.form.addEventListener('submit', this.onSubmit.bind(this));
      }

      onChoose(event) {
        var chip = event.target.closest('[data-option-index]');
        if (!chip || !this.contains(chip)) return;
        this.selected[Number(chip.dataset.optionIndex)] = chip.dataset.value;
        chip.closest('fieldset').querySelectorAll('[data-option-index]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === chip));
        });
        this.render(findVariant(this.variants, this.selected));
      }

      render(variant) {
        if (!variant) {
          this.button.disabled = true;
          this.button.textContent = this.labels.unavailable;
          return;
        }
        this.idInput.value = variant.id;

        var off = percentOff(variant.price, variant.compare_at_price);
        var format = this.dataset.moneyFormat;
        this.setText('[data-price]', formatMoney(variant.price, format));
        this.toggle('[data-compare]', off > 0, formatMoney(variant.compare_at_price || 0, format));
        this.toggle('[data-off]', off > 0, off + '% OFF');

        var img = this.querySelector('[data-image] img');
        if (img && variant.image) {
          img.src = variant.image.src;
          img.srcset = variant.image.srcset;
        }
        this.querySelectorAll('a[data-link]').forEach(function (a) { a.href = variant.url; });

        this.button.disabled = !variant.available;
        this.button.textContent = variant.available ? this.labels.add : this.labels.soldOut;
      }

      setText(selector, text) {
        var el = this.querySelector(selector);
        if (el) el.textContent = text;
      }

      toggle(selector, visible, text) {
        var el = this.querySelector(selector);
        if (!el) return;
        el.hidden = !visible;
        if (visible) el.textContent = text;
      }

      async onSubmit(event) {
        if (!root.CartAPI) return; // no cart-api.js: let the form post normally
        event.preventDefault();
        var button = this.button;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        this.say('');
        try {
          await root.CartAPI.add([{ id: Number(this.idInput.value), quantity: 1 }], { source: 'product-card' });
          this.say(this.labels.added);
        } catch (err) {
          this.say(err && err.message ? err.message : 'Could not add to cart. Please try again.');
        } finally {
          button.removeAttribute('aria-busy');
          button.disabled = false;
        }
      }

      say(text) {
        if (this.status) this.status.textContent = text;
      }
    }

    if (!customElements.get('product-card')) customElements.define('product-card', ProductCard);
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { findVariant: findVariant, percentOff: percentOff, formatMoney: formatMoney };
  }
})(typeof window !== 'undefined' ? window : globalThis);
