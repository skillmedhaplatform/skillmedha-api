'use strict';

// Rules for Free / Premium / Pro membership plans. Pure functions — no database
// access — so they can be unit-tested and shared by the admin, student and
// payment services. A plan is a paid, time-limited pass on top of course access
// and practice sets: items are tagged with the lowest plan that opens them, and
// each plan includes everything below it. Untagged items are never affected.

const PLAN_KEYS = ['free', 'premium', 'pro'];
const PAID_PLAN_KEYS = ['premium', 'pro'];
const PLAN_RANK = { free: 0, premium: 1, pro: 2 };
const ITEM_TYPES = ['course', 'practiceSet'];
const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 3650;

// Starter plans for the admin to edit. Paid plans start as drafts, so nothing
// changes for students until an admin checks the prices and turns a plan on.
// The "premium" key is internal; students see the plan's name.
const DEFAULT_PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    description: 'Start learning at no cost.',
    features: ['All free courses', 'All free practice sets'],
    options: [],
    status: 'published',
    highlighted: false,
  },
  premium: {
    key: 'premium',
    name: 'Prime',
    description: 'More courses and practice to build your skills.',
    features: ['Everything in Free', 'Courses marked Prime', 'Practice sets marked Prime'],
    options: [
      { days: 90, price: 999, mrp: 1499 },
      { days: 180, price: 1799, mrp: 2699 },
      { days: 365, price: 2999, mrp: 4499 },
    ],
    status: 'draft',
    highlighted: true,
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    description: 'Our full set of plan courses and practice.',
    features: ['Everything in Prime', 'Courses marked Pro', 'Practice sets marked Pro'],
    options: [
      { days: 90, price: 1999, mrp: 2999 },
      { days: 180, price: 3499, mrp: 5299 },
      { days: 365, price: 5999, mrp: 8999 },
    ],
    status: 'draft',
    highlighted: false,
  },
};

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const cleanText = (value, max) => String(value ?? '').trim().slice(0, max);

const planRank = (key) => PLAN_RANK[key] ?? 0;

/** The three plans in order, with stored settings over the defaults. */
const mergePlans = (stored = []) => {
  const byKey = new Map(stored.map((p) => [p.key, p]));
  return PLAN_KEYS.map((key) => ({ ...DEFAULT_PLANS[key], ...(byKey.get(key) || {}), key, rank: PLAN_RANK[key] }));
};

/** Validates an admin plan edit; returns { err } or { data }. */
const validatePlan = (key, body = {}) => {
  if (!PLAN_KEYS.includes(key)) return { err: 'Unknown plan' };
  const name = cleanText(body.name, 40);
  if (!name) return { err: 'Plan name is required' };

  const features = (Array.isArray(body.features) ? body.features : [])
    .map((f) => cleanText(f, 120))
    .filter(Boolean)
    .slice(0, 12);
  const base = {
    name,
    description: cleanText(body.description, 300),
    features,
    highlighted: !!body.highlighted,
  };
  // Free has no price and can't be switched off.
  if (key === 'free') return { data: { ...base, highlighted: false, options: [], status: 'published' } };

  const options = [];
  for (const raw of Array.isArray(body.options) ? body.options : []) {
    const days = Math.floor(toNumber(raw?.days));
    const price = toNumber(raw?.price);
    const mrp = toNumber(raw?.mrp, price) || price;
    if (days < 1 || days > MAX_DAYS) return { err: `Duration must be between 1 and ${MAX_DAYS} days` };
    if (price < 1) return { err: 'Every duration needs a price of at least ₹1' };
    if (mrp < price) return { err: 'Original price cannot be lower than the selling price' };
    if (options.some((o) => o.days === days)) return { err: `The ${days}-day duration is listed twice` };
    options.push({ days, price, mrp });
  }
  options.sort((a, b) => a.days - b.days);

  const status = body.status === 'published' ? 'published' : 'draft';
  if (status === 'published' && !options.length) return { err: 'Add at least one price before turning this plan on' };
  return { data: { ...base, options, status } };
};

