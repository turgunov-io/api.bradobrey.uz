const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('logout is JWT-scoped and clears persisted active branch presence', () => {
  const source = read('src/models/barbers.js');
  assert.match(source, /authenticateBarberWorkspace\(req, res, 'Only workspace employees can log out'\)/);
  assert.match(source, /setActiveEmployeeBranch\(\{[\s\S]*employeeId: barber_id,[\s\S]*isOnShift: false/);
  assert.match(source, /clearShiftTimer\(barber_id\)/);
});

test('kiosk visibility requires fresh on-shift presence', () => {
  const source = read('src/models/kiosk.js');
  assert.match(source, /updated_at/);
  assert.match(source, /\.gte\('updated_at', presenceCutoff\)/);
  assert.match(source, /isOnShift === true/);
});

test('presence heartbeat endpoint is wired', () => {
  const router = read('src/routers/barbers.js');
  const model = read('src/models/barbers.js');
  assert.match(router, /router\.post\('\/presence', \(req, res\) => barbers\.presence\(req, res\)\)/);
  assert.match(model, /async presence\(req, res\)/);
  assert.match(model, /touchActiveEmployeeBranch/);
});
