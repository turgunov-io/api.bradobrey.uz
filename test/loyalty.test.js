const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLoyaltyCashbackPercent } = require('../src/utils/loyalty');

const levels = {
  NONE: { min_points: 0, cashback_percent: 0 },
  BRONZE: { min_points: 100, cashback_percent: 1 },
  SILVER: { min_points: 300, cashback_percent: 2 },
  GOLD: { min_points: 1500, cashback_percent: 2.5 },
};

test('loyalty cashback percent follows configured level thresholds', () => {
  assert.equal(resolveLoyaltyCashbackPercent(0, levels), 0);
  assert.equal(resolveLoyaltyCashbackPercent(100, levels), 1);
  assert.equal(resolveLoyaltyCashbackPercent(999, levels), 2);
  assert.equal(resolveLoyaltyCashbackPercent(1500, levels), 2.5);
  assert.equal(resolveLoyaltyCashbackPercent(10, null, 5), 5);
});
