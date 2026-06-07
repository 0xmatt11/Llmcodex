import { createHash } from 'node:crypto';
import { RetryableHttpError, retryAfterMs, sleep, withRetry } from './retry.js';

const WEBDRIVER_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const ENTER_KEY = '\uE007';

function syntheticId(prefix, parts) {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function joinWebDriverPath(baseUrl, path) {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function parseJsonObject(value, name) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new Error(`${name} must be a valid JSON object: ${error.message}`);
  }
}

const TRANSIENT_WEBDRIVER_ERRORS = new Set([
  'detached shadow root',
  'element click intercepted',
  'element not interactable',
  'javascript error',
  'no such element',
  'stale element reference',
  'timeout'
]);

function isTransientWebDriverError(error) {
  return Boolean(error?.isRetryable || TRANSIENT_WEBDRIVER_ERRORS.has(error?.webdriverError));
}

export class XApiClient {
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

  isValidEventId(value) {
    return typeof value === 'string' && /^\d+$/.test(value);
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

export class SeleniumXClient {
  constructor({ selenium, logger }) {
    this.config = selenium;
    this.logger = logger;
    this.sessionId = null;
    this.recentSentTextHashes = new Set();
  }

  capabilities() {
    const capabilities = {
      browserName: this.config.browserName,
      ...parseJsonObject(this.config.capabilitiesJson, 'X_SELENIUM_CAPABILITIES_JSON')
    };
    const args = [];
    if (this.config.headless) args.push('--headless=new');
    if (this.config.browserName === 'chrome') {
      args.push('--no-sandbox', '--disable-dev-shm-usage');
      if (this.config.profileDir) args.push(`--user-data-dir=${this.config.profileDir}`);
      const userChromeOptions = capabilities['goog:chromeOptions'] ?? {};
      capabilities['goog:chromeOptions'] = {
        ...userChromeOptions,
        args: [...args, ...(userChromeOptions.args ?? [])]
      };
    }
    if (this.config.browserName === 'firefox') {
      if (this.config.headless) args.splice(0, args.length, '-headless');
      if (this.config.profileDir) args.push('-profile', this.config.profileDir);
      const userFirefoxOptions = capabilities['moz:firefoxOptions'] ?? {};
      capabilities['moz:firefoxOptions'] = {
        ...userFirefoxOptions,
        args: [...args, ...(userFirefoxOptions.args ?? [])]
      };
    }
    return capabilities;
  }

  async webdriver(method, path, body) {
    return withRetry(async () => {
      const response = await fetch(joinWebDriverPath(this.config.remoteUrl, path), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          error.status = response.status;
          error.responseText = text;
          throw error;
        }
      }
      if (!response.ok || payload.value?.error) {
        const webdriverError = payload.value?.error;
        const error = new Error(payload.value?.message ?? `WebDriver status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        error.webdriverError = webdriverError;
        error.isRetryable = response.status >= 500 || TRANSIENT_WEBDRIVER_ERRORS.has(webdriverError);
        throw error;
      }
      return payload.value;
    }, {
      attempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 1000,
      logger: this.logger,
      isRetryable: isTransientWebDriverError
    });
  }

  async ensureSession() {
    if (this.sessionId) return;
    const value = await this.webdriver('POST', '/session', {
      capabilities: { alwaysMatch: this.capabilities() }
    });
    this.sessionId = value.sessionId;
    this.logger?.info({ browserName: this.config.browserName }, 'started Selenium WebDriver session for X DMs');
  }

  async session(method, path, body) {
    await this.ensureSession();
    return this.webdriver(method, `/session/${this.sessionId}${path}`, body);
  }

  async navigateToConversation(conversationId) {
    const url = this.config.dmUrl || `${this.config.baseUrl.replace(/\/$/, '')}/messages/${encodeURIComponent(conversationId)}`;
    await this.session('POST', '/url', { url });
  }

  async findElement(selector) {
    return this.session('POST', '/element', { using: 'css selector', value: selector });
  }

  async findElements(selector, rootElementId) {
    const path = rootElementId ? `/element/${rootElementId}/elements` : '/elements';
    return this.session('POST', path, { using: 'css selector', value: selector });
  }

  elementId(element) {
    return element?.[WEBDRIVER_ELEMENT_KEY] ?? element?.ELEMENT;
  }

  async waitForElement(selector) {
    const startedAt = Date.now();
    let lastError;
    let attempt = 0;
    while (Date.now() - startedAt <= this.config.waitTimeoutMs) {
      try {
        return await this.findElement(selector);
      } catch (error) {
        lastError = error;
        const delay = Math.min(100 * 2 ** attempt, 2000, Math.max(0, this.config.waitTimeoutMs - (Date.now() - startedAt)));
        attempt += 1;
        if (delay > 0) await sleep(delay);
      }
    }
    throw new Error(`Timed out waiting for selector "${selector}": ${lastError?.message ?? 'not found'}`);
  }

  async elementText(elementId) {
    return this.session('GET', `/element/${elementId}/text`);
  }

  async elementAttribute(elementId, attribute) {
    return this.session('GET', `/element/${elementId}/attribute/${encodeURIComponent(attribute)}`);
  }

  async click(elementId) {
    return this.session('POST', `/element/${elementId}/click`, {});
  }

  async sendKeys(elementId, text) {
    return this.session('POST', `/element/${elementId}/value`, { text });
  }

  async elementMatches(elementId, selector) {
    if (!selector) return false;
    return this.session('POST', '/execute/sync', {
      script: 'return arguments[0].matches(arguments[1]);',
      args: [{ [WEBDRIVER_ELEMENT_KEY]: elementId }, selector]
    });
  }

  async getFirstChildText(elementId, selector) {
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    for (const childSelector of selectors) {
      const children = await this.findElements(childSelector, elementId);
      const childId = this.elementId(children[0]);
      if (childId) return this.elementText(childId);
    }
    return '';
  }

  async getAttachmentUrls(elementId) {
    const links = await this.findElements(this.config.attachmentSelector, elementId);
    const urls = [];
    for (const link of links) {
      const href = await this.elementAttribute(this.elementId(link), 'href');
      if (href) urls.push(href);
    }
    return [...new Set(urls)].map((url) => ({ url }));
  }

  eventId({ rawId, text, index, senderText, ownMessage, attachmentUrls = [] }) {
    if (rawId) return rawId;
    return syntheticId('selenium-event', {
      text,
      index,
      sender: ownMessage ? this.config.selfUserId : senderText || 'unknown',
      attachments: attachmentUrls.map(({ url }) => url).filter(Boolean).sort()
    });
  }

  async getAuthenticatedUserId() {
    return this.config.selfUserId;
  }

  isValidEventId(value) {
    return typeof value === 'string' && value.length > 0;
  }

  async sendDm(conversationId, text) {
    await this.navigateToConversation(conversationId);
    const input = await this.waitForElement(this.config.messageInputSelector);
    const inputId = this.elementId(input);
    await this.click(inputId);
    await this.sendKeys(inputId, text);
    try {
      const sendButton = await this.waitForElement(this.config.sendButtonSelector);
      await this.click(this.elementId(sendButton));
    } catch (error) {
      this.logger?.warn({ err: error }, 'Selenium send button unavailable; trying Enter key');
      await this.sendKeys(inputId, ENTER_KEY);
    }
    const id = syntheticId('selenium-sent', { text, sentAt: Date.now() });
    this.recentSentTextHashes.add(syntheticId('text', { text }));
    return { id, raw: { mode: 'selenium' } };
  }

  async listDmEvents(conversationId, { sinceId, maxResults = 50 } = {}) {
    await this.navigateToConversation(conversationId);
    await this.waitForElement(this.config.eventSelector);
    const elements = await this.findElements(this.config.eventSelector);
    const domEvents = [];
    for (const [index, element] of elements.entries()) {
      const id = this.elementId(element);
      const text = (await this.getFirstChildText(id, this.config.messageTextSelector)) || await this.elementText(id);
      if (!text.trim()) continue;
      const rawId = await this.elementAttribute(id, this.config.eventIdAttribute);
      const ownMessage = await this.elementMatches(id, this.config.ownMessageSelector);
      const senderText = await this.getFirstChildText(id, this.config.senderSelector);
      const attachments = await this.getAttachmentUrls(id);
      const eventId = this.eventId({ rawId, text, index, senderText, ownMessage, attachmentUrls: attachments });
      domEvents.push({
        id: eventId,
        sender_id: ownMessage || this.recentSentTextHashes.has(syntheticId('text', { text })) ? this.config.selfUserId : `selenium-sender:${senderText || 'unknown'}`,
        sender: { username: senderText || 'X user' },
        text,
        attachments,
        created_at: new Date().toISOString()
      });
    }
    const newestFirst = domEvents.reverse();
    const sinceIndex = sinceId ? newestFirst.findIndex((event) => event.id === sinceId) : -1;
    const filtered = sinceIndex === -1 ? newestFirst : newestFirst.slice(0, sinceIndex);
    return filtered.slice(0, maxResults);
  }

  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    try {
      await this.webdriver('DELETE', `/session/${sessionId}`);
      this.logger?.debug?.({ sessionId }, 'closed Selenium WebDriver session');
    } catch (error) {
      this.logger?.warn?.({ err: error, sessionId }, 'failed to close Selenium WebDriver session gracefully');
    } finally {
      this.sessionId = null;
    }
  }
}

export function createXClient({ config, logger }) {
  if (config.x.mode === 'selenium') return new SeleniumXClient({ selenium: config.x.selenium, logger });
  return new XApiClient({ accessToken: config.x.accessToken, apiBaseUrl: config.x.apiBaseUrl, logger });
}

export { XApiClient as XClient };
