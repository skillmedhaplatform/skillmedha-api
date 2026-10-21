const { ObjectId } = require("mongodb");
const { getGlobalCollections } = require("../../../shared/db/connection");
const rules = require("../../../shared/utils/resumeAccess");

// Student side of the admin-configured resume template catalogue. Template
// layouts live in the student app; the server decides who may use which
// template and refuses locked ones (see authorizeTemplate).

const loadPurchases = async (userId) => {
  if (!ObjectId.isValid(userId)) return rules.activePurchases([]);
  const { mainDBusers } = getGlobalCollections();
  const user = await mainDBusers.findOne(
    { _id: new ObjectId(userId) },
    { projection: { enrolledData: 1 } }
  );
  return rules.activePurchases(user?.enrolledData || []);
};

/**
 * Everything needed to answer access questions for one student: every
 * template config, every bundle (archived ones too, so old purchases still
 * resolve) and the student's active purchases.
 */
const loadAccessContext = async (userId) => {
  const { resumeTemplates, resumeBundles } = getGlobalCollections();
  const [configs, bundles, purchases] = await Promise.all([
    resumeTemplates.find({}).toArray(),
    resumeBundles.find({}).toArray(),
    loadPurchases(userId),
  ]);
  const configsByKey = new Map(configs.map((c) => [c.templateKey, c]));
  const bundlesById = new Map(bundles.map((b) => [b._id.toString(), b]));
  const accessFor = (key) =>
    rules.templateAccess(configsByKey.get(key) || rules.defaultConfig(key), purchases, bundlesById);
  return { configs, configsByKey, bundles, bundlesById, purchases, accessFor };
};

const bundleForStudent = (bundle, ctx) => {
  const id = bundle._id.toString();
  const owned = ctx.purchases.bundles.get(id);
  const accessByKey = new Map((bundle.templateKeys || []).map((k) => [k, ctx.accessFor(k)]));
  const { ownedKeys, newKeys } = rules.bundleOverlap(bundle, accessByKey);
  return {
    _id: bundle._id,
    title: bundle.title,
    description: bundle.description,
    thumbnail: bundle.thumbnail,
    templateKeys: bundle.templateKeys,
    templates: (bundle.templateKeys || []).map((key) => ({
      templateKey: key,
      name: ctx.configsByKey.get(key)?.name || null,
    })),
    price: bundle.price,
    mrp: bundle.mrp,
    validityDays: bundle.validityDays,
    order: bundle.order,
    featured: !!bundle.featured,
    entitlement: owned
      ? { unlocked: true, reason: "purchased", expiresAt: owned.expiresAt }
      : { unlocked: false, reason: "locked", expiresAt: null },
    ownedKeys,
    newKeys,
  };
};

// GET /resume-catalog
// Templates with no config are not listed here: the app shows them as free,
// which is also what the server enforces for them.
module.exports.getResumeCatalog = async (req, res) => {
  try {
    const ctx = await loadAccessContext(req.userID);

    const publishedBundles = ctx.bundles.filter((b) => b.status === "published");
    const bundlesContaining = (key) =>
      publishedBundles
        .filter((b) => (b.templateKeys || []).includes(key))
        .map((b) => ({ _id: b._id, title: b.title, price: b.price }));

    const templates = ctx.configs
      .map((config) => {
        const entitlement = ctx.accessFor(config.templateKey);
        if (!rules.isVisibleToStudent(config, entitlement)) return null;
        return {
          templateKey: config.templateKey,
          name: config.name,
          description: config.description,
          category: config.category,
          previewImage: config.previewImage,
          bestFor: config.bestFor || [],
          access: config.access,
          price: config.price,
          mrp: config.mrp,
          validityDays: config.validityDays,
          order: config.order,
          featured: !!config.featured,
          visibility: config.visibility,
          entitlement,
          bundles: bundlesContaining(config.templateKey),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.order - b.order);

    // Bundles the student owns stay listed even after the admin unpublishes them.
    const bundles = ctx.bundles
      .filter((b) => b.status === "published" || ctx.purchases.bundles.has(b._id.toString()))
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .map((b) => bundleForStudent(b, ctx));

    res.status(200).json({
      data: {
        templates,
        bundles,
        // Keys that need no listing because the student can use them anyway.
        hiddenKeys: ctx.configs
          .filter((c) => !rules.isVisibleToStudent(c, ctx.accessFor(c.templateKey)))
          .map((c) => c.templateKey),
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// POST /resume-templates/:key/authorize
// Called before a student switches to a template and before a PDF is
// generated, so a paid layout can't be used by calling APIs directly.
module.exports.authorizeTemplate = async (req, res) => {
  try {
    const { key } = req.params;
    if (!rules.isTemplateKey(key)) return res.status(400).json({ err: "Unknown template" });

    const ctx = await loadAccessContext(req.userID);
    const config = ctx.configsByKey.get(key) || rules.defaultConfig(key);
    const entitlement = ctx.accessFor(key);

    if (entitlement.unlocked) {
      return res.status(200).json({ data: { allowed: true, entitlement } });
    }
    if (entitlement.reason === "hidden") {
      return res.status(404).json({ err: "This template is not available", code: "NOT_AVAILABLE" });
    }
    return res.status(402).json({
      err:
        config.access === "bundle"
          ? "This template is available only in a bundle"
          : "Purchase this template to use it",
      code: "PAYMENT_REQUIRED",
      access: config.access,
      price: config.price,
      bundles: ctx.bundles
        .filter((b) => b.status === "published" && (b.templateKeys || []).includes(key))
        .map((b) => ({ _id: b._id, title: b.title, price: b.price })),
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.loadAccessContext = loadAccessContext;
module.exports.bundleForStudent = bundleForStudent;
