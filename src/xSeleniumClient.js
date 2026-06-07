import { createHash } from 'node:crypto';

const DEFAULT_SELECTORS = {
  message: '[data-testid="cellInnerDiv"], [data-testid="messageEntry"], [data-testid="DMDrawerMessage"]',
  messageText: '[data-testid="tweetText"], [dir="auto"]',
  composer: '[data-testid="dmComposerTextInput"], [role="textbox"]',
  sendButton: '[data-testid="dmComposerSendButton"], [data-testid="sendDMFromMessageEntry"]',
  outgoingMessage: '[data-testid*="outgoing" i], [data-testid*="sent-by-you" i], [aria-label*="You sent" i], [aria-label*="sent by you" i]',
  incomingMessage: '[data-testid*="incoming" i], [data-testid*="received" i], [aria-label*="received" i]'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableSeleniumEventId({ conversationId, text, index }) {
  return `selenium-${createHash('sha256').update(`${conversationId}:${index}:${text}`).digest('hex').slice(0, 24)}`;
}

function normalizeRemoteUrl(remoteUrl) {
  return remoteUrl.replace(/\/$/, '');
}

export class SeleniumXClient {
  constructor({ remoteUrl, browserName = 'chrome', headless = true, timeoutMs = 10000, logger, selectors = DEFAULT_SELECTORS } = {}) {
    this.remoteUrl = normalizeRemoteUrl(remoteUrl ?? 'http://localhost:4444');
    this.browserName = browserName;
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.selectors = selectors;
    this.sessionId = null;
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.remoteUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.value?.error) {
      const error = new Error(payload.value?.message ?? `Selenium status ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload.value ?? payload;
  }

  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    const browserOptions = this.headless ? { args: ['--headless=new', '--disable-gpu', '--no-sandbox'] } : {};
    const capabilities = {
      browserName: this.browserName,
      ...(this.browserName === 'chrome' ? { 'goog:chromeOptions': browserOptions } : {}),
      ...(this.browserName === 'firefox' && this.headless ? { 'moz:firefoxOptions': { args: ['-headless'] } } : {})
    };
    const payload = await this.request('/session', {
      method: 'POST',
      body: { capabilities: { alwaysMatch: capabilities } }
    });
    this.sessionId = payload.sessionId;
    return this.sessionId;
  }

  async command(path, options) {
    const sessionId = await this.ensureSession();
    return this.request(`/session/${sessionId}${path}`, options);
  }

  async navigate(url) {
    await this.command('/url', { method: 'POST', body: { url } });
  }

  async findElements(selector) {
    return this.command('/elements', {
      method: 'POST',
      body: { using: 'css selector', value: selector }
    });
  }

  async findElement(selector) {
    return this.command('/element', {
      method: 'POST',
      body: { using: 'css selector', value: selector }
    });
  }

  async getElementText(element) {
    return this.command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/text`);
  }

  async clickElement(element) {
    return this.command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, { method: 'POST', body: {} });
  }

  async sendKeys(element, text) {
    return this.command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, {
      method: 'POST',
      body: { text, value: [...text] }
    });
  }

  async executeScript(script, args = []) {
    return this.command('/execute/sync', {
      method: 'POST',
      body: { script, args }
    });
  }

  async describeMessageElement(element) {
    return this.executeScript(`
      const element = arguments[0];
      const outgoingSelector = arguments[1];
      const incomingSelector = arguments[2];
      const safeMatches = (selector) => {
        if (!selector) return false;
        try {
          return Boolean(element.matches(selector) || element.closest(selector) || element.querySelector(selector));
        } catch {
          return false;
        }
      };
      const labels = [element.getAttribute('aria-label'), ...Array.from(element.querySelectorAll('[aria-label]')).map((node) => node.getAttribute('aria-label'))]
        .filter(Boolean)
        .join(' ');
      const markerText = labels + ' ' + (element.getAttribute('data-testid') || '');
      const outgoingByMarker = /\b(you sent|sent by you|outgoing)\b/i.test(markerText);
      const incomingByMarker = /\b(received|incoming)\b/i.test(markerText);
      return {
        text: (element.innerText || element.textContent || '').trim(),
        outgoing: safeMatches(outgoingSelector) || outgoingByMarker,
        incoming: safeMatches(incomingSelector) || incomingByMarker
      };
    `, [element, this.selectors.outgoingMessage, this.selectors.incomingMessage]);
  }

  async waitForElements(selector) {
    const deadline = Date.now() + this.timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const elements = await this.findElements(selector);
        if (elements.length > 0) return elements;
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    if (lastError) throw lastError;
    return [];
  }

  dmUrl(conversationId) {
    return `https://x.com/messages/${encodeURIComponent(conversationId)}`;
  }

  async listDmEvents(conversationId, { maxResults = 20, dmUrl } = {}) {
    await this.navigate(dmUrl ?? this.dmUrl(conversationId));
    const elements = await this.waitForElements(this.selectors.message);
    const messages = [];
    for (const element of elements.slice(-maxResults)) {
      let description;
      try {
        description = await this.describeMessageElement(element);
      } catch (error) {
        this.logger?.debug?.({ err: error }, 'failed to inspect Selenium DM message element; falling back to text extraction');
        description = { text: (await this.getElementText(element)).trim(), outgoing: false };
      }
      if (description.outgoing && !description.incoming) continue;
      const text = description.text.trim();
      if (text) messages.push({ text });
    }
    return messages.map(({ text }, index) => ({
      id: stableSeleniumEventId({ conversationId, text, index }),
      sender_id: undefined,
      sender: { username: 'X web' },
      text,
      attachments: [],
      created_at: new Date().toISOString(),
      source: 'selenium'
    }));
  }

  async sendDm(conversationId, text, { dmUrl } = {}) {
    await this.navigate(dmUrl ?? this.dmUrl(conversationId));
    const composer = await this.findElement(this.selectors.composer);
    await this.clickElement(composer);
    await this.sendKeys(composer, text);
    const sendButton = await this.findElement(this.selectors.sendButton);
    await this.clickElement(sendButton);
    return { id: stableSeleniumEventId({ conversationId, text, index: Date.now() }), raw: { source: 'selenium' } };
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.request(`/session/${this.sessionId}`, { method: 'DELETE' });
    } finally {
      this.sessionId = null;
    }
  }
}
