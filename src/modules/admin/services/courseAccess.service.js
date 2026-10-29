const { ObjectId } = require("mongodb");
const { getGlobalCollections, getTenantDB, connectTodb } = require("../../../shared/db/connection");
const rules = require("../../../shared/utils/courseAccess");

// Admin side of course access: per-course Free / Premium / Bundle-only and
// visibility, course bundles, sales and an audit trail. Course prices stay in
// the course editor. Purchases live in users.enrolledData + payment and are
// never touched here, so config changes can't remove what students own.
// Only items with type "course" are listed — internships are untouched.

// Prices are edited here too, but stored on the course itself (the same
// fields the course editor uses), so checkout, cards and the editor agree.

// Configuration is CMS-admin only; viewing is open to any CMS role.
const CMS_ROLES = ["ADMIN", "MODERATOR", "VIEWER"];
const requireRole = (roles) => (req, res, next) =>
  roles.includes(req.role) ? next() : res.status(403).json({ err: "You don't have permission to do this" });
module.exports.canView = requireRole(CMS_ROLES);
module.exports.canEdit = requireRole(["ADMIN"]);

const audit = (entity, entityId, action, before, after, req) =>
  getGlobalCollections()
    .courseConfigAudit.insertOne({
      entity,
      entityId: String(entityId),
      action,
      before: before || null,
      after: after || null,
      by: req.userID || null,
      byEmail: req.email || null,
      at: new Date(),
    })
    .catch((err) => console.error("[courseAccess] audit write failed:", err.message));

const toObjectId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const COURSE_FIELDS = {
  title: 1,
  subtitle: 1,
  media: 1,
  category: 1,
  difficulty: 1,
  duration: 1,
  status: 1,
  price: 1,
  discountedPrice: 1,
  pricing: 1,
  assignedOrgs: 1,
  createdAt: 1,
};

const allCourses = () =>
  getGlobalCollections().internshipsCollection.find({ type: "course" }, { projection: COURSE_FIELDS }).toArray();

// Only real courses can be configured.
const courseExists = async (ids) => {
  const objectIds = ids.map(toObjectId).filter(Boolean);
  const found = await getGlobalCollections()
    .internshipsCollection.find({ _id: { $in: objectIds }, type: "course" }, { projection: { _id: 1 } })
    .toArray();
  const foundIds = new Set(found.map((c) => c._id.toString()));
  return ids.filter((id) => !foundIds.has(String(id)));
};

// ─── Course access ────────────────────────────────────────────────────────────

