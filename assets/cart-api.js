/**
 * cart-api.js
 * A small, dependency-free wrapper around Shopify's Cart AJAX API.
 *
 * Each rule below exists because breaking it causes a real class of bug on a
 * busy storefront where several widgets (gift-with-purchase, bundles, upsells,
 * quantity selectors, apps) all touch the same cart:
 *
 * 1. fetch() resolves on HTTP errors, so every response is checked with res.ok.
 *    A 429 or 500 is not an exception unless we make it one.
 * 2. Every request has a timeout, so a hung request cannot leave a button
 *    spinning forever.
 * 3. Only idempotent reads (GET /cart.js) are retried. A POST that timed out
 *    may already have succeeded on the server, and retrying it would add the
 *    item twice.
 * 4. Retries honour Retry-After and add jitter, so widgets that all hit a 429
 *    at the same moment do not retry in lockstep and hit it again.
 * 5. Cart writes run one at a time through a queue, so two widgets cannot race
 *    and leave the UI showing a cart that no longer exists.
 * 6. One event is the contract: every change dispatches `cart:updated` with the
 *    new cart in event.detail. Listeners render from that payload instead of
 *    each refetching /cart.js (which is what floods the API with 429s).
 *
 * Usage:
 *   await CartAPI.add([{ id: 123456789, quantity: 1 }], { sections: ['cart-icon-bubble'] });
 *   await CartAPI.change(lineItemKey, 0);
 *   document.addEventListener('cart:updated', (e) => render(e.detail.cart));
 */
(function (root) {
  'use strict';

  var TIMEOUT_MS = 10000;

  class CartError extends Error {
    constructor(message, status, body) {
      super(message);
      this.name = 'CartError';
      this.status = status;
      this.body = body;
    }
  }

  function routesRoot() {
    var s = root.Shopify;
    return (s && s.routes && s.routes.root) || '/';
  }

  function fetchWithTimeout(url, options, ms) {
    options = options || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms || TIMEOUT_MS);
    if (options.signal) {
      options.signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
    }
    return root.fetch(url, Object.assign({}, options, { signal: controller.signal }))
      .finally(function () { clearTimeout(timer); });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** Delay before retry `attempt` (0-based): Retry-After if the server sent it, else exponential backoff with jitter. */
  function retryDelay(res, attempt, baseMs) {
    var header = res && res.headers && res.headers.get('Retry-After');
    var seconds = header ? Number(header) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    var exp = baseMs * Math.pow(2, attempt);
    return exp / 2 + Math.random() * (exp / 2);
  }

  function isRetryable(status) {
    return status === 429 || status >= 500;
  }

  /** Shopify error bodies are JSON ({ status, message, description }); proxies sometimes return HTML. */
  async function readBody(res) {
    var text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (e) { return { description: text.slice(0, 200) }; }
  }

  function errorFrom(res, body) {
    return new CartError(body.description || body.message || 'HTTP ' + res.status, res.status, body);
  }

  /** GET with timeout and retry. Safe to retry because reading the cart changes nothing. */
  async function getJson(url, opts) {
    opts = opts || {};
    var attempts = opts.attempts || 4;
    var baseMs = opts.baseMs || 400;
    var lastError;
    for (var attempt = 0; attempt < attempts; attempt++) {
      var res = null;
      try {
        res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
        if (res.ok) return await res.json();
        lastError = errorFrom(res, await readBody(res));
        if (!isRetryable(res.status)) throw lastError; // a 404 will not fix itself
      } catch (err) {
        if (err instanceof CartError && !isRetryable(err.status)) throw err;
        lastError = err; // network failure, timeout, or a retryable status
      }
      if (attempt < attempts - 1) await sleep(retryDelay(res, attempt, baseMs));
    }
    throw lastError;
  }

  /** POST with a timeout but no retry: the write may have landed even if we never saw the response. */
  async function postJson(path, payload) {
    var res = await fetchWithTimeout(routesRoot() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    var body = await readBody(res);
    if (!res.ok) throw errorFrom(res, body);
    return body;
  }

  /* One cart write at a time. A failed write must not block the ones behind it. */
  var tail = Promise.resolve();
  function enqueue(task) {
    var run = tail.then(task);
    tail = run.catch(function () {});
    return run;
  }

  /** Ask Shopify to re-render these sections in the same response (Section Rendering API, max 5). */
  function withSections(payload, sections) {
    if (sections && sections.length) {
      payload.sections = sections.slice(0, 5).join(',');
      payload.sections_url = root.location.pathname;
    }
    return payload;
  }

  /** Replace each returned section's wrapper on the page. Sections Shopify could not render come back as null. */
  function swapSections(sections) {
    if (!sections) return;
    Object.keys(sections).forEach(function (id) {
      var html = sections[id];
      if (typeof html !== 'string') return;
      var current = document.getElementById('shopify-section-' + id);
      if (!current) return;
      var fresh = new DOMParser().parseFromString(html, 'text/html').getElementById('shopify-section-' + id);
      if (fresh) current.replaceWith(fresh);
    });
  }

  function announce(cart, source) {
    document.dispatchEvent(new CustomEvent('cart:updated', { detail: { cart: cart, source: source } }));
    return cart;
  }

  var CartAPI = {
    CartError: CartError,

    /** Current cart, retried on 429/5xx. */
    get: function () {
      return getJson(routesRoot() + 'cart.js');
    },

    /**
     * Add line items: [{ id: variantId, quantity, properties }].
     * The id is the VARIANT id, not the product id.
     * Rejects with CartError (status 422 + a readable description) when stock runs out.
     */
    add: function (items, opts) {
      opts = opts || {};
      return enqueue(async function () {
        var added = await postJson('cart/add.js', withSections({ items: items }, opts.sections));
        swapSections(added.sections);
        // /cart/add.js returns only the added lines, so read the whole cart once.
        var cart = await CartAPI.get();
        return announce(cart, opts.source || 'add');
      });
    },

    /**
     * Set one line's quantity. Use the line item KEY: a variant id matches the first
     * line with that variant, which is the wrong line when the same variant appears
     * twice (for example a paid unit and a free gift unit with different properties).
     */
    change: function (key, quantity, opts) {
      opts = opts || {};
      return enqueue(async function () {
        var cart = await postJson('cart/change.js', withSections({ id: key, quantity: quantity }, opts.sections));
        swapSections(cart.sections);
        delete cart.sections;
        return announce(cart, opts.source || 'change');
      });
    },

    /** Bulk quantities by key, plus cart attributes and note. */
    update: function (payload, opts) {
      opts = opts || {};
      return enqueue(async function () {
        var cart = await postJson('cart/update.js', withSections(Object.assign({}, payload), opts.sections));
        swapSections(cart.sections);
        delete cart.sections;
        return announce(cart, opts.source || 'update');
      });
    }
  };

  root.CartAPI = Object.freeze(CartAPI);

  if (typeof module === 'object' && module.exports) {
    module.exports = { CartAPI: CartAPI, CartError: CartError, retryDelay: retryDelay, getJson: getJson };
  }
})(typeof window !== 'undefined' ? window : globalThis);
