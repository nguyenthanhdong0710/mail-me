const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Canonical form of a mailbox address for the "report address is not monitored" check
 * (FR-021): lowercase, drop the `+tag`, and for Gmail ignore dots and the googlemail alias.
 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

export function sameMailbox(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}
