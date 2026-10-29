const { ObjectId } = require("mongodb");
const { getGlobalCollections, connectTodb } = require("../../../shared/db/connection");
const rules = require("../../../shared/utils/courseAccess");

// Student side of admin-configured course access. Course content stays where
// it is; this decides who may open a course's lessons (see the gates in
// internships.service.js) and what the catalogue shows. Internships are never
// affected — only items with type "course".

const COURSE_PROJECTION = {
  title: 1,
  type: 1,
  status: 1,
  price: 1,
  discountedPrice: 1,
  pricing: 1,
};

const loadPurchases = async (userId) => {
  if (!ObjectId.isValid(userId)) return rules.activePurchases([]);
  const { mainDBusers } = getGlobalCollections();
  const user = await mainDBusers.findOne(
    { _id: new ObjectId(userId) },
    { projection: { enrolledData: 1, subscriptions: 1 } }
  );
  // Older free enrollments were only recorded in `subscriptions`.
  const legacy = (user?.subscriptions || [])
    .filter((id) => typeof id === "string")
    .map((refId) => ({ refId, type: "course", active: true }));
  return rules.activePurchases([...(user?.enrolledData || []), ...legacy]);
};

// Courses the student's college assigned to them — always unlocked.
const loadAssignedIds = async (userId, tenantDB) => {
  if (!tenantDB || !userId) return new Set();
  try {
    const { assignedCourses, student: students } = connectTodb(tenantDB);
    const [student, assignments] = await Promise.all([
      students.findOne({ globalId: userId }, { projection: { department: 1, _id: 1 } }),
      assignedCourses.find({ type: "course" }).toArray(),
    ]);
    if (!student) return new Set();
    return new Set(
      assignments.filter((a) => rules.isAssignedTo(a, student)).map((a) => String(a.refID))
    );
  } catch (error) {
    console.error("[courseCatalog] assigned courses lookup failed:", error.message);
    return new Set();
  }
};

/**
 * Everything needed to answer access questions for one student. Bundles are
 * loaded including archived ones so old purchases still resolve.
 */
const loadAccessContext = async (userId, tenantDB) => {
  const { courseAccess, courseBundles, internshipsCollection } = getGlobalCollections();
  const [configs, bundles, courses, purchases, assignedIds] = await Promise.all([
    courseAccess.find({}).toArray(),
    courseBundles.find({}).toArray(),
    internshipsCollection.find({ type: "course" }, { projection: COURSE_PROJECTION }).toArray(),
    loadPurchases(userId),
    loadAssignedIds(userId, tenantDB),
  ]);
  const configsById = new Map(configs.map((c) => [String(c.courseId), c]));
  const coursesById = new Map(courses.map((c) => [c._id.toString(), c]));
  const bundlesById = new Map(bundles.map((b) => [b._id.toString(), b]));

  const configFor = (id) => configsById.get(String(id)) || rules.defaultConfig(id, coursesById.get(String(id)));
  const accessFor = (id) => rules.courseAccess(configFor(id), { purchases, assignedIds, bundlesById });

  return { configs, configsById, courses, coursesById, bundles, bundlesById, purchases, assignedIds, configFor, accessFor };
};

const publishedBundlesWith = (ctx, courseId) =>
  ctx.bundles
    .filter((b) => b.status === "published" && (b.courseIds || []).includes(String(courseId)))
    .map((b) => ({ _id: b._id, title: b.title, price: b.price, mrp: b.mrp }));

const bundleForStudent = (bundle, ctx) => {
  const id = bundle._id.toString();
  const owned = ctx.purchases.bundles.get(id);
  const accessById = new Map((bundle.courseIds || []).map((cid) => [cid, ctx.accessFor(cid)]));
  const { ownedIds, newIds } = rules.bundleOverlap(bundle, accessById);
  return {
    _id: bundle._id,
    title: bundle.title,
    description: bundle.description,
    thumbnail: bundle.thumbnail,
    courseIds: bundle.courseIds,
    courses: (bundle.courseIds || []).map((cid) => {
      const course = ctx.coursesById.get(cid);
      return { courseId: cid, title: course?.title || null, price: course ? rules.coursePrice(course) : null };
    }),
    price: bundle.price,
    mrp: bundle.mrp,
    validityDays: bundle.validityDays,
    order: bundle.order,
    featured: !!bundle.featured,
    entitlement: owned
      ? { unlocked: true, reason: "purchased", expiresAt: owned.expiresAt }
      : { unlocked: false, reason: "locked", expiresAt: null },
    ownedIds,
    newIds,
  };
};

