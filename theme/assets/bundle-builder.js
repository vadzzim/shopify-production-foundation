/*
 * bundle-builder
 *
 * Adds one product per routine step to the cart in a single request to
 * `/cart/add.js`, and links the resulting line items with a private
 * `_bundle_id` line item property so that a discount function and the sync
 * layer can recognise them as one bundle.
 *
 * The component reads `window.routes` when the theme provides it and falls
 * back to `window.Shopify.routes.root`, which every theme has. No cart URL is
 * hardcoded: a localised storefront serves the cart under a locale prefix.
 */
if (!customElements.get('bundle-builder')) {
  customElements.define(
    'bundle-builder',
    class BundleBuilder extends HTMLElement {
      connectedCallback() {
        this.strings = this.readStrings();
        this.steps = Array.from(this.querySelectorAll('[data-bundle-step]'));
        this.submitButton = this.querySelector('[data-bundle-submit]');
        this.submitLabel = this.querySelector('[data-bundle-submit-label]');
        this.message = this.querySelector('[data-bundle-message]');
        this.detail = this.querySelector('[data-bundle-detail]');
        this.cartLink = this.querySelector('[data-bundle-cart-link]');

        // A step whose products are all sold out renders a notice instead of
        // the button, because there is nothing to submit.
        if (!this.submitButton) return;

        this.idleLabel = this.submitLabel ? this.submitLabel.textContent : '';

        // The button ships disabled and is enabled here: without this script
        // the page must not offer a control that cannot do anything.
        this.submitButton.disabled = false;
        this.submitButton.addEventListener('click', this.onSubmit.bind(this));
        this.addEventListener('change', this.clearFeedback.bind(this));
      }

      async onSubmit() {
        const selection = this.steps.map((element) => ({
          element: element,
          input: element.querySelector('input[type="radio"]:checked'),
        }));

        const missing = selection.filter((step) => !step.input);
        if (missing.length > 0) {
          this.showError(this.strings.incomplete);
          const target = missing[0].element.querySelector('input[type="radio"]:not([disabled])');
          if (target) target.focus();
          return;
        }

        const bundleId = this.createBundleId();
        const items = selection.map((step) => ({
          id: Number(step.input.value),
          quantity: 1,
          properties: { _bundle_id: bundleId },
        }));

        this.setBusy(true);

        try {
          const response = await fetch(this.addUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              items: items,
              sections: 'cart-icon-bubble',
              sections_url: window.location.pathname,
            }),
          });

          const body = await response.json().catch(() => null);

          // A cart error arrives as HTTP 422 with a `status` field in the body,
          // not as a rejected promise.
          if (!response.ok || body === null || body.status) {
            await this.discardBundle(bundleId);
            await this.reportFailure(response.status, body, selection);
            return;
          }

          this.renderCartIcon(body.sections);
          this.publishCartUpdate(body);
          this.showSuccess();
        } catch (error) {
          this.showError(this.strings.network);
        } finally {
          this.setBusy(false);
        }
      }

      /*
       * A bundle that half lands is a broken cart: the customer pays for part
       * of a routine and the bundle discount does not apply. A multi-line
       * `/cart/add.js` call is not atomic — measured against this store, a line
       * asking for more than the available stock came back 422 while the other
       * line of the same request was added — so the theme enforces
       * all-or-nothing itself and removes every line item carrying this bundle
       * id after a failure. The bundle id is generated per click, so this can
       * never touch a line the customer added earlier.
       */
      async discardBundle(bundleId) {
        try {
          const cart = await fetch(`${this.cartUrl}.js`, {
            headers: { Accept: 'application/json' },
          }).then((response) => response.json());

          const updates = {};
          (cart.items || []).forEach((item) => {
            if (item.properties && item.properties._bundle_id === bundleId) {
              updates[item.key] = 0;
            }
          });

          if (Object.keys(updates).length === 0) return 0;

          await fetch(this.updateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ updates: updates }),
          });

          return Object.keys(updates).length;
        } catch (error) {
          return 0;
        }
      }

      // Bundled section rendering returns the cart count markup in the same
      // response, so the header stays truthful without a second round trip.
      renderCartIcon(sections) {
        const html = sections && sections['cart-icon-bubble'];
        const target = document.getElementById('cart-icon-bubble');
        if (!html || !target) return;

        const rendered = new DOMParser().parseFromString(html, 'text/html').querySelector('.shopify-section');
        if (rendered) target.innerHTML = rendered.innerHTML;
      }

      // Optional: when the theme ships a pub/sub, other cart components on the
      // page pick the change up. Guarded, because the section must also work in
      // a theme that has none.
      publishCartUpdate(cartData) {
        if (typeof publish !== 'function') return;
        if (typeof PUB_SUB_EVENTS === 'undefined' || !PUB_SUB_EVENTS.cartUpdate) return;

        publish(PUB_SUB_EVENTS.cartUpdate, { source: 'bundle-builder', cartData: cartData });
      }

      createBundleId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID();
        }

        // randomUUID needs a secure context, which a plain-http preview is not.
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      }

      readStrings() {
        const source = this.querySelector('[data-bundle-strings]');
        if (!source) return {};

        try {
          return JSON.parse(source.textContent);
        } catch (error) {
          return {};
        }
      }

      setBusy(busy) {
        this.submitButton.disabled = busy;
        this.submitButton.setAttribute('aria-busy', busy ? 'true' : 'false');

        if (this.submitLabel) {
          this.submitLabel.textContent = busy ? this.strings.adding || this.idleLabel : this.idleLabel;
        }
      }

      showSuccess() {
        this.setMessage(this.strings.success, 'success');
        this.setDetail('');
        if (this.cartLink) this.cartLink.hidden = false;
      }

      async reportFailure(httpStatus, body, selection) {
        const status = (body && body.status) || httpStatus;

        // Everything the cart refuses arrives as 422, including "Cannot find
        // variant", so the status alone does not say which case it is.
        const reason = status === 422 || status === 404 ? await this.classifyFailure(selection) : 'generic';

        this.showError(this.strings[reason] || this.strings.generic);

        // Shopify's own description names the product that failed, which the
        // translated sentence cannot. It is shown as a second line, not instead
        // of it.
        this.setDetail(body && body.description);
      }

      /*
       * Which of the three failures it was is decided by asking the source of
       * truth about the chosen variants, not by matching words in Shopify's
       * description: that sentence is written in the shop's language and is not
       * a contract. The product JSON says whether the variant still exists at
       * all (it was unpublished or deleted) or exists and is out of stock.
       */
      async classifyFailure(selection) {
        for (const step of selection) {
          const handle = step.input.dataset.productHandle;
          const variantId = Number(step.input.value);
          if (!handle) continue;

          try {
            const response = await fetch(`${this.root}products/${handle}.js`, {
              headers: { Accept: 'application/json' },
            });
            if (!response.ok) return 'variant_missing';

            const product = await response.json();
            const variant = (product.variants || []).find((candidate) => candidate.id === variantId);

            if (!variant) return 'variant_missing';
            if (!variant.available) return 'unavailable';
          } catch (error) {
            return 'generic';
          }
        }

        // Every chosen variant exists and is in stock, and the cart still
        // refused the line: what is left is stock already claimed by this
        // cart — Shopify's "You can't add more" and "Only N items were added"
        // family of errors.
        return 'stock_claimed';
      }

      showError(text) {
        this.setMessage(text || this.strings.generic, 'error');
        if (this.cartLink) this.cartLink.hidden = true;
      }

      clearFeedback() {
        this.setMessage('');
        this.setDetail('');
        if (this.cartLink) this.cartLink.hidden = true;
      }

      // The message element is a live region, so it keeps its place in the
      // layout with empty text instead of being toggled with `hidden`: a hidden
      // region is not announced when it comes back.
      setMessage(text, kind) {
        if (!this.message) return;

        this.message.textContent = text || '';
        this.message.classList.toggle('bundle-builder__message--error', kind === 'error');
        this.message.classList.toggle('bundle-builder__message--success', kind === 'success');
      }

      setDetail(text) {
        if (!this.detail) return;

        this.detail.textContent = text || '';
      }

      get root() {
        return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
      }

      get addUrl() {
        return (window.routes && window.routes.cart_add_url) || `${this.root}cart/add.js`;
      }

      get updateUrl() {
        return (window.routes && window.routes.cart_update_url) || `${this.root}cart/update.js`;
      }

      get cartUrl() {
        return (window.routes && window.routes.cart_url) || `${this.root}cart`;
      }
    }
  );
}
