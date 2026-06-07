import { createHash } from 'node:crypto';
import { Builder, By, Key, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { withRetry } from './retry.js';

function stableId(parts) {
  return createHash('sha256')
    .update(parts.filter((part) => part !== undefined && part !== null).join('|'))
    .digest('hex');
}

function parseCookieJson(raw) {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function normalizeCookie(cookie) {
  const normalized = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false
  };
  if (cookie.expiry) normalized.expiry = cookie.expiry;
  if (cookie.sameSite) normalized.sameSite = cookie.sameSite;
  return normalized;
}

export class XSeleniumClient {
  constructor({ logger, selenium }) {
    this.logger = logger;
    this.config = selenium;
    this.driver = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;

    const options = new chrome.Options();
    if (this.config.headless) options.addArguments('--headless=new');
    options.addArguments(
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-notifications',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${this.config.windowSize}`
    );
    if (this.config.noSandbox) options.addArguments('--no-sandbox');
    if (this.config.userDataDir) options.addArguments(`--user-data-dir=${this.config.userDataDir}`);
    if (this.config.binaryPath) options.setChromeBinaryPath(this.config.binaryPath);

    this.driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
    await this.driver.manage().setTimeouts({
      implicit: this.config.implicitWaitMs,
      pageLoad: this.config.pageLoadTimeoutMs,
      script: this.config.scriptTimeoutMs
    });

    await this.installCookies();
    await this.openConversation();
    this.started = true;
    this.logger.info({ groupDmUrl: this.config.groupDmUrl }, 'Selenium X client started');
  }

  async installCookies() {
    const cookies = parseCookieJson(this.config.cookiesJson);
    if (cookies.length === 0) return;

    await this.driver.get(this.config.cookieBootstrapUrl);
    for (const cookie of cookies) {
      await this.driver.manage().addCookie(normalizeCookie(cookie));
    }
  }

  async openConversation() {
    await this.driver.get(this.config.groupDmUrl);
    await this.driver.wait(until.elementLocated(By.css(this.config.messageSelector)), this.config.readyTimeoutMs);
  }

  async ensureStarted() {
    if (!this.started) await this.start();
  }

  async getAuthenticatedUserId() {
    return this.config.selfUserId;
  }

  async sendDm(_conversationId, text) {
    await this.ensureStarted();
    return withRetry(async () => {
      await this.openConversation();
      const composer = await this.driver.wait(
        until.elementLocated(By.css(this.config.composerSelector)),
        this.config.readyTimeoutMs
      );
      await composer.click();
      await composer.sendKeys(text);

      const sendButtons = await this.driver.findElements(By.css(this.config.sendButtonSelector));
      if (sendButtons.length > 0) {
        await sendButtons[sendButtons.length - 1].click();
      } else {
        await composer.sendKeys(Key.chord(Key.CONTROL, Key.ENTER));
      }

      return { id: `selenium:${Date.now()}:${stableId([text]).slice(0, 12)}` };
    }, {
      attempts: this.config.sendAttempts,
      baseDelayMs: 1000,
      logger: this.logger,
      isRetryable: () => true
    });
  }

  async listDmEvents(_conversationId, { sinceId, maxResults = 50 } = {}) {
    await this.ensureStarted();
    await this.openConversation();

    const rawEvents = await this.driver.executeScript(
      `
      const selector = arguments[0];
      const limit = arguments[1];
      const nodes = Array.from(document.querySelectorAll(selector)).slice(-limit);
      return nodes.map((node, index) => {
        const time = node.querySelector('time');
        const name = node.querySelector('[data-testid="User-Name"]');
        const links = Array.from(node.querySelectorAll('a[href]')).map((link) => link.href).filter(Boolean);
        const media = Array.from(node.querySelectorAll('img[src], video[src]')).map((element) => ({
          url: element.currentSrc || element.src,
          name: element.alt || element.getAttribute('aria-label') || 'X media'
        })).filter((item) => item.url && !item.url.includes('profile_images'));
        return {
          domIndex: index,
          text: (node.innerText || '').trim(),
          created_at: time?.dateTime || time?.getAttribute('datetime') || '',
          senderName: (name?.innerText || '').split('\n')[0] || '',
          href: links.find((href) => href.includes('/messages/') || href.includes('/status/')) || '',
          attachments: media
        };
      });
      `,
      this.config.messageSelector,
      Math.max(maxResults, this.config.visibleMessageScanLimit)
    );

    const events = rawEvents
      .filter((event) => event.text || event.attachments?.length > 0)
      .map((event) => ({
        id: event.href || stableId([event.created_at, event.senderName, event.text, event.domIndex]),
        sender_id: event.senderName === this.config.selfUserId ? this.config.selfUserId : event.senderName,
        sender: { username: event.senderName || 'X user' },
        text: event.text,
        attachments: event.attachments ?? [],
        created_at: event.created_at || new Date().toISOString()
      }));

    const sinceIndex = sinceId ? events.findIndex((event) => event.id === sinceId) : -1;
    const newEvents = sinceIndex >= 0 ? events.slice(sinceIndex + 1) : events;
    return newEvents.slice(-maxResults).reverse();
  }

  async close() {
    if (!this.driver) return;
    await this.driver.quit();
    this.driver = null;
    this.started = false;
  }
}
