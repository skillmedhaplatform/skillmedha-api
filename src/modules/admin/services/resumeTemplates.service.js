const { ObjectId } = require("mongodb");
const { getGlobalCollections } = require("../../../shared/db/connection");
const rules = require("../../../shared/utils/resumeAccess");

// Admin side of the resume template catalogue: per-template access/pricing
// config, bundles, an audit trail of every change, and dashboard stats.
// Purchases live in users.enrolledData + the payment collection and are never
// touched here, so config changes can't remove what students already own.

const RESUME_ITEM_TYPES = [rules.PURCHASE_TYPES.template, rules.PURCHASE_TYPES.bundle];

// Configuration and pricing are CMS-admin only; viewing is open to any CMS role.
const CMS_ROLES = ["ADMIN", "MODERATOR", "VIEWER"];
const requireRole = (roles) => (req, res, next) =>
  roles.includes(req.role) ? next() : res.status(403).json({ err: "You don't have permission to do this" });
module.exports.canView = requireRole(CMS_ROLES);
module.exports.canEdit = requireRole(["ADMIN"]);

const audit = (entity, entityId, action, before, after, req) =>
  getGlobalCollections()
    .resumeConfigAudit.insertOne({
      entity,
      entityId: String(entityId),
      action,
      before: before || null,
      after: after || null,
      by: req.userID || null,
      byEmail: req.email || null,
      at: new Date(),
    })
    .catch((err) => console.error("[resumeTemplates] audit write failed:", err.message));

const toObjectId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// ─── Templates ────────────────────────────────────────────────────────────────

