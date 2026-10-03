import { createGitHubAppJwt } from '../../core/src/crypto.mjs';

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
    const credentials = this.credentials(role);
    const orchestrator = this.credentials('orchestrator');
    if (hintedInstallationId && String(credentials.id) === String(orchestrator.id)) return Number(hintedInstallationId);

    const key = `${role}:${owner}/${repo}`.toLowerCase();
    const cached = this.#installationCache.get(key);
    if (cached) return cached;

    const response = await this.client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
      token: this.appJwt(role),
    });
    const installationId = Number(response.data.id);
    this.#installationCache.set(key, installationId);
    return installationId;
  }

  async installationToken(role, installationId) {
    const credentials = this.credentials(role);
    const key = `${credentials.id}:${installationId}`;
    const cached = this.#tokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > 120_000) return cached.token;

    const response = await this.client.request('POST', `/app/installations/${installationId}/access_tokens`, {
      token: this.appJwt(role),
    });
    const value = {
      token: response.data.token,
      expiresAt: new Date(response.data.expires_at).getTime(),
    };
    this.#tokenCache.set(key, value);
    this.logger?.debug('refreshed installation token', { role, installationId, expiresAt: response.data.expires_at });
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
