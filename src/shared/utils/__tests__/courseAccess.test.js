'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../courseAccess');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 29);
const C1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const C2 = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const C3 = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const B1 = 'bbbbbbbbbbbbbbbbbbbbbbb1';

const config = (overrides = {}) => ({ courseId: C1, access: 'premium', visibility: 'published', ...overrides });
const ctx = (enrolled = [], extra = {}) => ({ purchases: rules.activePurchases(enrolled, NOW), ...extra });

test('unconfigured priced courses stay premium; new unpriced courses need setup', () => {
  const priced = rules.defaultConfig(C1, { pricing: { finalPrice: 499 } });
  assert.equal(priced.access, 'premium');
  assert.equal(priced.visibility, 'published');
  assert.equal(priced.needsSetup, false);
  const fresh = rules.defaultConfig(C1, {});
  assert.equal(fresh.needsSetup, true);
  assert.equal(fresh.visibility, 'hidden');
  // A new course is never free (or visible) before an admin sets it up.
  assert.equal(rules.courseAccess(fresh, ctx()).unlocked, false);
  assert.equal(rules.isVisibleToStudent(fresh, rules.courseAccess(fresh, ctx())), false);
  assert.equal(rules.coursePrice({ discountedPrice: 299, pricing: { currentPrice: 399 } }), 299);
});

test('premium course is locked until bought', () => {
  assert.equal(rules.courseAccess(config(), ctx()).reason, 'locked');
  const bought = rules.courseAccess(config(), ctx([{ refId: C1, type: 'course', active: true }]));
  assert.deepEqual(bought, { unlocked: true, reason: 'purchased', expiresAt: null });
});

test('older enrollments without a type still count, other products do not', () => {
  assert.equal(rules.courseAccess(config(), ctx([{ refId: C1 }])).reason, 'purchased');
  assert.equal(rules.courseAccess(config(), ctx([{ refId: C1, type: 'resumeTemplate' }])).reason, 'locked');
  assert.equal(rules.courseAccess(config(), ctx([{ refId: C1, active: false }])).reason, 'locked');
});

test('expired purchases no longer unlock', () => {
  const expired = { refId: C1, type: 'course', expiresAt: new Date(NOW - DAY) };
  assert.equal(rules.courseAccess(config(), ctx([expired])).reason, 'locked');
});

test('free course is open, hidden course is not', () => {
  assert.equal(rules.courseAccess(config({ access: 'free' }), ctx()).reason, 'free');
  const hidden = config({ access: 'free', visibility: 'hidden' });
  assert.equal(rules.courseAccess(hidden, ctx()).reason, 'hidden');
  assert.equal(rules.isVisibleToStudent(hidden, rules.courseAccess(hidden, ctx())), false);
});

test('owners keep a course after it is hidden or made bundle-only', () => {
  const enrolled = [{ refId: C1, type: 'course' }];
  const hidden = config({ visibility: 'hidden' });
  const access = rules.courseAccess(hidden, ctx(enrolled));
  assert.equal(access.reason, 'purchased');
  assert.equal(rules.isVisibleToStudent(hidden, access), true);
  assert.equal(rules.courseAccess(config({ access: 'bundle' }), ctx(enrolled)).unlocked, true);
});

test('college-assigned courses are always unlocked', () => {
  const access = rules.courseAccess(config({ visibility: 'hidden' }), ctx([], { assignedIds: new Set([C1]) }));
  assert.equal(access.reason, 'assigned');
});

test('bundle purchase unlocks its snapshot of courses', () => {
  const enrolled = [{ refId: B1, type: 'courseBundle', courseIds: [C1, C2] }];
  const bundlesById = new Map([[B1, { title: 'Full Stack', courseIds: [C1, C2, C3] }]]);
  const c = ctx(enrolled, { bundlesById });
  assert.equal(rules.courseAccess(config({ courseId: C2, access: 'bundle' }), c).reason, 'bundle');
  // Courses added to the bundle after purchase are not included.
  assert.equal(rules.courseAccess(config({ courseId: C3, access: 'bundle' }), c).reason, 'locked');
});

