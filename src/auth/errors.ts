/** A Microsoft 365 organization requires an administrator to approve the app. */
export class AdminConsentRequiredError extends Error {
  override name = "AdminConsentRequiredError";
  constructor(readonly clientId: string) {
    super(
      `Your organization requires an administrator to approve this app. Send them the app (client) ID ${clientId}; see README "Microsoft 365 admin approval".`,
    );
  }
}

/** The user cancelled, denied consent, or the code expired. */
export class SignInCancelledError extends Error {
  override name = "SignInCancelledError";
  constructor(detail?: string) {
    super(`Sign-in was cancelled or timed out.${detail ? ` (${detail})` : ""}`);
  }
}
