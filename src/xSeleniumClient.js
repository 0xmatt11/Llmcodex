import { createHash } from 'node:crypto';

const DEFAULT_SELECTORS = {
  message: '[data-testid="cellInnerDiv"], [data-testid="messageEntry"], [data-testid="DMDrawerMessage"]',
  messageText: '[data-testid="tweetText"], [dir="auto"]',
  composer: '[data-testid="dmComposerTextInput"], [role="textbox"]',
  sendButton: '[data-testid="dmComposerSendButton"], [data-testid="sendDMFromMessageEntry"]'
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
    const texts = [];
    for (const element of elements.slice(-maxResults)) {
      const text = (await this.getElementText(element)).trim();
      if (text) texts.push(text);
    }
    return texts.map((text, index) => ({
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
