'use strict';

// Rules for admin-configured course access (Free / Premium / Bundle-only /
// Hidden) and course bundles. Pure functions — no database access — so the
// rules can be unit-tested and shared by the admin, student, payment and
// course-content services. Internships are never affected.
//
// A course with no saved config keeps today's behaviour when it has a price
// (Premium, visible). A new course with no price and no config "needs setup":
// it stays hidden from students until an admin configures it, so it never
// goes out free by accident. Prices are set only in Course Access & Bundles.

const ACCESS_TYPES = ['free', 'premium', 'bundle'];
const VISIBILITIES = ['published', 'hidden'];

// enrolledData types that are NOT a single-course purchase.
const NON_COURSE_TYPES = new Set([
  'internship',
  'workshop',
  'courseBundle',
  'practiceSet',
  'practiceBundle',
  'resumeTemplate',
  'resumeBundle',
]);

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const cleanText = (value, max) => String(value ?? '').trim().slice(0, max);

/** The price the course editor set — same order the Buy Now flow uses. */
const coursePrice = (course) =>
  toNumber(
    course?.pricing?.finalPrice ??
      course?.discountedPrice ??
      course?.pricing?.currentPrice ??
      course?.pricing?.originalPrice ??
      course?.price ??
      0
  );

const courseMrp = (course) => Math.max(toNumber(course?.pricing?.originalPrice), coursePrice(course));

const defaultConfig = (courseId, course) => {
  const priced = coursePrice(course) > 0;
  return {
    courseId: String(courseId),
    access: 'premium',
    visibility: priced ? 'published' : 'hidden',
    featured: false,
    order: 100,
    isDefault: true,
    needsSetup: !priced,
  };
};

/**
 * Course purchases from a user's enrolledData.
 * Returns { courses: Map<courseId, expiresAt|null>, bundles: Map<bundleId, { expiresAt, courseIds }> }.
 * Older course enrollments have no type or a course "type" label, so anything
 * that isn't a known non-course type counts as a course purchase.
 */
const activePurchases = (enrolledData = [], now = Date.now()) => {
  const courses = new Map();
  const bundles = new Map();
  for (const entry of enrolledData || []) {
    if (!entry || entry.active === false || !entry.refId) continue;
    const expiresAt = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
    if (expiresAt && expiresAt <= now) continue;
    const id = String(entry.refId);

    if (entry.type === 'courseBundle') {
      const current = bundles.get(id);
      if (!current || (current.expiresAt !== null && (expiresAt === null || expiresAt > current.expiresAt))) {
        bundles.set(id, { expiresAt, courseIds: (entry.courseIds || []).map(String) });
      }
    } else if (!NON_COURSE_TYPES.has(entry.type)) {
      const current = courses.get(id);
      if (current === undefined || (current !== null && (expiresAt === null || expiresAt > current))) {
        courses.set(id, expiresAt);
      }
    }
  }
  return { courses, bundles };
};

/**
 * Same eligibility rules as the college "assigned courses" listing
 * (getAllCoursesCombo): whole college, departments and/or named students.
 */
const isAssignedTo = (assignment, student) => {
  if (!assignment || !student) return false;
  const { departmentIds = [], studentIds = [], isAllDepartments, isAllStudents } = assignment;
  const studentId = student._id ? String(student._id) : '';
  const departmentId = student.department?.departmentId || student.department;

  if (isAllDepartments && isAllStudents) return true;
  if (isAllDepartments) return isAllStudents || studentIds.length === 0 || studentIds.includes(studentId);
  if (departmentIds.length === 0 && studentIds.length === 0) return true;
  if (studentIds.length > 0) {
    return studentIds.includes(studentId) && (departmentIds.length === 0 || departmentIds.includes(departmentId));
  }
  return departmentIds.includes(departmentId);
};

/**
 * Why (and until when) a student may open a course's lessons.
 * reason: assigned | purchased | bundle | free | locked | hidden
 */
const courseAccess = (config, { purchases, assignedIds = new Set(), bundlesById = new Map() }) => {
  const id = String(config.courseId);

  if (assignedIds.has(id)) return { unlocked: true, reason: 'assigned', expiresAt: null };
  if (purchases.courses.has(id)) return { unlocked: true, reason: 'purchased', expiresAt: purchases.courses.get(id) };
  for (const [bundleId, owned] of purchases.bundles) {
    const ids = owned.courseIds?.length ? owned.courseIds : (bundlesById.get(bundleId)?.courseIds || []).map(String);
    if (ids.includes(id)) {
      return { unlocked: true, reason: 'bundle', expiresAt: owned.expiresAt, bundleId, bundleTitle: bundlesById.get(bundleId)?.title || null };
    }
  }
  if (config.visibility !== 'published') return { unlocked: false, reason: 'hidden', expiresAt: null };
  if (config.access === 'free') return { unlocked: true, reason: 'free', expiresAt: null };
  return { unlocked: false, reason: 'locked', expiresAt: null };
};

