'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../membership');
const courseRules = require('../courseAccess');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5);
const at = (days) => new Date(NOW + days * DAY);
const doc = (planKey, startDay, endDay, extra = {}) => ({
  planKey,
  status: 'active',
  startsAt: at(startDay),
  expiresAt: at(endDay),
  amountCharged: 0,
  ...extra,
});

test('paid plans start off, and need a price before turning on', () => {
  const plans = rules.mergePlans([]);
  assert.deepEqual(plans.map((p) => [p.key, p.status]), [['free', 'published'], ['premium', 'draft'], ['pro', 'draft']]);
  assert.ok(rules.validatePlan('pro', { name: 'Pro', status: 'published', options: [] }).err);
  const ok = rules.validatePlan('pro', { name: 'Pro', status: 'published', options: [{ days: 365, price: 999, mrp: 1499 }, { days: 90, price: 399 }] });
  assert.deepEqual(ok.data.options.map((o) => o.days), [90, 365]);
  assert.equal(ok.data.options[0].mrp, 399);
});

test('starter plans are valid, so an admin can turn them on as they are', () => {
  for (const plan of rules.mergePlans([])) {
    const { err, data } = rules.validatePlan(plan.key, { ...plan, status: 'published' });
    assert.equal(err, undefined);
    assert.equal(data.status, 'published');
  }
  assert.deepEqual(rules.mergePlans([]).map((p) => p.name), ['Free', 'Prime', 'Pro']);
  // A saved edit replaces the starter values.
  const [, prime] = rules.mergePlans([{ key: 'premium', name: 'Plus', options: [] }]);
  assert.equal(prime.name, 'Plus');
  assert.deepEqual(prime.options, []);
});

test('plan validation rejects bad prices and unknown plans', () => {
  assert.ok(rules.validatePlan('gold', { name: 'Gold' }).err);
  assert.ok(rules.validatePlan('pro', { name: '' }).err);
  assert.ok(rules.validatePlan('pro', { name: 'Pro', options: [{ days: 30, price: 0 }] }).err);
  assert.ok(rules.validatePlan('pro', { name: 'Pro', options: [{ days: 30, price: 100, mrp: 50 }] }).err);
  assert.ok(rules.validatePlan('pro', { name: 'Pro', options: [{ days: 30, price: 100 }, { days: 30, price: 90 }] }).err);
  // Free can't be priced or switched off.
  const free = rules.validatePlan('free', { name: 'Free', status: 'draft', options: [{ days: 30, price: 100 }] });
  assert.equal(free.data.status, 'published');
  assert.deepEqual(free.data.options, []);
});

test('the current plan is the highest one running; expired and revoked ones do not count', () => {
  assert.equal(rules.currentMembership([], NOW), null);
  assert.equal(rules.currentMembership([doc('pro', -30, -1)], NOW), null);
  assert.equal(rules.currentMembership([doc('pro', -1, 30, { status: 'revoked' })], NOW), null);
  assert.equal(rules.currentMembership([doc('pro', 5, 30)], NOW), null);
  assert.equal(rules.currentMembership([doc('premium', -1, 30), doc('pro', -1, 10)], NOW).planKey, 'pro');
});

test('back-to-back renewals count as one run', () => {
  const current = rules.currentMembership([doc('premium', -10, 5), doc('premium', 5, 35)], NOW);
  assert.equal(current.expiresAt.getTime(), at(35).getTime());
  const gap = rules.currentMembership([doc('premium', -10, 5), doc('premium', 9, 35)], NOW);
  assert.equal(gap.expiresAt.getTime(), at(5).getTime());
});

test('a plan includes everything below it', () => {
  const pro = { planKey: 'pro' };
  const premium = { planKey: 'premium' };
  assert.equal(rules.planCovers(pro, 'premium'), true);
  assert.equal(rules.planCovers(premium, 'pro'), false);
  assert.equal(rules.planCovers(premium, 'premium'), true);
  assert.equal(rules.planCovers(null, 'premium'), false);
  // An untagged item is never opened by a plan.
  assert.equal(rules.planCovers(pro, undefined), false);
});

