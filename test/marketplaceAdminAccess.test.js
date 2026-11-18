const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'marketplace-admin-test-secret-0123456789abcdef';

const { detectMediaType } = require('../src/utils/mediaSignature');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(4)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(4)]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);

test('detectMediaType recognises supported image and video signatures', () => {
  assert.equal(detectMediaType(JPEG), 'image/jpeg');
  assert.equal(detectMediaType(PNG), 'image/png');
  assert.equal(detectMediaType(GIF), 'image/gif');
  assert.equal(detectMediaType(WEBP), 'image/webp');
  assert.equal(detectMediaType(MP4), 'video/mp4');
  assert.equal(detectMediaType(MOV), 'video/quicktime');
  assert.equal(detectMediaType(WEBM), 'video/webm');
});

test('detectMediaType rejects anything else', () => {
  assert.equal(detectMediaType(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(detectMediaType(Buffer.from('%PDF-1.7')), null);
  assert.equal(detectMediaType(Buffer.alloc(0)), null);
  assert.equal(detectMediaType(undefined), null);
});

async function statusOf(server, method, path) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  });
  await response.arrayBuffer();
  return response.status;
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/marketplace/barbershops', require('../src/routers/marketplace/barbershops'));
  app.use('/api/marketplace/banners', require('../src/routers/marketplace/banner'));
  app.use('/api/kiosk', require('../src/routers/kiosk'));
  return app.listen(0);
}

test('marketplace admin and kiosk device-management routes answer 401 to anonymous requests', async () => {
  const server = startApp();
  try {
    const routes = [
      ['GET', '/api/marketplace/barbershops'],
      ['GET', '/api/marketplace/barbershops/b1'],
      ['GET', '/api/marketplace/barbershops/b1/merchant'],
      ['POST', '/api/marketplace/barbershops'],
      ['POST', '/api/marketplace/barbershops/b1/merchant'],
      ['DELETE', '/api/marketplace/barbershops/b1/merchant'],
      ['PATCH', '/api/marketplace/barbershops/b1'],
      ['POST', '/api/marketplace/barbershops/b1/activate'],
      ['POST', '/api/marketplace/barbershops/b1/deactivate'],
      ['DELETE', '/api/marketplace/barbershops/b1'],
      ['POST', '/api/marketplace/banners'],
      ['PUT', '/api/marketplace/banners/1'],
      ['PATCH', '/api/marketplace/banners/1'],
      ['DELETE', '/api/marketplace/banners/1'],
      // Kiosk registration itself is open; listing/removing devices is staff-only.
      ['GET', '/api/kiosk/devices'],
      ['DELETE', '/api/kiosk/devices/33333333-3333-4333-8333-333333333333'],
    ];
    for (const [method, path] of routes) {
      assert.equal(await statusOf(server, method, path), 401, `${method} ${path}`);
    }
  } finally {
    server.close();
  }
});

test('anonymous multipart banner uploads are refused before the body is buffered', async () => {
  const server = startApp();
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(1024 * 1024)]), 'big.jpg');
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/marketplace/banners`, { method: 'POST', body: form });
    await response.arrayBuffer();
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});
