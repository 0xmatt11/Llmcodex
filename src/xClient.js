import { XSeleniumClient } from './xSeleniumClient.js';
import { XApiClient } from './xApiClient.js';

export function createXClient({ config, logger }) {
  if (config.x.transport === 'api') {
    return new XApiClient({
      accessToken: config.x.api.accessToken,
      apiBaseUrl: config.x.api.apiBaseUrl,
      logger
    });
  }

  return new XSeleniumClient({ selenium: config.x.selenium, logger });
}