// GET /course-catalog — access info for every course, keyed by course id,
// plus published course bundles. The course cards themselves still come from
// the existing course listing; the app merges this in.
module.exports.getCourseCatalog = async (req, res) => {
  try {
    const ctx = await loadAccessContext(req.userID, req.tenantDB);

    const courses = ctx.courses
      .map((course) => {
        const id = course._id.toString();
        const config = ctx.configFor(id);
        const entitlement = ctx.accessFor(id);
        return {
          courseId: id,
          access: config.access,
          visibility: config.visibility,
          featured: !!config.featured,
          order: config.order ?? 100,
          price: rules.coursePrice(course),
          mrp: rules.courseMrp(course),
          visible: rules.isVisibleToStudent(config, entitlement),
          entitlement,
          bundles: publishedBundlesWith(ctx, id),
        };
      })
      .sort((a, b) => a.order - b.order);

    const bundles = ctx.bundles
      .filter((b) => b.status === "published" || ctx.purchases.bundles.has(b._id.toString()))
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .map((b) => bundleForStudent(b, ctx));

    res.status(200).json({ data: { courses, bundles } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// Only students are gated; admins and college staff previewing content are not.
const isStudentRequest = (req) => String(req.role || "").toUpperCase() === "STUDENT";

/**
 * Access for one course when the request comes from a student, or null when
 * no gate applies (not a student, or the item is an internship).
 */
const accessForRequest = async (req, item) => {
  if (!item || item.type !== "course" || !isStudentRequest(req)) return null;
  const id = item._id.toString();
  const ctx = await loadAccessContext(req.userID, req.tenantDB);
  const config = ctx.configFor(id);
  const entitlement = ctx.accessFor(id);
  return {
    ...entitlement,
    access: config.access,
    visibility: config.visibility,
    price: rules.coursePrice(ctx.coursesById.get(id) || item),
    bundles: publishedBundlesWith(ctx, id),
  };
};

// Topic fields a locked course still shows in its curriculum.
const LOCKED_TOPIC_FIELDS = ["_id", "title", "sectionId", "internshipId", "duration", "type", "order"];
const lockTopic = (topic) => {
  const safe = { locked: true };
  for (const field of LOCKED_TOPIC_FIELDS) if (topic[field] !== undefined) safe[field] = topic[field];
  return safe;
};

/**
 * Checkout rule for one course, used by Buy Now and cart: blocks bundle-only
 * and hidden courses, and treats admin-free courses as ₹0.
 * Returns { blocked: message|null, free: boolean }.
 */
const checkoutRule = async (courseId, course) => {
  if (!course || course.type !== "course") return { blocked: null, free: false };
  const { courseAccess } = getGlobalCollections();
  const config = (await courseAccess.findOne({ courseId: String(courseId) })) || rules.defaultConfig(courseId, course);
  if (config.visibility !== "published") return { blocked: "This course is no longer available", free: false };
  if (config.access === "bundle") return { blocked: "This course is available only in a bundle", free: false };
  return { blocked: null, free: config.access === "free" };
};

// GET /my-course-purchases — the student's own course and course-bundle
// purchases, newest first, with amount paid and access validity.
// College-assigned and free courses aren't purchases, so they aren't listed.
module.exports.getMyCoursePurchases = async (req, res) => {
  try {
    if (!ObjectId.isValid(req.userID)) return res.status(200).json({ data: [] });
    const { mainDBusers, internshipsCollection, courseBundles, payment } = getGlobalCollections();
    const user = await mainDBusers.findOne(
      { _id: new ObjectId(req.userID) },
      { projection: { enrolledData: 1, email: 1 } }
    );
    const entries = (user?.enrolledData || []).filter((e) => e?.refId && e.active !== false);

    const courseIds = [...new Set(entries.filter((e) => e.type !== "courseBundle").map((e) => String(e.refId)))]
      .filter((id) => ObjectId.isValid(id));
    const bundleIds = [...new Set(entries.filter((e) => e.type === "courseBundle").map((e) => String(e.refId)))]
      .filter((id) => ObjectId.isValid(id));
    const [courses, bundles, payments] = await Promise.all([
      internshipsCollection
        .find(
          { _id: { $in: courseIds.map((id) => new ObjectId(id)) }, type: "course" },
          { projection: { title: 1, media: 1 } }
        )
        .toArray(),
      courseBundles.find({ _id: { $in: bundleIds.map((id) => new ObjectId(id)) } }).toArray(),
      payment
        .find({ $or: [{ userId: String(req.userID) }, ...(user?.email ? [{ email: user.email }] : [])] })
        .project({ orderId: 1, amountCharged: 1, courseIds: 1, itemType: 1, itemId: 1, createdAt: 1 })
        .toArray(),
    ]);
    const courseById = new Map(courses.map((c) => [c._id.toString(), c]));
    const bundleById = new Map(bundles.map((b) => [b._id.toString(), b]));
    const thumb = (c) => c?.media?.thumbnailImage || c?.media?.coverImage || null;
    const paidFor = (entry) => {
      if (entry.amountCharged !== undefined) return Number(entry.amountCharged) || 0;
      const p = payments.find((x) => (entry.orderId && x.orderId === entry.orderId) || (x.courseIds || []).includes(String(entry.refId)));
      return p ? Number(p.amountCharged) || 0 : null;
    };
    const now = Date.now();
    const validity = (entry) => {
      const expiresAt = entry.expiresAt ? new Date(entry.expiresAt) : null;
      return { expiresAt, expired: !!expiresAt && expiresAt.getTime() <= now };
    };

    const data = [];
    for (const entry of entries) {
      const id = String(entry.refId);
      if (entry.type === "courseBundle") {
        const bundle = bundleById.get(id);
        const ids = (entry.courseIds?.length ? entry.courseIds : bundle?.courseIds || []).map(String);
        data.push({
          kind: "bundle",
          id,
          title: bundle?.title || entry.title || "Course bundle",
          purchasedAt: entry.createdAt || null,
          amount: paidFor(entry),
          ...validity(entry),
          courses: ids.map((cid) => ({ courseId: cid, title: courseById.get(cid)?.title || null, thumbnail: thumb(courseById.get(cid)) })),
        });
      } else if (courseById.has(id) && !entry.viaBundle) {
        const course = courseById.get(id);
        data.push({
          kind: "course",
          id,
          title: course.title,
          thumbnail: thumb(course),
          purchasedAt: entry.createdAt || null,
          amount: paidFor(entry),
          ...validity(entry),
        });
      }
    }
    // Bundle courses need their titles too.
    const missing = [...new Set(data.flatMap((d) => (d.courses || []).filter((c) => !c.title).map((c) => c.courseId)))]
      .filter((cid) => ObjectId.isValid(cid));
    if (missing.length) {
      const extra = await internshipsCollection
        .find({ _id: { $in: missing.map((cid) => new ObjectId(cid)) } }, { projection: { title: 1, media: 1 } })
        .toArray();
      const extraById = new Map(extra.map((c) => [c._id.toString(), c]));
      data.forEach((d) =>
        (d.courses || []).forEach((c) => {
          if (!c.title) {
            c.title = extraById.get(c.courseId)?.title || "Course";
            c.thumbnail = thumb(extraById.get(c.courseId));
          }
        })
      );
    }
    data.sort((a, b) => new Date(b.purchasedAt || 0) - new Date(a.purchasedAt || 0));
    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.loadAccessContext = loadAccessContext;
module.exports.bundleForStudent = bundleForStudent;
module.exports.accessForRequest = accessForRequest;
module.exports.lockTopic = lockTopic;
module.exports.checkoutRule = checkoutRule;
