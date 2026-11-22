import { allParams, fieldHead, get, pickFields, type Decoder, inAddress } from './types.js';

const USER_DATA: Record<string, string> = {
  em: 'email address',
  ph: 'phone number',
  fn: 'first name',
  ln: 'last name',
  ge: 'gender',
  db: 'date of birth',
  ct: 'city',
  st: 'state',
  zp: 'postal code',
  country: 'country',
  external_id: 'the site\'s own ID for this customer',
};

/** Meta Pixel: https://www.facebook.com/tr/ with id, ev, dl, cd[...] and ud[...] parameters. */
export const metaPixel: Decoder = {
  id: 'meta-pixel',
  vendor: 'Meta',
  product: 'Meta Pixel',
  category: 'advertising',
  domains: ['facebook.com', 'facebook.net'],
  basis: 'vendor-documented',
  matches: (i) => i.host.endsWith('facebook.net') || /^\/tr\/?$/.test(i.path),
  decode(input) {
    if (input.host.endsWith('facebook.net')) {
      return { purpose: 'Loads the Meta Pixel code onto the page' };
    }
    const p = allParams(input);
    return {
      purpose: 'Reports an event on this page to Meta, for ad targeting and measurement',
      ...(get(p, 'ev') ? { eventName: get(p, 'ev')! } : {}),
      ...(get(p, 'id') ? { accountId: get(p, 'id')! } : {}),
      fields: pickFields(
        p,
        { dl: 'address of the page the customer is on', rl: 'address of the page they came from' },
        { 'cd[': 'detail of what the customer did', 'ud[': 'customer detail for "advanced matching"', 'udff[': 'customer detail read from a form field' },
      ),
      identifiers: pickFields(p, {
        fbp: 'Meta browser ID cookie (_fbp): lets Meta recognise this browser again',
        fbc: 'Meta click ID',
      }),
    };
  },
  meaning(field) {
    const { head, rest } = fieldHead(field);
    const cd = /^cd\[(.+)\]$/.exec(head);
    if (cd) {
      return cd[1] === 'search_string' ? 'the search text of a "Search" event' : `event detail "${cd[1]}"`;
    }
    const ud = /^ud(?:ff)?\[(.+)\]$/.exec(head);
    if (ud) return `the customer's ${USER_DATA[ud[1]!] ?? ud[1]}, sent for "advanced matching" so Meta can link the visit to a Facebook or Instagram account`;
    if (head === 'dl') return inAddress(rest);
    if (head === 'rl') return 'the address of the previous page, which contains it';
    return undefined;
  },
};
