/**
 * The seam between the API client and the auth provider for an expired session. It lives in its
 * own module so the client can raise it and the provider can react without either importing the
 * other's internals (and so tests that stub the API client do not have to know about it).
 */
let handler: (() => void) | null = null;

export function setUnauthorizedHandler(next: (() => void) | null): void {
  handler = next;
}

export function notifyUnauthorized(): void {
  handler?.();
}
