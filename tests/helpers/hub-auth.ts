export const HUB_TEST_ADMIN_TOKEN = "kulo-test-admin-token";

export function withHubTestAuth(url: string, token = HUB_TEST_ADMIN_TOKEN): string {
  const authenticated = new URL(url);
  authenticated.searchParams.set("token", token);
  return authenticated.toString();
}

export function fetchWithHubAuth(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): ReturnType<typeof globalThis.fetch> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${HUB_TEST_ADMIN_TOKEN}`);
  return globalThis.fetch(input, { ...init, headers });
}
