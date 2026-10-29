import type { AccountConfig } from "../config/load.js";
import { sameMailbox } from "../config/address.js";
import type { RawMessage } from "../domain/ports.js";
import type { IncomingEmail, MessageKey } from "../domain/types.js";
import type { CleanedEmail } from "./clean.js";
import { webLinkFor } from "./web-link.js";

/** Adds what only the account knows: the receiving address and the "Open original" link. */
export function toIncomingEmail(
  key: MessageKey,
  cleaned: CleanedEmail,
  account: Pick<AccountConfig, "email" | "webLink">,
  raw?: Pick<RawMessage, "webLink">,
): IncomingEmail {
  const addressedToYou = [...cleaned.to, ...cleaned.cc].some((r) =>
    sameMailbox(r.address, account.email),
  );
  return {
    ...key,
    ...cleaned,
    deliveredTo: account.email,
    addressedToYou,
    webLink: webLinkFor(account.webLink, {
      accountEmail: account.email,
      messageId: cleaned.messageId,
      providerLink: raw?.webLink,
    }),
  };
}
