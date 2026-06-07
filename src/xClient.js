import { RetryableHttpError, retryAfterMs, withRetry } from './retry.js';

export class XClient {
  constructor({ accessToken, apiBaseUrl, logger, seleniumClient, seleniumSendFallback = false, seleniumDmUrl }) {
    this.accessToken = accessToken;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.logger = logger;
    this.seleniumClient = seleniumClient;
    this.seleniumSendFallback = seleniumSendFallback;
    this.seleniumDmUrl = seleniumDmUrl;
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
    try {
      const payload = await this.request(`/dm_conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body: { text }
      });
      return { id: payload.data?.dm_event_id ?? payload.data?.id ?? payload.id, raw: payload };
    } catch (error) {
      if (!this.seleniumClient || !this.seleniumSendFallback) throw error;
      this.logger?.warn({ err: error }, 'X API send failed; falling back to Selenium web send');
      return this.seleniumClient.sendDm(conversationId, text, { dmUrl: this.seleniumDmUrl });
    }
  }

  async close() {
    await this.seleniumClient?.close?.();
  }

  async listDmEvents(conversationId, { sinceId, maxResults = 50 } = {}) {
    const payload = await this.request(`/dm_conversations/${encodeURIComponent(conversationId)}/dm_events`, {
      query: {
        max_results: maxResults,
        since_id: sinceId,
        'dm_event.fields': 'id,text,created_at,sender_id,attachments'
      }
    });
    const apiEvents = payload.data ?? [];
    if (!this.seleniumClient) return apiEvents;

    try {
      const seleniumEvents = await this.seleniumClient.listDmEvents(conversationId, {
        maxResults,
        dmUrl: this.seleniumDmUrl
      });
      return mergeDmEvents(apiEvents, seleniumEvents);
    } catch (error) {
      this.logger?.warn({ err: error }, 'failed to supplement X API DM events with Selenium');
      return apiEvents;
    }
  }
}

function eventId(event) {
  return event.id ?? event.dm_event_id;
}

function eventText(event) {
  return event.text ?? event.message_create?.message_data?.text ?? '';
}

function normalizeDedupeText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function textDedupeKey(event) {
  const text = normalizeDedupeText(eventText(event));
  return text ? `text:${text}` : null;
}

function mergeDmEvents(apiEvents, seleniumEvents) {
  const seenIds = new Set();
  const apiTextKeys = new Set();
  const merged = [];

  for (const event of apiEvents) {
    const id = eventId(event);
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    const textKey = textDedupeKey(event);
    if (textKey) apiTextKeys.add(textKey);
    merged.push(event);
  }

  for (const event of seleniumEvents) {
    const id = eventId(event);
    if (id && seenIds.has(id)) continue;
    const textKey = textDedupeKey(event);
    if (textKey && apiTextKeys.has(textKey)) continue;
    if (id) seenIds.add(id);
    merged.push(event);
  }

  return merged;
}
