import type { Grant, GrantStore } from "../../src/domain/ports.js";

export const sampleGrant = (over: Partial<Grant> = {}): Grant => ({
  version: 1,
  provider: "google",
  purpose: "read",
  address: "student@university.edu",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  clientId: "client-1.apps.googleusercontent.com",
  refreshToken: "1//refresh-secret",
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  ...over,
});

/** In-memory grant store. */
export class MemoryGrants implements GrantStore {
  readonly files = new Map<string, Grant>();
  read(name: string): Grant | null {
    return this.files.get(name) ?? null;
  }
  write(name: string, grant: Grant): void {
    this.files.set(name, grant);
  }
}