test('assignment rules match the college course listing', () => {
  const student = { _id: 's1', department: { departmentId: 'cse' } };
  assert.equal(rules.isAssignedTo({ isAllDepartments: true, isAllStudents: true }, student), true);
  assert.equal(rules.isAssignedTo({ departmentIds: [], studentIds: [] }, student), true);
  assert.equal(rules.isAssignedTo({ departmentIds: ['cse'] }, student), true);
  assert.equal(rules.isAssignedTo({ departmentIds: ['ece'] }, student), false);
  assert.equal(rules.isAssignedTo({ studentIds: ['s2'] }, student), false);
  assert.equal(rules.isAssignedTo({ studentIds: ['s1'], departmentIds: ['cse'] }, student), true);
});

test('bundle overlap splits owned and new courses', () => {
  const accessById = new Map([[C1, { unlocked: true }], [C2, { unlocked: false }]]);
  assert.deepEqual(rules.bundleOverlap({ courseIds: [C1, C2] }, accessById), { ownedIds: [C1], newIds: [C2] });
});

test('config and bundle validation', () => {
  assert.ok(rules.validateCourseConfig('nope', { access: 'free' }).err);
  assert.ok(rules.validateCourseConfig(C1, { access: 'gold' }).err);
  assert.equal(rules.validateCourseConfig(C1, { access: 'bundle', visibility: 'x' }).data.visibility, 'published');

  assert.ok(rules.validateCourseBundle({ title: 'A', courseIds: [C1], price: 99 }).err);
  assert.ok(rules.validateCourseBundle({ title: 'A', courseIds: [C1, C2], price: 0 }).err);
  assert.ok(rules.validateCourseBundle({ title: 'A', courseIds: [C1, C2], price: 99, mrp: 50 }).err);
  const ok = rules.validateCourseBundle({ title: ' A ', courseIds: [C1, C2, C1], price: 99 });
  assert.deepEqual(ok.data.courseIds, [C1, C2]);
  assert.equal(ok.data.mrp, 99);
  assert.equal(ok.data.status, 'draft');
});

test('price edits keep the course editor fields and coupon in sync', () => {
  assert.equal(rules.validateCoursePricing({}, {}), null);
  const withCoupon = { currentPrice: '799', originalPrice: '2499', couponDiscount: 170 };
  assert.deepEqual(rules.validateCoursePricing({ price: 999 }, { ...withCoupon, couponCode: 'SAVE' }).data, {
    currentPrice: '999',
    originalPrice: '2499',
    couponCode: 'SAVE',
    couponDiscount: 170,
    finalPrice: 829,
  });
  // Coupon edited here.
  const edited = rules.validateCoursePricing({ price: 999, couponCode: ' new50 ', couponDiscount: 50 }, withCoupon).data;
  assert.equal(edited.couponCode, 'NEW50');
  assert.equal(edited.finalPrice, 949);
  const removed = rules.validateCoursePricing({ price: 999, couponDiscount: 0 }, withCoupon).data;
  assert.equal(removed.couponCode, '');
  assert.equal(removed.finalPrice, 999);
  assert.ok(rules.validateCoursePricing({ price: 999, couponDiscount: 50, couponCode: '' }, {}).err, 'coupon needs a code');
  assert.ok(rules.validateCoursePricing({ price: 150 }, withCoupon).err, 'price must exceed coupon');
  assert.ok(rules.validateCoursePricing({ price: 500, mrp: 400 }, {}).err, 'mrp below price');
  assert.ok(rules.validateCoursePricing({ price: -1 }, {}).err);
  assert.deepEqual(rules.validateCoursePricing({ price: 0 }, { ...withCoupon, couponCode: 'SAVE' }).data, {
    currentPrice: '0',
    originalPrice: '2499',
    couponCode: 'SAVE',
    couponDiscount: 0,
    finalPrice: 0,
  });
  assert.equal(rules.validateCoursePricing({ price: 300 }, { originalPrice: '100' }).data.originalPrice, '300');
});
