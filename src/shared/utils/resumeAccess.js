'use strict';

// Rules for the admin-configured resume template catalogue. Pure functions
// (no database access) so the access, validation and purchase rules can be
// unit-tested and shared by the admin, student and payment services.
//
// Template layouts are React components in the student app, identified by a
// key such as "template7". The catalogue stores one config document per key;
// a key with no config behaves exactly as before this feature: free and
// visible to every student.

const ACCESS_TYPES = ['free', 'premium', 'bundle'];
const VISIBILITIES = ['published', 'hidden'];
const BUNDLE_STATUSES = ['draft', 'published', 'archived'];
const TEMPLATE_KEY = /^template\d{1,3}$/;

// enrolledData entry types written by the payment service.
const PURCHASE_TYPES = { template: 'resumeTemplate', bundle: 'resumeBundle' };

const isTemplateKey = (key) => typeof key === 'string' && TEMPLATE_KEY.test(key);

const defaultConfig = (templateKey) => ({
  templateKey,
  access: 'free',
  visibility: 'published',
  price: 0,
  mrp: 0,
  validityDays: 0,
  isDefault: true,
});

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const cleanText = (value, max) => String(value ?? '').trim().slice(0, max);

/**
 * Active (paid, not expired) resume purchases from a user's enrolledData.
 * Returns { templates: Map<key, expiresAt|null>, bundles: Map<id, { expiresAt, templateKeys }> }.
 * A bundle purchase stores the template keys it contained at purchase time,
 * so later edits to the bundle never take away what a student paid for.
 */
const activePurchases = (enrolledData = [], now = Date.now()) => {
  const templates = new Map();
  const bundles = new Map();
  const keepLonger = (map, key, expiresAt, extra) => {
    const current = map.get(key);
    const currentExpiry = current && typeof current === 'object' ? current.expiresAt : current;
    if (current === undefined || (currentExpiry !== null && (expiresAt === null || expiresAt > currentExpiry))) {
      map.set(key, extra ? { expiresAt, ...extra } : expiresAt);
    }
  };

  for (const entry of enrolledData || []) {
    if (!entry || entry.active === false) continue;
    const expiresAt = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
    if (expiresAt && expiresAt <= now) continue;
    const key = String(entry.refId);
    if (entry.type === PURCHASE_TYPES.template) keepLonger(templates, key, expiresAt);
    else if (entry.type === PURCHASE_TYPES.bundle) {
      keepLonger(bundles, key, expiresAt, { templateKeys: entry.templateKeys || null });
    }
  }
  return { templates, bundles };
};

/**
 * Why (and until when) a student may use a template.
 * `bundlesById` maps bundle id → bundle doc, used for bundle purchases made
 * before template keys were snapshotted on the entitlement.
 * reason: free | purchased | bundle | locked | hidden
 */
const templateAccess = (config, purchases, bundlesById = new Map()) => {
  const cfg = config || defaultConfig(null);
  const key = cfg.templateKey;

  if (purchases.templates.has(key)) {
    return { unlocked: true, reason: 'purchased', expiresAt: purchases.templates.get(key) };
  }
  for (const [bundleId, owned] of purchases.bundles) {
    const keys = owned.templateKeys || bundlesById.get(bundleId)?.templateKeys || [];
    if (keys.includes(key)) {
      return {
        unlocked: true,
        reason: 'bundle',
        expiresAt: owned.expiresAt,
        bundleId,
        bundleTitle: bundlesById.get(bundleId)?.title || null,
      };
    }
  }
  if (cfg.visibility !== 'published') return { unlocked: false, reason: 'hidden', expiresAt: null };
  if (cfg.access === 'free') return { unlocked: true, reason: 'free', expiresAt: null };
  return { unlocked: false, reason: 'locked', expiresAt: null };
};

// Hidden templates stay out of the catalogue unless the student already owns them.
const isVisibleToStudent = (config, access) =>
  (config?.visibility || 'published') === 'published' || (access.unlocked && access.reason !== 'free');

/** Templates in a bundle the student already has, and the ones they'd gain. */
const bundleOverlap = (bundle, accessByKey) => {
  const ownedKeys = [];
  const newKeys = [];
  for (const key of bundle.templateKeys || []) {
    (accessByKey.get(key)?.unlocked ? ownedKeys : newKeys).push(key);
  }
  return { ownedKeys, newKeys };
};

/** Validates an admin template config; returns { err } or { data }. */
const validateTemplateConfig = (templateKey, body = {}) => {
  if (!isTemplateKey(templateKey)) return { err: 'Unknown template' };

  const name = cleanText(body.name, 60);
  if (!name) return { err: 'Template name is required' };

  const access = body.access;
  if (!ACCESS_TYPES.includes(access)) return { err: 'Access must be free, premium or bundle' };

  const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : 'hidden';

  let price = 0;
  let mrp = 0;
  if (access === 'premium') {
    price = toNumber(body.price);
    mrp = toNumber(body.mrp, price) || price;
    if (price <= 0) return { err: 'Premium templates need a price greater than 0' };
    if (mrp < price) return { err: 'Original price cannot be lower than the selling price' };
  }

  const bestFor = (Array.isArray(body.bestFor) ? body.bestFor : [])
    .map((t) => cleanText(t, 30))
    .filter(Boolean)
    .slice(0, 8);

  return {
    data: {
      templateKey,
      name,
      description: cleanText(body.description, 300),
      category: cleanText(body.category, 30) || 'Modern',
      previewImage: cleanText(body.previewImage, 500),
      bestFor,
      access,
      visibility,
      price,
      mrp,
      validityDays: Math.max(0, Math.floor(toNumber(body.validityDays))),
      order: Math.floor(toNumber(body.order, 100)),
      featured: !!body.featured,
    },
  };
};

/** Validates an admin bundle; returns { err } or { data }. */
const validateBundle = (body = {}) => {
  const title = cleanText(body.title, 80);
  if (!title) return { err: 'Bundle name is required' };

  const rawKeys = Array.isArray(body.templateKeys) ? body.templateKeys : [];
  if (rawKeys.some((k) => !isTemplateKey(k))) return { err: 'One of the selected templates is invalid' };
  const templateKeys = [...new Set(rawKeys)];
  if (!templateKeys.length) return { err: 'Select at least one template for the bundle' };

  const price = toNumber(body.price);
  const mrp = toNumber(body.mrp, price) || price;
  if (price <= 0) return { err: 'Bundle price must be greater than 0' };
  if (mrp < price) return { err: 'Original price cannot be lower than the selling price' };

  const status = ['draft', 'published'].includes(body.status) ? body.status : 'draft';

  return {
    data: {
      title,
      description: cleanText(body.description, 300),
      thumbnail: cleanText(body.thumbnail, 500),
      templateKeys,
      price,
      mrp,
      validityDays: Math.max(0, Math.floor(toNumber(body.validityDays))),
      order: Math.floor(toNumber(body.order, 100)),
      featured: !!body.featured,
      status,
    },
  };
};

module.exports = {
  ACCESS_TYPES,
  VISIBILITIES,
  BUNDLE_STATUSES,
  PURCHASE_TYPES,
  isTemplateKey,
  defaultConfig,
  activePurchases,
  templateAccess,
  isVisibleToStudent,
  bundleOverlap,
  validateTemplateConfig,
  validateBundle,
};
