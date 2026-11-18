const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:pass@127.0.0.1:1/test';

const { _internals } = require('../src/models/branches');

const { normalizeBranchPayload, attachUploadedPhoto } = _internals;

test('photo_url in the payload can only clear the photo', () => {
  assert.deepEqual(normalizeBranchPayload({ photo_url: null }, { partial: true }), { payload: { photo_url: null } });
  assert.deepEqual(normalizeBranchPayload({ photo_url: '' }, { partial: true }), { payload: { photo_url: null } });
  assert.match(
    normalizeBranchPayload({ photo_url: 'https://evil.example/x.png' }, { partial: true }).error,
    /can only be cleared/,
  );
});

test('payload without photo_url leaves the photo untouched', () => {
  const { payload } = normalizeBranchPayload({ name: 'Chilonzor' }, { partial: true });
  assert.equal('photo_url' in payload, false);
});

test('no uploaded file means no photo change', async () => {
  assert.deepEqual(await attachUploadedPhoto(undefined, 'branch-1'), { photoUrl: undefined });
});

test('non-image uploads are rejected before anything is stored', async () => {
  const result = await attachUploadedPhoto({ buffer: Buffer.from('x'), mimetype: 'application/pdf' }, 'branch-1');
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /JPEG, PNG or WebP/);
});
