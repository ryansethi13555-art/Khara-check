import type { Page } from 'playwright';

/**
 * Recognises the common "are you human?" walls. Khara Check never tries to get past one by
 * itself: it stops, and either hands the browser to a person or explains what to do.
 */
export interface Challenge {
  kind: string;
  evidence: string;
}

const FRAME_SIGNS: [RegExp, string][] = [
  [/challenges\.cloudflare\.com/i, 'Cloudflare Turnstile'],
  [/\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i, 'Google reCAPTCHA'],
  [/(^|\.)hcaptcha\.com\/captcha/i, 'hCaptcha'],
  [/geo\.captcha-delivery\.com|ct\.captcha-delivery\.com/i, 'DataDome'],
  [/arkoselabs\.com|funcaptcha\.com/i, 'Arkose Labs'],
];

const TITLE_SIGNS: [RegExp, string][] = [
  [/^just a moment\.\.\.$/i, 'Cloudflare check'],
  [/attention required!? \| cloudflare/i, 'Cloudflare block page'],
  [/^access denied$/i, 'Access denied page'],
  [/^(pardon our interruption|are you a robot\??|human verification)$/i, 'Bot check page'],
];

export async function detectChallenge(page: Page): Promise<Challenge | null> {
  for (const frame of page.frames()) {
    const url = frame.url();
    for (const [sign, kind] of FRAME_SIGNS) if (sign.test(url)) return { kind, evidence: `frame ${url}` };
  }
  let title = '';
  try {
    title = (await page.title()).trim();
  } catch {
    return null;
  }
  for (const [sign, kind] of TITLE_SIGNS) if (sign.test(title)) return { kind, evidence: `page title "${title}"` };
  return null;
}
