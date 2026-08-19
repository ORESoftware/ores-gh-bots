import { createGitHubAppJwt } from '../../core/src/crypto.mjs';

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

export class AppAuth {
  #tokenCache = new Map();
  #installationCache = new Map();

  constructor({ client, apps, logger }) {
    this.client = client;
    this.apps = apps;
    this.logger = logger;
  }

  credentials(role) {
    const credentials = this.apps[role];
    if (!credentials?.id || !credentials?.privateKey) throw new Error(`Missing GitHub App credentials for role: ${role}`);
    return credentials;
  }

  appJwt(role) {
    const credentials = this.credentials(role);
    return createGitHubAppJwt({ appId: credentials.id, privateKey: credentials.privateKey });
  }

  async installationIdForRepo(role, owner, repo, hintedInstallationId = null) {
    this.credentials(role);
    const hinted = hintedInstallationId ? positiveInteger(hintedInstallationId, 'hinted installation ID') : null;
    const key = `${role}:${owner}/${repo}`.toLowerCase();
    const cached = this.#installationCache.get(key);
    if (cached) {
      if (hinted !== null && hinted !== cached) {
        throw new Error(`Hinted installation ID ${hinted} does not match repository installation ${cached}`);
      }
      return cached;
    }

    const response = await this.client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
      token: this.appJwt(role),
    });
    const installationId = positiveInteger(response.data?.id, 'repository installation ID');
    if (hinted !== null && hinted !== installationId) {
      throw new Error(`Hinted installation ID ${hinted} does not match repository installation ${installationId}`);
    }
    this.#installationCache.set(key, installationId);
    return installationId;
  }

  async installationToken(role, installationId) {
    const credentials = this.credentials(role);
    const normalizedInstallationId = positiveInteger(installationId, 'installation ID');
    const key = `${credentials.id}:${normalizedInstallationId}`;
    const cached = this.#tokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > 120_000) return cached.token;

    const response = await this.client.request('POST', `/app/installations/${normalizedInstallationId}/access_tokens`, {
      token: this.appJwt(role),
    });
    const token = response.data?.token;
    const expiresAt = new Date(response.data?.expires_at).getTime();
    if (typeof token !== 'string' || token.length < 20 || !Number.isFinite(expiresAt)) {
      throw new Error(`GitHub did not return a valid installation token for role: ${role}`);
    }
    const value = { token, expiresAt };
    this.#tokenCache.set(key, value);
    this.logger?.debug('refreshed installation token', { role, installationId: normalizedInstallationId, expiresAt: response.data.expires_at });
    return value.token;
  }

  async repoToken(role, owner, repo, hintedInstallationId = null) {
    const installationId = await this.installationIdForRepo(role, owner, repo, hintedInstallationId);
    return {
      installationId,
      token: await this.installationToken(role, installationId),
    };
  }
}