// Hidden courses stay out of the catalogue unless the student already has them.
const isVisibleToStudent = (config, access) =>
  config.visibility === 'published' || (access.unlocked && access.reason !== 'free');

/** Courses in a bundle the student already has, and the ones they'd gain. */
const bundleOverlap = (bundle, accessById) => {
  const ownedIds = [];
  const newIds = [];
  for (const id of (bundle.courseIds || []).map(String)) {
    (accessById.get(id)?.unlocked ? ownedIds : newIds).push(id);
  }
  return { ownedIds, newIds };
};

const isObjectIdLike = (id) => /^[a-f0-9]{24}$/i.test(String(id || ''));

/** Validates an admin course config; returns { err } or { data }. */
const validateCourseConfig = (courseId, body = {}) => {
  if (!isObjectIdLike(courseId)) return { err: 'Unknown course' };
  if (!ACCESS_TYPES.includes(body.access)) return { err: 'Access must be free, premium or bundle' };
  return {
    data: {
      courseId: String(courseId),
      access: body.access,
      visibility: VISIBILITIES.includes(body.visibility) ? body.visibility : 'published',
      featured: !!body.featured,
      order: Math.floor(toNumber(body.order, 100)),
    },
  };
};

/**
 * Validates a price change made from the access screen, against the course's
 * current pricing. Same fields the course editor writes: currentPrice and
 * originalPrice (as text) plus finalPrice = price − coupon discount, which is
 * what checkout charges. Returns null when the body has no pricing,
 * otherwise { err } or { data }.
 */
const validateCoursePricing = (body = {}, pricing = {}) => {
  if (body.price === undefined || body.price === null || body.price === '') return null;
  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0) return { err: 'Price must be 0 or more' };
  if (price > 1000000) return { err: 'Price seems unreasonably high' };

  const hasMrp = body.mrp !== undefined && body.mrp !== null && body.mrp !== '';
  const mrp = hasMrp ? Number(body.mrp) : Math.max(toNumber(pricing.originalPrice), price);
  if (!Number.isFinite(mrp) || mrp < 0) return { err: 'Original price must be 0 or more' };
  if (mrp && mrp < price) return { err: 'Original price cannot be lower than the price' };

  // The coupon can be changed here too; when it isn't sent, the course keeps its own.
  const couponSent = body.couponDiscount !== undefined && body.couponDiscount !== null && body.couponDiscount !== '';
  const couponDiscount = couponSent ? Number(body.couponDiscount) : toNumber(pricing.couponDiscount);
  if (!Number.isFinite(couponDiscount) || couponDiscount < 0) return { err: 'Coupon discount must be 0 or more' };
  const couponCode = couponDiscount > 0
    ? cleanText(body.couponCode !== undefined ? body.couponCode : pricing.couponCode, 30).toUpperCase()
    : '';
  if (couponDiscount > 0 && !couponCode) return { err: 'Give the coupon a code' };
  if (price > 0 && couponDiscount >= price) {
    return { err: `Price must be more than the coupon discount (₹${couponDiscount})` };
  }
  return {
    data: {
      currentPrice: String(price),
      originalPrice: mrp ? String(mrp) : '',
      couponCode,
      couponDiscount: price > 0 ? couponDiscount : 0,
      finalPrice: price > 0 ? price - couponDiscount : 0,
    },
  };
};

/** Validates an admin course bundle; returns { err } or { data }. */
const validateCourseBundle = (body = {}) => {
  const title = cleanText(body.title, 80);
  if (!title) return { err: 'Bundle name is required' };

  const rawIds = Array.isArray(body.courseIds) ? body.courseIds.map(String) : [];
  if (rawIds.some((id) => !isObjectIdLike(id))) return { err: 'One of the selected courses is invalid' };
  const courseIds = [...new Set(rawIds)];
  if (courseIds.length < 2) return { err: 'A bundle needs at least 2 courses' };

  const price = toNumber(body.price);
  const mrp = toNumber(body.mrp, price) || price;
  if (price <= 0) return { err: 'Bundle price must be greater than 0' };
  if (mrp < price) return { err: 'Original price cannot be lower than the selling price' };

  return {
    data: {
      title,
      description: cleanText(body.description, 300),
      thumbnail: cleanText(body.thumbnail, 500),
      courseIds,
      price,
      mrp,
      validityDays: Math.max(0, Math.floor(toNumber(body.validityDays))),
      order: Math.floor(toNumber(body.order, 100)),
      featured: !!body.featured,
      status: ['draft', 'published'].includes(body.status) ? body.status : 'draft',
    },
  };
};

module.exports = {
  ACCESS_TYPES,
  VISIBILITIES,
  coursePrice,
  courseMrp,
  defaultConfig,
  activePurchases,
  isAssignedTo,
  courseAccess,
  isVisibleToStudent,
  bundleOverlap,
  isObjectIdLike,
  validateCourseConfig,
  validateCoursePricing,
  validateCourseBundle,
};
