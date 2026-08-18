// Public build: authentication is intentionally local/no-op.
// Worker Agents does not ship credentials, OAuth client IDs, or token import logic.

export function getAuthStatus() {
  return { loggedIn: false, email: '', accountId: '', expiresAt: 0 };
}

export function createLoginUrl() {
  return '/';
}

export async function exchangeCodeForTokens() {
  throw new Error('OAuth login is not configured in this public build.');
}

export function logout() {
  return true;
}

export function importCodexAuthForHermes() {
  return false;
}

export async function refreshTokenIfNeeded() {
  return false;
}
