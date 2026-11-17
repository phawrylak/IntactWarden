/**
 * Stand-ins for the payment hosts of the Bitwarden profile, reached through the
 * CONNECT proxy (proxy.ts) like the GitHub mirror: nothing leaves the machine.
 *
 * - `js.stripe.com`: `/v3/` answers a script that sets STRIPE_MARKER when it runs (Stripe.js is
 *   served only from Stripe's servers and is not in the Bitwarden release; the profile declares it
 *   as an `unpinnable-script`).
 * - `www.paypal.com`: `/cgi-bin/webscr` takes the "Add credit → PayPal" form post (the vault's
 *   `payPalForm`: `method=post`, `target=_top`) and answers a page; the posted field names are
 *   recorded.
 * - `bitpay.com`: `/i/<id>` answers an invoice page ("Add credit → BitPay" opens it in a new tab
 *   with the vault's `launchUri`).
 */

import type {IncomingMessage, ServerResponse} from 'node:http';
import {pathOf, readBody, send, type Handler} from './http.ts';

/** The marker the stand-in Stripe.js sets on the page's global when it runs. */
export const STRIPE_MARKER = '__iwStripe';
export const STRIPE_JS = 'https://js.stripe.com/v3/';
export const PAYPAL_ACTION = 'https://www.paypal.com/cgi-bin/webscr';
export const BITPAY_INVOICE = 'https://bitpay.com/i/IwE2eInvoice1';

export const PAYMENT_HOSTS: readonly string[] = Object.freeze([
  'js.stripe.com',
  'www.paypal.com',
  'bitpay.com',
]);

export interface PaymentRequest {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  /** Field names of a form post (never their values). */
  readonly fields: readonly string[];
}

export interface PaymentHosts {
  readonly handler: Handler;
  readonly requests: PaymentRequest[];
}

export function startPaymentHosts(): PaymentHosts {
  const requests: PaymentRequest[] = [];
  const handler: Handler = async (req: IncomingMessage, res: ServerResponse) => {
    const host = String(req.headers.host ?? '')
      .replace(/:\d+$/, '')
      .toLowerCase();
    const method = req.method ?? 'GET';
    const path = pathOf(req);
    let fields: string[] = [];
    if (method === 'POST') {
      const body = new TextDecoder().decode(await readBody(req));
      fields = [...new URLSearchParams(body).keys()];
    }
    requests.push({host, method, path, fields});
    const html = (title: string): void =>
      send(
        res,
        200,
        {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
        `<!doctype html><title>${title}</title><p>${title}</p>`,
      );
    if (host === 'js.stripe.com' && path === '/v3/') {
      send(
        res,
        200,
        {'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store'},
        `self.${STRIPE_MARKER} = true;`,
      );
      return;
    }
    if (host === 'www.paypal.com' && path === '/cgi-bin/webscr' && method === 'POST') {
      html('PayPal checkout');
      return;
    }
    if (host === 'bitpay.com' && path.startsWith('/i/')) {
      html('BitPay invoice');
      return;
    }
    send(res, 404, {'content-type': 'text/plain'}, 'not found');
  };
  return {handler, requests};
}