// GET /course-access — every course with its current access config (defaults
// filled in for courses never configured) and the bundles it is in.
module.exports.getCourseConfigs = async (req, res) => {
  try {
    const { courseAccess, courseBundles } = getGlobalCollections();
    const [courses, configs, bundles] = await Promise.all([
      allCourses(),
      courseAccess.find({}).toArray(),
      courseBundles.find({ status: { $ne: "archived" } }).project({ title: 1, status: 1, courseIds: 1 }).toArray(),
    ]);
    const configsById = new Map(configs.map((c) => [String(c.courseId), c]));

    const data = courses
      .map((course) => {
        const id = course._id.toString();
        const config = configsById.get(id) || rules.defaultConfig(id, course);
        return {
          courseId: id,
          title: course.title,
          subtitle: course.subtitle,
          thumbnail: course.media?.thumbnailImage || course.media?.coverImage || course.media?.bannerImage || null,
          category: course.category,
          difficulty: course.difficulty,
          duration: course.duration,
          status: course.status,
          price: rules.coursePrice(course),
          mrp: rules.courseMrp(course),
          // Price before coupon, as set in the course editor.
          basePrice: Number(course.pricing?.currentPrice ?? course.price ?? 0) || 0,
          couponCode: course.pricing?.couponCode || "",
          couponDiscount: Number(course.pricing?.couponDiscount) || 0,
          collegeCount: (course.assignedOrgs || []).length,
          access: config.access,
          visibility: config.visibility,
          featured: !!config.featured,
          order: config.order ?? 100,
          isDefault: !!config.isDefault,
          updatedAt: config.updatedAt || null,
          bundles: bundles
            .filter((b) => (b.courseIds || []).includes(id))
            .map((b) => ({ _id: b._id, title: b.title, status: b.status })),
        };
      })
      .sort((a, b) => a.order - b.order || String(a.title).localeCompare(String(b.title)));

    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

const saveConfigs = async (valid, req, action) => {
  const { courseAccess } = getGlobalCollections();
  const ids = valid.map((d) => d.courseId);
  const before = await courseAccess.find({ courseId: { $in: ids } }).toArray();
  const now = new Date();
  await courseAccess.bulkWrite(
    valid.map((data) => ({
      updateOne: {
        filter: { courseId: data.courseId },
        update: {
          $set: { ...data, updatedAt: now, updatedBy: req.userID || null },
          $setOnInsert: { createdAt: now, createdBy: req.userID || null },
        },
        upsert: true,
      },
    }))
  );
  const beforeById = new Map(before.map((b) => [b.courseId, b]));
  valid.forEach((data) =>
    audit("course", data.courseId, `${action}${beforeById.has(data.courseId) ? "update" : "create"}`, beforeById.get(data.courseId), data, req)
  );
};

// Validates the optional price change for each course; returns { err } or
// { updates: [{ course, pricing }] }.
const checkPricing = async (items) => {
  const priced = items.filter((i) => i.body.price !== undefined && i.body.price !== null && i.body.price !== "");
  if (!priced.length) return { updates: [] };
  const courses = await getGlobalCollections()
    .internshipsCollection.find(
      { _id: { $in: priced.map((i) => toObjectId(i.courseId)) } },
      { projection: { title: 1, pricing: 1, assignedOrgs: 1 } }
    )
    .toArray();
  const byId = new Map(courses.map((c) => [c._id.toString(), c]));
  const updates = [];
  for (const { courseId, body } of priced) {
    const course = byId.get(courseId);
    const result = rules.validateCoursePricing(body, course?.pricing || {});
    if (result?.err) return { err: `${course?.title || "Course"}: ${result.err}` };
    if (result) updates.push({ course, pricing: result.data });
  }
  return { updates };
};

// Writes new prices onto the course and any college copy of it.
const applyPricing = async (updates, req) => {
  const { internshipsCollection } = getGlobalCollections();
  const now = new Date().getTime();
  for (const { course, pricing } of updates) {
    const $set = {
      "pricing.currentPrice": pricing.currentPrice,
      "pricing.originalPrice": pricing.originalPrice,
      "pricing.finalPrice": pricing.finalPrice,
      "pricing.couponCode": pricing.couponCode,
      "pricing.couponDiscount": pricing.couponDiscount,
      updatedAt: now,
    };
    await internshipsCollection.updateOne({ _id: course._id }, { $set });
    await Promise.all(
      (course.assignedOrgs || []).map(async (orgId) => {
        try {
          const { internships } = connectTodb(await getTenantDB(orgId));
          await internships.updateOne({ _id: course._id }, { $set });
        } catch (error) {
          console.error(`[courseAccess] price sync to ${orgId} failed:`, error.message);
        }
      })
    );
    audit("price", course._id, "update", course.pricing || null, pricing, req);
  }
};

// PUT /course-access/:courseId — save one course's access config, and its
// price when the body has `price` (and optionally `mrp`).
module.exports.saveCourseConfig = async (req, res) => {
  try {
    const { err, data } = rules.validateCourseConfig(req.params.courseId, req.body);
    if (err) return res.status(400).json({ err });
    if ((await courseExists([data.courseId])).length) return res.status(404).json({ err: "Course not found" });
    const priceCheck = await checkPricing([{ courseId: data.courseId, body: req.body }]);
    if (priceCheck.err) return res.status(400).json({ err: priceCheck.err });

    await applyPricing(priceCheck.updates, req);
    await saveConfigs([data], req, "");
    const saved = await getGlobalCollections().courseAccess.findOne({ courseId: data.courseId });
    res.status(200).json({ msg: "Course access saved", data: saved });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// PUT /course-access — bulk save. Body: { courses: [{ courseId, ...config }] }.
// Every entry is validated first; nothing is saved if any entry is invalid.
const MAX_BULK = 200;
module.exports.saveCourseConfigsBulk = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.courses) ? req.body.courses : [];
    if (!items.length) return res.status(400).json({ err: "No courses to save" });
    if (items.length > MAX_BULK) return res.status(400).json({ err: `Save at most ${MAX_BULK} courses at once` });

    const valid = [];
    for (const item of items) {
      const { err, data } = rules.validateCourseConfig(item?.courseId, item);
      if (err) return res.status(400).json({ err: `${item?.title || "Course"}: ${err}` });
      valid.push(data);
    }
    const missing = await courseExists(valid.map((d) => d.courseId));
    if (missing.length) return res.status(404).json({ err: `${missing.length} course(s) not found` });
    const priceCheck = await checkPricing(items.map((item) => ({ courseId: String(item.courseId), body: item })));
    if (priceCheck.err) return res.status(400).json({ err: priceCheck.err });

    await applyPricing(priceCheck.updates, req);
    await saveConfigs(valid, req, "bulk ");
    res.status(200).json({ msg: `${valid.length} course${valid.length === 1 ? "" : "s"} saved`, data: { count: valid.length } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// ─── Bundles ──────────────────────────────────────────────────────────────────

// GET /course-bundles
module.exports.getBundles = async (req, res) => {
  try {
    const query = req.query.includeArchived === "true" ? {} : { status: { $ne: "archived" } };
    const bundles = await getGlobalCollections().courseBundles.find(query).sort({ order: 1, createdAt: -1 }).toArray();
    res.status(200).json({ data: bundles });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

const findDuplicateTitle = (title, excludeId) =>
  getGlobalCollections().courseBundles.findOne({
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    status: { $ne: "archived" },
    title: { $regex: `^${escapeRegex(title)}$`, $options: "i" },
  });

const checkBundle = async (body, excludeId) => {
  const { err, data } = rules.validateCourseBundle(body);
  if (err) return { err };
  if (await findDuplicateTitle(data.title, excludeId)) return { err: "A bundle with this name already exists" };
  if ((await courseExists(data.courseIds)).length) return { err: "One of the selected courses no longer exists" };
  return { data };
};

// POST /course-bundles
module.exports.createBundle = async (req, res) => {
  try {
    const { err, data } = await checkBundle(req.body);
    if (err) return res.status(400).json({ err });

    const now = new Date();
    const doc = { ...data, createdAt: now, updatedAt: now, createdBy: req.userID || null };
    const result = await getGlobalCollections().courseBundles.insertOne(doc);
    audit("bundle", result.insertedId, "create", null, doc, req);
    res.status(201).json({ msg: "Bundle created", data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// PUT /course-bundles/:id
// Students who already bought the bundle keep the courses it had when they
// paid (each was enrolled individually), so editing the list is safe.
module.exports.updateBundle = async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle" });
    const { err, data } = await checkBundle(req.body, id);
    if (err) return res.status(400).json({ err });

    const { courseBundles } = getGlobalCollections();
    const before = await courseBundles.findOne({ _id: id });
    if (!before || before.status === "archived") return res.status(404).json({ err: "Bundle not found" });

    await courseBundles.updateOne({ _id: id }, { $set: { ...data, updatedAt: new Date(), updatedBy: req.userID || null } });
    const after = await courseBundles.findOne({ _id: id });
    audit("bundle", id, "update", before, after, req);
    res.status(200).json({ msg: "Bundle updated", data: after });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// DELETE /course-bundles/:id
// Archived, not removed: purchase history and stats keep pointing at it.
module.exports.deleteBundle = async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle" });
    const { courseBundles } = getGlobalCollections();
    const before = await courseBundles.findOne({ _id: id });
    if (!before || before.status === "archived") return res.status(404).json({ err: "Bundle not found" });

    await courseBundles.updateOne(
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

// GET /course-access/stats — bundle counts and course bundle sales.
module.exports.getStats = async (req, res) => {
  try {
    const { courseBundles, payment } = getGlobalCollections();
    const [bundleCounts, sales] = await Promise.all([
      courseBundles.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      payment
        .aggregate([
          { $match: { itemType: "courseBundle" } },
          { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: "$amountCharged" } } },
        ])
        .toArray(),
    ]);
    const byStatus = Object.fromEntries(bundleCounts.map((b) => [b._id, b.count]));
    res.status(200).json({
      data: {
        bundles: {
          total: (byStatus.published || 0) + (byStatus.draft || 0),
          active: byStatus.published || 0,
          inactive: byStatus.draft || 0,
          archived: byStatus.archived || 0,
        },
        sales: { bundles: { orders: sales[0]?.orders || 0, revenue: sales[0]?.revenue || 0 } },
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// GET /course-access/audit?entityId= — recent configuration changes.
module.exports.getAuditLog = async (req, res) => {
  try {
    const query = req.query.entityId ? { entityId: String(req.query.entityId) } : {};
    const items = await getGlobalCollections()
      .courseConfigAudit.find(query)
      .project({ before: 0 })
      .sort({ at: -1 })
      .limit(50)
      .toArray();
    res.status(200).json({ data: items });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
