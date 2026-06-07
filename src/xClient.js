import { RetryableHttpError, retryAfterMs, withRetry } from './retry.js';

export class XClient {
  constructor({ accessToken, apiBaseUrl, logger }) {
    this.accessToken = accessToken;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.logger = logger;
    this.authenticatedUserId = null;
  }

  async request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }

    return withRetry(async () => {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'discord-x-dm-bridge/1.0'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableHttpError(`X API retryable status ${response.status}`, {
          status: response.status,
          retryAfterMs: retryAfterMs(response.headers)
        });
      }
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          error.responseText = text;
          error.status = response.status;
          throw error;
        }
      }
      if (!response.ok) {
        const error = new Error(`X API status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    }, { logger: this.logger });
  }

  async getAuthenticatedUserId() {
    if (this.authenticatedUserId) return this.authenticatedUserId;
    const payload = await this.request('/users/me', { query: { 'user.fields': 'id,username' } });
    this.authenticatedUserId = payload.data?.id ?? null;
    return this.authenticatedUserId;
  }

  async sendDm(conversationId, text) {
    const payload = await this.request(`/dm_conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: { text }
    });
    return { id: payload.data?.dm_event_id ?? payload.data?.id ?? payload.id, raw: payload };
  }

  async close() {
    // API client currently owns no persistent resources.
  }

  async listDmEvents(conversationId, { sinceId, maxResults = 50 } = {}) {
    const payload = await this.request(`/dm_conversations/${encodeURIComponent(conversationId)}/dm_events`, {
      query: {
        max_results: maxResults,
        since_id: sinceId,
        'dm_event.fields': 'id,text,created_at,sender_id,attachments'
      }
    });
    return payload.data ?? [];
  }
}
