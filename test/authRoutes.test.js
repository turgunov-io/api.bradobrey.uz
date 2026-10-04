const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

require('dotenv').config();

const notifications = require('../src/models/notifications');
const barbers = require('../src/models/barbers');

const originalEnsureNotificationsTable = notifications.ensureNotificationsTable;
const originalLogin = barbers.login;
notifications.ensureNotificationsTable = async () => {};
let receivedBody;
barbers.login = (req, res) => {
  receivedBody = req.body;
  return res.json({ token: 'test-token' });
};

const app = require('../src/app');

test('documented and legacy login routes delegate to the existing handler', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    for (const path of ['/api/auth/login', '/api/barbers/login']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'admin', password: 'test-password' }),
      });

      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), { token: 'test-token' }, path);
      assert.deepEqual(receivedBody, { login: 'admin', password: 'test-password' }, path);
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    barbers.login = originalLogin;
    notifications.ensureNotificationsTable = originalEnsureNotificationsTable;
  }
});