const isLive = (doc, now) => doc.status === 'active' && new Date(doc.expiresAt).getTime() > now;

/**
 * The student's plan right now: the highest plan already started, ending when
 * its run of back-to-back renewals ends. Returns null when there is none.
 */
const currentMembership = (docs = [], now = Date.now()) => {
  const live = docs.filter((d) => isLive(d, now));
  const started = live.filter((d) => new Date(d.startsAt).getTime() <= now);
  if (!started.length) return null;
  const planKey = started.reduce((top, d) => (planRank(d.planKey) > planRank(top) ? d.planKey : top), started[0].planKey);

  let end = 0;
  const samePlan = live.filter((d) => d.planKey === planKey).sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  for (const doc of samePlan) {
    const start = new Date(doc.startsAt).getTime();
    if (start <= now || start <= end) end = Math.max(end, new Date(doc.expiresAt).getTime());
  }
  return { planKey, rank: planRank(planKey), expiresAt: new Date(end) };
};

/** May a student on `current` open an item tagged with `minPlan`? */
const planCovers = (current, minPlan) => !!current && !!minPlan && planRank(current.planKey) >= planRank(minPlan);

/** Rupees still unused on paid passes for plans below `planKey`. */
const upgradeCredit = (docs = [], planKey, now = Date.now()) => {
  let credit = 0;
  for (const doc of docs) {
    if (!isLive(doc, now) || planRank(doc.planKey) >= planRank(planKey)) continue;
    const paid = toNumber(doc.amountCharged);
    if (paid <= 0) continue;
    const start = new Date(doc.startsAt).getTime();
    const end = new Date(doc.expiresAt).getTime();
    const total = end - start;
    if (total <= 0) continue;
    credit += paid * ((end - Math.max(now, start)) / total);
  }
  return Math.floor(credit);
};

/**
 * What a student pays for one plan duration: { price, credit, payable }.
 * Credit can't take the amount below ₹1, Razorpay's minimum.
 */
const quote = (option, docs, planKey, now = Date.now()) => {
  const price = toNumber(option?.price);
  const credit = Math.min(upgradeCredit(docs, planKey, now), Math.max(0, Math.floor(price) - 1));
  return { price, credit, payable: Math.max(1, price - credit) };
};

/** A renewal starts when the same plan ends, so no paid days are lost. */
const nextWindow = (docs, planKey, days, now = Date.now()) => {
  const ends = docs.filter((d) => d.planKey === planKey && isLive(d, now)).map((d) => new Date(d.expiresAt).getTime());
  const start = Math.max(now, ...ends);
  return { startsAt: new Date(start), expiresAt: new Date(start + days * DAY) };
};

/** A student can't buy a plan below the one they're on. */
const purchaseBlock = (current, planKey) =>
  current && planRank(planKey) < current.rank ? 'You are already on a higher plan' : null;

const tagKey = (itemType, itemId) => `${itemType}:${itemId}`;

/** Validates an admin tag change; returns { err } or { data }. */
const validateTags = (body = {}) => {
  const minPlan = body.minPlan ?? null;
  if (minPlan !== null && !PAID_PLAN_KEYS.includes(minPlan)) return { err: 'Choose a paid plan or no plan' };
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { err: 'Select at least one item' };
  for (const item of items) {
    if (!ITEM_TYPES.includes(item?.itemType) || !/^[a-f0-9]{24}$/i.test(String(item?.itemId || ''))) {
      return { err: 'One of the selected items is invalid' };
    }
  }
  return {
    data: { minPlan, items: items.map((i) => ({ itemType: i.itemType, itemId: String(i.itemId) })) },
  };
};

module.exports = {
  PLAN_KEYS,
  PAID_PLAN_KEYS,
  ITEM_TYPES,
  MAX_DAYS,
  DAY,
  planRank,
  mergePlans,
  validatePlan,
  currentMembership,
  planCovers,
  upgradeCredit,
  quote,
  nextWindow,
  purchaseBlock,
  tagKey,
  validateTags,
};
