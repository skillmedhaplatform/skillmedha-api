'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../resumeAccess');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18);

const config = (overrides = {}) => ({
  templateKey: 'template5',
  access: 'premium',
  visibility: 'published',
  price: 99,
  mrp: 199,
  ...overrides,
});

const purchase = (type, refId, extra = {}) => ({ type, refId, active: true, createdAt: new Date(NOW), ...extra });

test('unconfigured templates default to free and visible', () => {
  const access = rules.templateAccess(rules.defaultConfig('template3'), rules.activePurchases([], NOW));
  assert.deepEqual(access, { unlocked: true, reason: 'free', expiresAt: null });
});

test('premium template is locked until purchased', () => {
  const none = rules.activePurchases([], NOW);
  assert.equal(rules.templateAccess(config(), none).reason, 'locked');

  const bought = rules.activePurchases([purchase('resumeTemplate', 'template5')], NOW);
  const access = rules.templateAccess(config(), bought);
  assert.equal(access.unlocked, true);
  assert.equal(access.reason, 'purchased');
  assert.equal(access.expiresAt, null);
});

test('bundle-only template unlocks through an owned bundle', () => {
  const purchases = rules.activePurchases(
    [purchase('resumeBundle', 'b1', { templateKeys: ['template5', 'template6'] })],
    NOW
  );
  const bundles = new Map([['b1', { title: 'Career Bundle', templateKeys: ['template5'] }]]);
  const access = rules.templateAccess(config({ access: 'bundle' }), purchases, bundles);
  assert.equal(access.unlocked, true);
  assert.equal(access.reason, 'bundle');
  assert.equal(access.bundleTitle, 'Career Bundle');
});

test('bundle access uses the templates snapshotted at purchase time', () => {
  // Admin later removed template5 from the bundle; the buyer keeps it.
  const purchases = rules.activePurchases(
    [purchase('resumeBundle', 'b1', { templateKeys: ['template5'] })],
    NOW
  );
  const bundles = new Map([['b1', { title: 'Edited', templateKeys: ['template9'] }]]);
  assert.equal(rules.templateAccess(config({ access: 'bundle' }), purchases, bundles).unlocked, true);
});

test('older bundle purchases without a snapshot fall back to the bundle', () => {
  const purchases = rules.activePurchases([purchase('resumeBundle', 'b1')], NOW);
  const bundles = new Map([['b1', { title: 'Old', templateKeys: ['template5'] }]]);
  assert.equal(rules.templateAccess(config(), purchases, bundles).reason, 'bundle');
});

test('expired and inactive purchases do not grant access', () => {
  const purchases = rules.activePurchases(
    [
      purchase('resumeTemplate', 'template5', { expiresAt: new Date(NOW - DAY) }),
      purchase('resumeTemplate', 'template6', { active: false }),
    ],
    NOW
  );
  assert.equal(rules.templateAccess(config(), purchases).unlocked, false);
  assert.equal(rules.templateAccess(config({ templateKey: 'template6' }), purchases).unlocked, false);
});

test('a renewal keeps the longest validity', () => {
  const purchases = rules.activePurchases(
    [
      purchase('resumeTemplate', 'template5', { expiresAt: new Date(NOW + 10 * DAY) }),
      purchase('resumeTemplate', 'template5', { expiresAt: new Date(NOW + 90 * DAY) }),
    ],
    NOW
  );
  assert.equal(purchases.templates.get('template5'), NOW + 90 * DAY);

  const lifetime = rules.activePurchases(
    [purchase('resumeTemplate', 'template5', { expiresAt: new Date(NOW + DAY) }), purchase('resumeTemplate', 'template5')],
    NOW
  );
  assert.equal(lifetime.templates.get('template5'), null);
});

test('hidden templates are locked and not listed unless owned', () => {
  const hidden = config({ access: 'free', visibility: 'hidden' });
  const none = rules.activePurchases([], NOW);
  const access = rules.templateAccess(hidden, none);
  assert.equal(access.reason, 'hidden');
  assert.equal(rules.isVisibleToStudent(hidden, access), false);

  const owned = rules.activePurchases([purchase('resumeTemplate', 'template5')], NOW);
  const ownedAccess = rules.templateAccess(hidden, owned);
  assert.equal(ownedAccess.unlocked, true);
  assert.equal(rules.isVisibleToStudent(hidden, ownedAccess), true);
});

test('course and practice purchases are ignored', () => {
  const purchases = rules.activePurchases(
    [purchase('course', 'template5'), purchase('practiceSet', 'template5')],
    NOW
  );
  assert.equal(purchases.templates.size, 0);
  assert.equal(purchases.bundles.size, 0);
});

test('bundleOverlap splits already-owned and new templates', () => {
  const accessByKey = new Map([
    ['template1', { unlocked: true }],
    ['template2', { unlocked: false }],
  ]);
  assert.deepEqual(rules.bundleOverlap({ templateKeys: ['template1', 'template2'] }, accessByKey), {
    ownedKeys: ['template1'],
    newKeys: ['template2'],
  });
});

test('validateTemplateConfig enforces pricing rules', () => {
  assert.equal(rules.validateTemplateConfig('bad-key', { name: 'x', access: 'free' }).err, 'Unknown template');
  assert.match(rules.validateTemplateConfig('template1', { access: 'free' }).err, /name is required/);
  assert.match(rules.validateTemplateConfig('template1', { name: 'A', access: 'gold' }).err, /Access must be/);
  assert.match(rules.validateTemplateConfig('template1', { name: 'A', access: 'premium', price: 0 }).err, /price greater than 0/);
  assert.match(
    rules.validateTemplateConfig('template1', { name: 'A', access: 'premium', price: 200, mrp: 100 }).err,
    /Original price/
  );

  const free = rules.validateTemplateConfig('template1', { name: ' Clean ', access: 'free', price: 500, visibility: 'published' });
  assert.equal(free.data.name, 'Clean');
  assert.equal(free.data.price, 0, 'free templates never carry a price');
  assert.equal(free.data.visibility, 'published');

  const premium = rules.validateTemplateConfig('template1', { name: 'A', access: 'premium', price: 99 });
  assert.equal(premium.data.mrp, 99, 'MRP defaults to the price');
  assert.equal(premium.data.visibility, 'hidden', 'unknown visibility defaults to hidden');
});

test('validateBundle requires templates and a valid price', () => {
  assert.match(rules.validateBundle({ templateKeys: ['template1'], price: 10 }).err, /name is required/);
  assert.match(rules.validateBundle({ title: 'B', templateKeys: [], price: 10 }).err, /at least one template/);
  assert.match(rules.validateBundle({ title: 'B', templateKeys: ['nope'], price: 10 }).err, /invalid/);
  assert.match(rules.validateBundle({ title: 'B', templateKeys: ['template1'], price: 0 }).err, /greater than 0/);
  assert.match(rules.validateBundle({ title: 'B', templateKeys: ['template1'], price: 300, mrp: 100 }).err, /Original price/);

  const ok = rules.validateBundle({
    title: 'Starter',
    templateKeys: ['template1', 'template2', 'template1'],
    price: 199,
    status: 'published',
  });
  assert.deepEqual(ok.data.templateKeys, ['template1', 'template2'], 'duplicates removed');
  assert.equal(ok.data.status, 'published');
  assert.equal(rules.validateBundle({ title: 'X', templateKeys: ['template1'], price: 1, status: 'archived' }).data.status, 'draft');
});
