const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { parseTrustProxy } = require('../src/config/trustProxy');

test('parseTrustProxy disables trust for empty, false and zero', () => {
  for (const value of [undefined, '', '  ', 'false', '0']) {
    assert.equal(parseTrustProxy(value), null);
  }
});

test('parseTrustProxy maps true to a single hop and digits to a hop count', () => {
  assert.equal(parseTrustProxy('true'), 1);
  assert.equal(parseTrustProxy('2'), 2);
});

test('parseTrustProxy splits an address list', () => {
  assert.deepEqual(parseTrustProxy('loopback, 95.46.96.213 ,'), ['loopback', '95.46.96.213']);
});

const resolveIp = (trust, remoteAddress, forwardedFor) => {
  const app = express();
  app.set('trust proxy', trust);
  const req = Object.create(app.request);
  req.app = app;
  req.headers = { 'x-forwarded-for': forwardedFor };
  req.connection = req.socket = { remoteAddress };
  return req.ip;
};

test('address list honours the client IP forwarded by a trusted proxy chain', () => {
  const trust = parseTrustProxy('loopback,95.46.96.213');
  // browser -> dash nginx -> dash BFF (95.46.96.213) -> api nginx (loopback)
  assert.equal(resolveIp(trust, '127.0.0.1', '203.0.113.7, 95.46.96.213'), '203.0.113.7');
});

test('address list ignores a spoofed X-Forwarded-For from a direct client', () => {
  const trust = parseTrustProxy('loopback,95.46.96.213');
  assert.equal(resolveIp(trust, '127.0.0.1', '1.2.3.4, 198.51.100.9'), '198.51.100.9');
});
