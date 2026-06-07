import { XApiClient } from './xApiClient.js';

export async function createXClient({ config, logger }) {
  if (config.x.transport === 'api') {
    return new XApiClient({
      accessToken: config.x.api.accessToken,
      apiBaseUrl: config.x.api.apiBaseUrl,
      logger
    });
  }

  try {
    const { XSeleniumClient } = await import('./xSeleniumClient.js');
    return new XSeleniumClient({ selenium: config.x.selenium, logger });
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('selenium-webdriver')) {
      throw new Error('X_TRANSPORT=selenium requires the selenium-webdriver package. Run npm install before starting the bridge.');
    }
    throw error;
  }
}