test('upgrades get credit for unused paid days only', () => {
  const docs = [doc('premium', -50, 50, { amountCharged: 1000 })];
  assert.equal(rules.upgradeCredit(docs, 'pro', NOW), 500);
  assert.equal(rules.upgradeCredit(docs, 'premium', NOW), 0);
  // An admin-given pass was never paid for.
  assert.equal(rules.upgradeCredit([doc('premium', -50, 50)], 'pro', NOW), 0);
  assert.deepEqual(rules.quote({ price: 2000 }, docs, 'pro', NOW), { price: 2000, credit: 500, payable: 1500 });
  // Never below Razorpay's ₹1 minimum.
  assert.deepEqual(rules.quote({ price: 300 }, docs, 'pro', NOW), { price: 300, credit: 299, payable: 1 });
});

test('a renewal starts when the same plan ends; other plans do not delay it', () => {
  const docs = [doc('premium', -10, 20)];
  const renewal = rules.nextWindow(docs, 'premium', 30, NOW);
  assert.equal(renewal.startsAt.getTime(), at(20).getTime());
  assert.equal(renewal.expiresAt.getTime(), at(50).getTime());
  assert.equal(rules.nextWindow(docs, 'pro', 30, NOW).startsAt.getTime(), NOW);
});

test('students cannot buy below their plan, but can renew or upgrade', () => {
  const current = { planKey: 'pro', rank: 2 };
  assert.ok(rules.purchaseBlock(current, 'premium'));
  assert.equal(rules.purchaseBlock(current, 'pro'), null);
  assert.equal(rules.purchaseBlock({ planKey: 'premium', rank: 1 }, 'pro'), null);
  assert.equal(rules.purchaseBlock(null, 'premium'), null);
});

test('tag validation', () => {
  const id = 'a'.repeat(24);
  assert.ok(rules.validateTags({ minPlan: 'free', items: [{ itemType: 'course', itemId: id }] }).err);
  assert.ok(rules.validateTags({ minPlan: 'pro', items: [] }).err);
  assert.ok(rules.validateTags({ minPlan: 'pro', items: [{ itemType: 'internship', itemId: id }] }).err);
  assert.ok(rules.validateTags({ minPlan: 'pro', items: [{ itemType: 'course', itemId: 'x' }] }).err);
  assert.equal(rules.validateTags({ minPlan: null, items: [{ itemType: 'practiceSet', itemId: id }] }).data.minPlan, null);
});

test('course access: a plan opens a locked course, after every existing rule', () => {
  const planAccess = { expiresAt: at(30), planKey: 'pro', planName: 'Pro' };
  const config = { courseId: 'c1', access: 'premium', visibility: 'published' };
  const purchases = courseRules.activePurchases([]);

  assert.equal(courseRules.courseAccess(config, { purchases }).reason, 'locked');
  const viaPlan = courseRules.courseAccess(config, { purchases, planAccess });
  assert.equal(viaPlan.reason, 'plan');
  assert.equal(viaPlan.unlocked, true);
  assert.equal(viaPlan.planName, 'Pro');

  // Purchases, college assignment and Free keep their own reasons.
  const bought = courseRules.activePurchases([{ refId: 'c1', type: 'course' }]);
  assert.equal(courseRules.courseAccess(config, { purchases: bought, planAccess }).reason, 'purchased');
  assert.equal(courseRules.courseAccess(config, { purchases, assignedIds: new Set(['c1']), planAccess }).reason, 'assigned');
  assert.equal(courseRules.courseAccess({ ...config, access: 'free' }, { purchases, planAccess }).reason, 'free');
  // A hidden course stays hidden.
  assert.equal(courseRules.courseAccess({ ...config, visibility: 'hidden' }, { purchases, planAccess }).reason, 'hidden');
});

test('course access: plan courses do not count as owned when buying a bundle', () => {
  const access = new Map([
    ['c1', { unlocked: true, reason: 'plan' }],
    ['c2', { unlocked: true, reason: 'purchased' }],
  ]);
  const overlap = courseRules.bundleOverlap({ courseIds: ['c1', 'c2'] }, access);
  assert.deepEqual(overlap.newIds, ['c1']);
  assert.deepEqual(overlap.ownedIds, ['c2']);
});