// GET /resume-templates — every saved config plus the bundles each template is in.
// Template keys with no config are listed by the app itself (they default to free).
module.exports.getTemplateConfigs = async (req, res) => {
  try {
    const { resumeTemplates, resumeBundles } = getGlobalCollections();
    const [configs, bundles] = await Promise.all([
      resumeTemplates.find({}).sort({ order: 1 }).toArray(),
      resumeBundles.find({ status: { $ne: "archived" } }).project({ title: 1, status: 1, templateKeys: 1 }).toArray(),
    ]);
    res.status(200).json({
      data: configs.map((c) => ({
        ...c,
        bundles: bundles
          .filter((b) => (b.templateKeys || []).includes(c.templateKey))
          .map((b) => ({ _id: b._id, title: b.title, status: b.status })),
      })),
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// PUT /resume-templates/:key — create or update one template's config.
module.exports.saveTemplateConfig = async (req, res) => {
  try {
    const { key } = req.params;
    const { err, data } = rules.validateTemplateConfig(key, req.body);
    if (err) return res.status(400).json({ err });

    const { resumeTemplates } = getGlobalCollections();
    const before = await resumeTemplates.findOne({ templateKey: key });
    const now = new Date();
    await resumeTemplates.updateOne(
      { templateKey: key },
      {
        $set: { ...data, updatedAt: now, updatedBy: req.userID || null },
        $setOnInsert: { createdAt: now, createdBy: req.userID || null },
      },
      { upsert: true }
    );
    const after = await resumeTemplates.findOne({ templateKey: key });
    audit("template", key, before ? "update" : "create", before, after, req);

    res.status(200).json({ msg: "Template saved", data: after });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// PUT /resume-templates — save many templates in one go (bulk actions and
// Quick Setup). Body: { templates: [{ templateKey, ...config }] }. Every entry
// is validated first; nothing is saved if any entry is invalid.
const MAX_BULK = 200;
module.exports.saveTemplateConfigsBulk = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.templates) ? req.body.templates : [];
    if (!items.length) return res.status(400).json({ err: "No templates to save" });
    if (items.length > MAX_BULK) return res.status(400).json({ err: `Save at most ${MAX_BULK} templates at once` });

    const valid = [];
    for (const item of items) {
      const { err, data } = rules.validateTemplateConfig(item?.templateKey, item);
      if (err) return res.status(400).json({ err: `${item?.name || item?.templateKey || "Template"}: ${err}` });
      valid.push(data);
    }

    const { resumeTemplates } = getGlobalCollections();
    const keys = valid.map((d) => d.templateKey);
    const before = await resumeTemplates.find({ templateKey: { $in: keys } }).toArray();
    const now = new Date();
    await resumeTemplates.bulkWrite(
      valid.map((data) => ({
        updateOne: {
          filter: { templateKey: data.templateKey },
          update: {
            $set: { ...data, updatedAt: now, updatedBy: req.userID || null },
            $setOnInsert: { createdAt: now, createdBy: req.userID || null },
          },
          upsert: true,
        },
      }))
    );
    const beforeByKey = new Map(before.map((b) => [b.templateKey, b]));
    valid.forEach((data) =>
      audit("template", data.templateKey, beforeByKey.has(data.templateKey) ? "bulk update" : "bulk create", beforeByKey.get(data.templateKey), data, req)
    );

    res.status(200).json({ msg: `${valid.length} template${valid.length === 1 ? "" : "s"} saved`, data: { count: valid.length } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// ─── Bundles ──────────────────────────────────────────────────────────────────

// GET /resume-bundles
module.exports.getBundles = async (req, res) => {
  try {
    const { resumeBundles } = getGlobalCollections();
    const query = req.query.includeArchived === "true" ? {} : { status: { $ne: "archived" } };
    const bundles = await resumeBundles.find(query).sort({ order: 1, createdAt: -1 }).toArray();
    res.status(200).json({ data: bundles });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// GET /resume-bundles/:id
module.exports.getBundle = async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle" });
    const bundle = await getGlobalCollections().resumeBundles.findOne({ _id: id });
    if (!bundle) return res.status(404).json({ err: "Bundle not found" });
    res.status(200).json({ data: bundle });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findDuplicateTitle = (title, excludeId) =>
  getGlobalCollections().resumeBundles.findOne({
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    status: { $ne: "archived" },
    title: { $regex: `^${escapeRegex(title)}$`, $options: "i" },
  });

// POST /resume-bundles
module.exports.createBundle = async (req, res) => {
  try {
    const { err, data } = rules.validateBundle(req.body);
    if (err) return res.status(400).json({ err });
    if (await findDuplicateTitle(data.title)) {
      return res.status(400).json({ err: "A bundle with this name already exists" });
    }

    const now = new Date();
    const doc = { ...data, createdAt: now, updatedAt: now, createdBy: req.userID || null };
    const result = await getGlobalCollections().resumeBundles.insertOne(doc);
    audit("bundle", result.insertedId, "create", null, doc, req);
    res.status(201).json({ msg: "Bundle created", data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// PUT /resume-bundles/:id
// Students who already bought the bundle keep the templates it had when they
// paid (snapshotted on their purchase), so editing the list is safe.
module.exports.updateBundle = async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle" });
    const { err, data } = rules.validateBundle(req.body);
    if (err) return res.status(400).json({ err });
    if (await findDuplicateTitle(data.title, id)) {
      return res.status(400).json({ err: "A bundle with this name already exists" });
    }

    const { resumeBundles } = getGlobalCollections();
    const before = await resumeBundles.findOne({ _id: id });
    if (!before || before.status === "archived") return res.status(404).json({ err: "Bundle not found" });

    await resumeBundles.updateOne(
      { _id: id },
      { $set: { ...data, updatedAt: new Date(), updatedBy: req.userID || null } }
    );
    const after = await resumeBundles.findOne({ _id: id });
    audit("bundle", id, "update", before, after, req);
    res.status(200).json({ msg: "Bundle updated", data: after });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// DELETE /resume-bundles/:id
// Archived, not removed: purchase history and stats keep pointing at it.
module.exports.deleteBundle = async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle" });
    const { resumeBundles } = getGlobalCollections();
    const before = await resumeBundles.findOne({ _id: id });
    if (!before || before.status === "archived") return res.status(404).json({ err: "Bundle not found" });

    await resumeBundles.updateOne(
      { _id: id },
      { $set: { status: "archived", archivedAt: new Date(), archivedBy: req.userID || null } }
    );
    audit("bundle", id, "archive", before, { ...before, status: "archived" }, req);
    res.status(200).json({ msg: "Bundle deleted" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// ─── Dashboard ────────────────────────────────────────────────────────────────

// GET /resume-templates/stats — bundle counts and sales. Template counts are
// worked out in the app, which knows every template key that exists.
module.exports.getStats = async (req, res) => {
  try {
    const { resumeBundles, payment } = getGlobalCollections();
    const [bundleCounts, sales] = await Promise.all([
      resumeBundles.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      payment
        .aggregate([
          { $match: { itemType: { $in: RESUME_ITEM_TYPES } } },
          { $group: { _id: "$itemType", orders: { $sum: 1 }, revenue: { $sum: "$amountCharged" } } },
        ])
        .toArray(),
    ]);
    const byStatus = Object.fromEntries(bundleCounts.map((b) => [b._id, b.count]));
    const salesOf = (type) => sales.find((s) => s._id === type) || { orders: 0, revenue: 0 };

    res.status(200).json({
      data: {
        bundles: {
          total: (byStatus.published || 0) + (byStatus.draft || 0),
          active: byStatus.published || 0,
          inactive: byStatus.draft || 0,
          archived: byStatus.archived || 0,
        },
        sales: {
          templates: salesOf(rules.PURCHASE_TYPES.template),
          bundles: salesOf(rules.PURCHASE_TYPES.bundle),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// GET /resume-templates/purchases?page=&pageSize=&search= — purchase history.
module.exports.getPurchases = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const query = { itemType: { $in: RESUME_ITEM_TYPES } };
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ email: rx }, { itemTitle: rx }, { orderId: rx }];
    }

    const { payment } = getGlobalCollections();
    const [items, total] = await Promise.all([
      payment
        .find(query)
        .project({ orderId: 1, paymentId: 1, amountCharged: 1, itemType: 1, itemId: 1, itemTitle: 1, email: 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      payment.countDocuments(query),
    ]);
    res.status(200).json({ data: items, pagination: { page, pageSize, total } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// GET /resume-templates/audit?entityId= — recent configuration changes.
module.exports.getAuditLog = async (req, res) => {
  try {
    const query = req.query.entityId ? { entityId: String(req.query.entityId) } : {};
    const items = await getGlobalCollections()
      .resumeConfigAudit.find(query)
      .project({ before: 0 })
      .sort({ at: -1 })
      .limit(50)
      .toArray();
    res.status(200).json({ data: items });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
