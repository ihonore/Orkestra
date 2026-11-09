/**
 * Reading an opt-out the way the team types it.
 *
 * Someone answers "ne m'écrivez plus" from an address, or asks on the phone
 * not to be called again. The team pastes whatever they have — an email, a
 * phone number in any format, a website — and it becomes a suppression that
 * every export honours from then on.
 */
import { domainOf, toE164, type Country } from '../automations/google-maps/normalize.js';

export type OptOutKind = 'email' | 'domain' | 'phone';

export interface OptOut {
  readonly kind: OptOutKind;
  /** Stored form: lowercase address, registrable domain, or E.164 phone. */
  readonly value: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,63}$/i;

/** What `input` is, normalised to the form exports compare against; null if unclear. */
export function parseOptOut(input: string, country: Country = 'US'): OptOut | null {
  const text = input.trim().replace(/^mailto:/i, '');
  if (text === '') return null;

  if (EMAIL_RE.test(text)) return { kind: 'email', value: text.toLowerCase() };

  // A phone is mostly digits; a website never is.
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 8 && /^[\d\s().+-]+$/.test(text)) {
    const e164 = toE164(text, country) ?? (text.startsWith('+') ? `+${digits}` : null);
    return e164 === null ? null : { kind: 'phone', value: e164 };
  }

  if (/\s/.test(text) || !text.includes('.')) return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const domain = domainOf(url)?.domain;
  return domain === undefined ? null : { kind: 'domain', value: domain };
}
