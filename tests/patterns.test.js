// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, toLists } = require('../assets/delivery-estimate.js');
const { findVariant, percentOff, formatMoney } = require('../assets/product-card.js');

/* ---------------- delivery estimate ---------------- */

const lists = toLists({ fast: [110001, 122002], standard: [400001] });

test('delivery: fast, standard and other pincodes', () => {
  assert.equal(classify('110001', lists), 'fast');
  assert.equal(classify(122002, lists), 'fast');
  assert.equal(classify('400001', lists), 'standard');
  assert.equal(classify('560001', lists), 'other');
});

test('delivery: invalid input is an error', () => {
  for (const bad of ['', '12345', '1234567', '012345', '999999', 'abcdef', null, undefined]) {
    assert.equal(classify(bad, lists), 'error', String(bad));
  }
});

test('delivery: Army Postal Service pincodes (9xxxxx) are never treated as deliverable', () => {
  assert.equal(classify('900001', toLists({ fast: [900001] })), 'error');
});

test('delivery: surrounding spaces are ignored', () => {
  assert.equal(classify(' 110001 ', lists), 'fast');
});

/* ---------------- product card ---------------- */

const variants = [
  { id: 1, options: ['50 ml', 'Original'], price: 59900, compare_at_price: 89900, available: true },
  { id: 2, options: ['100 ml', 'Original'], price: 99900, compare_at_price: null, available: true },
  { id: 3, options: ['100 ml', 'Travel'], price: 49900, compare_at_price: 49900, available: false }
];

test('card: finds the variant matching every selected option', () => {
  assert.equal(findVariant(variants, ['100 ml', 'Original']).id, 2);
  assert.equal(findVariant(variants, ['100 ml', 'Travel']).id, 3);
  assert.equal(findVariant(variants, ['50 ml', 'Travel']), undefined);
});

test('card: percent off rounds to nearest, and is 0 without a real discount', () => {
  assert.equal(percentOff(59900, 89900), 33); // 33.37
  assert.equal(percentOff(66900, 99900), 33); // 33.03
  assert.equal(percentOff(64900, 99900), 35); // 35.04
  assert.equal(percentOff(50000, 75000), 33); // 33.33
  assert.equal(percentOff(99900, null), 0);
  assert.equal(percentOff(49900, 49900), 0);
  assert.equal(percentOff(59900, 39900), 0);
});

test('card: money formats', () => {
  assert.equal(formatMoney(129900, 'Rs. {{amount}}'), 'Rs. 1,299.00');
  assert.equal(formatMoney(129900, '₹{{amount_no_decimals}}'), '₹1,299');
  assert.equal(formatMoney(123456789, '{{amount_with_comma_separator}} €'), '1.234.567,89 €');
  assert.equal(formatMoney(5000, '${{ amount }}'), '$50.00');
});

/* ---------------- cart api ---------------- */

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function loadCartApi(fetchImpl) {
  delete require.cache[require.resolve('../assets/cart-api.js')];
  globalThis.fetch = fetchImpl;
  globalThis.location = { pathname: '/collections/all' };
  globalThis.document = { dispatchEvent: () => {}, getElementById: () => null };
  return require('../assets/cart-api.js');
}

test('cart: GET /cart.js retries a 429, honouring Retry-After', async () => {
  let calls = 0;
  const { CartAPI } = loadCartApi(async () => {
    calls++;
    return calls < 3 ? response(429, { description: 'Too many requests' }, { 'Retry-After': '0' }) : response(200, { item_count: 2 });
  });
  const cart = await CartAPI.get();
  assert.equal(cart.item_count, 2);
  assert.equal(calls, 3);
});

test('cart: GET does not retry a 404', async () => {
  let calls = 0;
  const { CartAPI } = loadCartApi(async () => { calls++; return response(404, { message: 'Not found' }); });
  await assert.rejects(CartAPI.get(), { name: 'CartError', status: 404 });
  assert.equal(calls, 1);
});

test('cart: a failed add is NOT retried (it may have succeeded server-side) and surfaces Shopify\'s message', async () => {
  let posts = 0;
  const { CartAPI } = loadCartApi(async (url, opts) => {
    if (opts && opts.method === 'POST') {
      posts++;
      return response(422, { status: 422, message: 'Cart Error', description: 'All 3 of this item are in your cart.' });
    }
    return response(200, { item_count: 0 });
  });
  await assert.rejects(CartAPI.add([{ id: 1, quantity: 1 }]), { status: 422, message: 'All 3 of this item are in your cart.' });
  assert.equal(posts, 1);
});

test('cart: writes run one at a time, in order', async () => {
  const log = [];
  const { CartAPI } = loadCartApi(async (url, opts) => {
    if (opts && opts.method === 'POST') {
      const { id, quantity } = JSON.parse(opts.body);
      log.push('start ' + id);
      await new Promise((r) => setTimeout(r, id === 'a' ? 30 : 1));
      log.push('end ' + id);
      return response(200, { item_count: quantity });
    }
    return response(200, {});
  });
  await Promise.all([CartAPI.change('a', 1), CartAPI.change('b', 2)]);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b']);
});

test('cart: a failed write does not block the next one', async () => {
  let n = 0;
  const { CartAPI } = loadCartApi(async (url, opts) => {
    if (opts && opts.method === 'POST') {
      n++;
      return n === 1 ? response(500, { message: 'boom' }) : response(200, { item_count: 1 });
    }
    return response(200, {});
  });
  const first = CartAPI.change('a', 1);
  const second = CartAPI.change('b', 1);
  await assert.rejects(first);
  assert.equal((await second).item_count, 1);
});
