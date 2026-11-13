# Shopify storefront patterns

Three drop-in pieces for an Online Store 2.0 theme, each solving a problem I hit on a live D2C skincare store:

| Pattern | Files | The problem it solves |
|---|---|---|
| **Cart API wrapper** | `assets/cart-api.js` | Many widgets share one cart. Requests race, Shopify returns 429s, and the UI drifts out of sync with the server. |
| **Pincode delivery estimate** | `sections/delivery-estimate.liquid`, `assets/delivery-estimate.js`, `assets/pincode-delivery.json` | Shoppers want a delivery time before they buy, and ops need to change the courier lists without a code deploy. |
| **In-card variant picker** | `snippets/product-card.liquid`, `assets/product-card.js`, `sections/variant-card-grid.liquid` | Shoppers had to open the product page just to choose a size, which meant one extra page load for every multi-variant product. |

These are written from scratch as standalone examples. They contain no code from any employer's repository.

---

## 1. Cart API wrapper

`window.CartAPI` with `get()`, `add(items)`, `change(key, quantity)` and `update(payload)`.

Design decisions:

- **`fetch` does not reject on HTTP errors.** A 429 or 500 resolves like a success, so every response is checked with `res.ok`, and Shopify's error message (e.g. *"All 3 of this item are in your cart."*) is surfaced to the shopper.
- **Timeouts on every request** (`AbortController`), so a hung request can't leave a button spinning forever.
- **Only reads are retried.** `GET /cart.js` retries 429 and 5xx responses with exponential backoff, jitter, and `Retry-After` when the server sends it. `POST /cart/add.js` is **never** retried: if it timed out, it may already have succeeded, and a retry would add the item twice.
- **Writes are queued.** Two widgets changing the cart at once run one after the other, and a failed write doesn't block the next one.
- **One event is the contract.** Every change dispatches `cart:updated` with the new cart in `event.detail`. Other widgets render from that payload instead of each refetching `/cart.js`. That refetching is what floods the API with 429s on busy pages.
- **Lines are changed by `key`, not variant id.** The same variant can appear twice (a paid unit and a free gift with different properties). Changing by variant id hits the first match.
- **Section Rendering API built in.** Pass `{ sections: ['cart-icon-bubble'] }` and the re-rendered HTML comes back in the same response, so there's no second round trip.

```js
await CartAPI.add([{ id: 44012345678901, quantity: 1 }], { sections: ['cart-icon-bubble'] });

document.addEventListener('cart:updated', (event) => {
  renderMiniCart(event.detail.cart);
});
```

## 2. Pincode delivery estimate

A product-page section. The shopper enters a pincode and gets one of four merchant-editable messages:

| Result | When |
|---|---|
| Fast | The pincode is in the `fast` list |
| Standard | The pincode is in the `standard` list |
| Other | It's a valid Indian pincode, but in neither list |
| Error | It isn't a valid pincode: not 6 digits, or starts with 0 or 9 (9xxxxx is the Army Postal Service) |

Design decisions:

- **The data loads on focus, not on page load.** The JSON is fetched the first time the shopper focuses the field, and one request is shared by every widget on the page.
- **It fails soft.** If the list can't load, the shopper sees the "other" estimate, not an error.
- **The last pincode is remembered** in `localStorage`, wrapped in try/catch because private mode can throw.
- **It's a custom element**, so it initialises itself after theme-editor re-renders and Section Rendering API swaps.
- **Input is accessible:** a real `<label>`, `inputmode="numeric"`, `autocomplete="postal-code"`, the result in a `role="status"` live region, and `aria-invalid` on bad input.

In production I generated the lists from the courier's delivery report merged with the India Post pincode directory. For ops to update it without a deploy, the next step is to read the list from a file uploaded in Shopify admin, set through a section setting. For live courier serviceability, use a small backend that calls the courier's API, so the API key never reaches the browser.

## 3. In-card variant picker

`{% render 'product-card', product: product %}` gives a card where choosing an option swaps the image, price, compare-at price, **% OFF** badge, links, and the variant the button adds. None of this makes a network request: the variant data is embedded as JSON by Liquid.

Design decisions:

- **Progressive enhancement.** Without JavaScript the card is a normal form that posts to `/cart/add`. With `cart-api.js` loaded, Add to cart stays on the page.
- **Liquid and JavaScript calculate % OFF identically**, rounding to nearest (`times: 100.0 | divided_by: … | round` and `Math.round`), so the badge never changes when the script loads. Integer division in Liquid would always round down: 33.9% would show as 33%.
- **Sold-out and impossible combinations** disable the button with a clear label instead of failing at the cart.
- **Images use `srcset`** at 300, 450 and 600 widths, swapped together with the variant.

`sections/variant-card-grid.liquid` is a demo section: choose a collection in the theme editor and every card gets its own picker.

---

## Try it in a development store

1. Create a free [Shopify Partner](https://www.shopify.com/partners) account and a development store.
2. Get a theme locally: `shopify theme init` (or pull an existing one with `shopify theme pull`).
3. Copy `assets/`, `sections/` and `snippets/` from this repo into the theme.
4. Run `shopify theme dev --store your-store.myshopify.com`.
5. In the theme editor:
   - add **Variant card grid** to any page and choose a collection;
   - add **Delivery estimate** to the product template.

## Tests

The pure logic is unit tested with Node's built-in test runner, with no dependencies to install:

```bash
npm test
```

The tests cover:

- **Pincode classification:** fast, standard, other and invalid, including Army Postal Service codes.
- **Variant matching.**
- **% OFF rounding.**
- **Money formats.**
- **Cart wrapper behaviour:**
  - retries a 429 and honours `Retry-After`;
  - doesn't retry a 404;
  - **never retries a failed add**;
  - queued writes run in order;
  - a failed write doesn't block the next one.

The Liquid passes `shopify theme check` with no offenses.

## License

MIT
