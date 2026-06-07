import assert from 'node:assert/strict';
import test from 'node:test';
import { createXClient } from '../src/xClient.js';
import { XApiClient } from '../src/xApiClient.js';

const logger = { info() {}, warn() {}, error() {} };

test('createXClient selects official X API transport without loading Selenium', async () => {
  const client = await createXClient({
    logger,
    config: {
      x: {
        transport: 'api',
        selenium: {},
        api: { accessToken: 'token-1', apiBaseUrl: 'https://api.example.test/2' }
      }
    }
  });

  assert.ok(client instanceof XApiClient);
  assert.equal(client.accessToken, 'token-1');
  assert.equal(client.apiBaseUrl, 'https://api.example.test/2');
});
