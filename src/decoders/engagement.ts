import { allParams, clip, fieldHead, get, jsonAt, unwrapJson, type Decoder, type DecodedCall } from './types.js';

type Fields = DecodedCall['fields'];

function flatten(value: unknown, prefix = '', out: Fields = [], meaning = 'event detail'): Fields {
  if (out.length > 30 || value === null || value === undefined) return out;
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as object)) flatten(v, prefix ? `${prefix}.${k}` : k, out, meaning);
  } else {
    out.push({ name: prefix, value: clip(String(value)), meaning });
  }
  return out;
}

/**
 * CleverTap web SDK. Events travel in a parameter or JSON field named "d":
 * JSON that is LZ-string compressed or base64-encoded.
 */
export const cleverTap: Decoder = {
  id: 'clevertap',
  vendor: 'CleverTap',
  product: 'CleverTap',
  category: 'customer-engagement',
  domains: ['clevertap-prod.com', 'wzrkt.com', 'clevertap.com'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the CleverTap code onto the page' };
    const wrapped = get(allParams(input), 'd') ?? (jsonAt(input.bodyJson, 'd') as string | undefined);
    const payload = unwrapJson(typeof wrapped === 'string' ? wrapped : undefined) as any;
    const event = Array.isArray(payload) ? payload[0] : payload;
    const account = get(input.query, 'id') ?? (jsonAt(input.bodyJson, 'id') as string | undefined);
    const fields: Fields = [];
    if (event?.evtData) flatten(event.evtData, 'evtData', fields);
    if (event?.profile) flatten(event.profile, 'profile', fields, 'customer profile detail');
    return {
      purpose:
        event?.type === 'profile'
          ? 'Sends customer profile details to CleverTap, used for marketing messages'
          : 'Reports what the customer did to CleverTap, used for marketing messages and customer profiles',
      ...(event?.evtName ? { eventName: String(event.evtName) } : {}),
      ...(account ? { accountId: String(account) } : {}),
      fields,
      identifiers: event?.g ? [{ name: 'g', value: String(event.g), meaning: 'CleverTap ID for this browser' }] : [],
    };
  },
  meaning(field) {
    const path = field.split(' › ').pop() ?? '';
    const evt = /evtData\.(.+)$/.exec(path);
    if (evt) return `the "${evt[1]}" detail of an event`;
    const profile = /profile\.(.+)$/.exec(path);
    if (profile) return `the "${profile[1]}" field of the customer profile`;
    return undefined;
  },
};

/** MoEngage web SDK: JSON reports with events listed under viewsInfo / EVENT_ACTION / EVENT_ATTRS. */
export const moEngage: Decoder = {
  id: 'moengage',
  vendor: 'MoEngage',
  product: 'MoEngage',
  category: 'customer-engagement',
  domains: ['moengage.com', 'moengage.in', 'moe.com'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the MoEngage code onto the page' };
    const body: any = input.bodyJson;
    const events: any[] = body?.viewsInfo ?? body?.body?.viewsInfo ?? body?.events ?? [];
    const names = events.map((e) => e?.EVENT_ACTION ?? e?.e ?? e?.name).filter(Boolean);
    const fields: Fields = [];
    for (const e of events.slice(0, 5)) flatten(e?.EVENT_ATTRS ?? e?.a ?? e?.attributes, 'EVENT_ATTRS', fields);
    const uid = body?.query_params?.unique_id ?? body?.identifiers?.moe_user_id ?? get(input.query, 'unique_id');
    const app = /\/report\/([^/?]+)/.exec(input.path)?.[1] ?? get(input.query, 'app_id');
    return {
      purpose: 'Reports what the customer did to MoEngage, used for marketing messages and customer profiles',
      ...(names.length ? { eventName: names.join(', ') } : {}),
      ...(app ? { accountId: app } : {}),
      fields,
      identifiers: uid ? [{ name: 'unique_id', value: String(uid), meaning: 'MoEngage ID for this browser or customer' }] : [],
    };
  },
  meaning(field) {
    const attr = /EVENT_ATTRS\.(.+)$/.exec(field) ?? /attributes\.(.+)$/.exec(field);
    if (attr) return `the "${attr[1]}" detail of an event`;
    if (/USER_ATTRIBUTE|user_attributes|\.u_em|\.u_mb/i.test(field)) return 'a customer profile field';
    return undefined;
  },
};

/** WebEngage: events posted to c.webengage.com (and regional hosts) with event_name and event_data. */
export const webEngage: Decoder = {
  id: 'webengage',
  vendor: 'WebEngage',
  product: 'WebEngage',
  category: 'customer-engagement',
  domains: ['webengage.com', 'webengage.co'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the WebEngage code onto the page' };
    const p = allParams(input);
    const body: any = input.bodyJson;
    const name = get(p, 'event_name') ?? body?.event_name ?? body?.eventName;
    const data = get(p, 'event_data') ?? body?.event_data ?? body?.eventData;
    const fields: Fields = [];
    try {
      flatten(typeof data === 'string' ? JSON.parse(data) : data, 'event_data', fields);
    } catch {
      /* not JSON */
    }
    const luid = get(p, 'luid') ?? body?.luid;
    return {
      purpose: 'Reports what the customer did to WebEngage, used for marketing messages and customer profiles',
      ...(name ? { eventName: String(name) } : {}),
      ...(get(p, 'licenseCode') ?? get(p, 'license_code') ? { accountId: (get(p, 'licenseCode') ?? get(p, 'license_code'))! } : {}),
      fields,
      identifiers: luid ? [{ name: 'luid', value: String(luid), meaning: 'WebEngage ID for this browser' }] : [],
    };
  },
  meaning(field) {
    const { head, rest } = fieldHead(field);
    if (head === 'event_data' || /event_data/.test(field)) return rest.length ? `the "${rest.join('.')}" detail of an event` : 'the details of an event';
    return undefined;
  },
};

/** Netcore Cloud (Smartech): activity posted to netcoresmartech.com hosts. */
export const netcore: Decoder = {
  id: 'netcore',
  vendor: 'Netcore Cloud',
  product: 'Netcore Smartech',
  category: 'customer-engagement',
  domains: ['netcoresmartech.com', 'netcore.co.in', 'netcorecloud.net'],
  basis: 'observed-shape',
  decode(input) {
    if (/\.js$/.test(input.path)) return { purpose: 'Loads the Netcore Smartech code onto the page' };
    const p = allParams(input);
    const body: any = input.bodyJson;
    const name = get(p, 'eventname') ?? get(p, 'activity_name') ?? body?.eventName ?? body?.activity_name;
    const fields: Fields = [];
    flatten(body?.payload ?? body?.activity_params, 'payload', fields);
    return {
      purpose: 'Reports what the customer did to Netcore, used for marketing messages and customer profiles',
      ...(name ? { eventName: String(name) } : {}),
      fields,
    };
  },
};
