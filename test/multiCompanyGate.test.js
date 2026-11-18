// Multi-company gate (security review H2 + M1): a second company may only be
// created (or a suspended non-default company re-activated) once kiosk auth
// is enforced and the DB runs with app.tenant_strict = 'on'.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'multi-company-gate-secret';

const { createPlatformController, multiCompanyPreconditions } = require('../src/models/platform');

const DEFAULT_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';

function res() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function repo({ strict = 'on', companies = {} } = {}) {
  const writes = [];
  return {
    writes,
    async tenantStrictSetting() { return strict; },
    async createCompany(fields) { writes.push(['create', fields]); return { id: OTHER_ID, ...fields }; },
    async findCompanyById(id) { return companies[id] ? { ...companies[id] } : null; },
    async updateCompany(id, fields) { writes.push(['update', id, fields]); return { ...companies[id], ...fields }; },
  };
}

const ENFORCED = { KIOSK_AUTH_ENFORCE: 'true' };
const body = { name: 'President', code: 'PRESIDENT' };

test('multiCompanyPreconditions lists every failing precondition', async () => {
  assert.deepEqual(await multiCompanyPreconditions({ env: ENFORCED, repo: repo() }), []);
  assert.deepEqual(await multiCompanyPreconditions({ env: {}, repo: repo({ strict: null }) }), ['KIOSK_AUTH_ENFORCE', 'TENANT_STRICT']);
  assert.deepEqual(await multiCompanyPreconditions({ env: { KIOSK_AUTH_ENFORCE: 'false' }, repo: repo() }), ['KIOSK_AUTH_ENFORCE']);
  assert.deepEqual(await multiCompanyPreconditions({ env: ENFORCED, repo: repo({ strict: 'off' }) }), ['TENANT_STRICT']);
});

test('createCompany is refused with 409 MULTI_COMPANY_PRECONDITIONS until both preconditions hold', async () => {
  for (const [env, strict, failed] of [
    [{}, 'on', ['KIOSK_AUTH_ENFORCE']],
    [ENFORCED, '', ['TENANT_STRICT']],
    [{}, null, ['KIOSK_AUTH_ENFORCE', 'TENANT_STRICT']],
  ]) {
    const r = repo({ strict });
    const response = res();
    await createPlatformController({ repo: r, env }).createCompany({ body }, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'MULTI_COMPANY_PRECONDITIONS');
    assert.deepEqual(response.body.failed, failed);
    assert.equal(r.writes.length, 0, 'nothing written');
  }

  const r = repo();
  const ok = res();
  await createPlatformController({ repo: r, env: ENFORCED }).createCompany({ body }, ok);
  assert.equal(ok.statusCode, 201);
  assert.equal(r.writes.length, 1);
});

test('re-activating a suspended non-default company is gated; other updates are not', async () => {
  const companies = {
    [OTHER_ID]: { id: OTHER_ID, is_default: false, status: 'suspended' },
    [DEFAULT_ID]: { id: DEFAULT_ID, is_default: true, status: 'active' },
  };
  const gated = res();
  const r = repo({ strict: null, companies });
  await createPlatformController({ repo: r, env: {} }).updateCompany({ params: { id: OTHER_ID }, body: { status: 'active' } }, gated);
  assert.equal(gated.statusCode, 409);
  assert.equal(gated.body.code, 'MULTI_COMPANY_PRECONDITIONS');
  assert.equal(r.writes.length, 0);

  // Renaming a suspended company or touching the default company stays allowed.
  for (const [id, patch] of [[OTHER_ID, { name: 'President 2' }], [DEFAULT_ID, { status: 'active' }], [DEFAULT_ID, { name: 'Bradobrey' }]]) {
    const response = res();
    await createPlatformController({ repo: repo({ strict: null, companies }), env: {} }).updateCompany({ params: { id }, body: patch }, response);
    assert.equal(response.statusCode, 200, `${id} ${JSON.stringify(patch)}`);
  }

  const allowed = res();
  await createPlatformController({ repo: repo({ companies }), env: ENFORCED }).updateCompany({ params: { id: OTHER_ID }, body: { status: 'active' } }, allowed);
  assert.equal(allowed.statusCode, 200);
});
