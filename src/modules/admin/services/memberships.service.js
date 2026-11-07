const { ObjectId } = require("mongodb");
const { getGlobalCollections } = require("../../../shared/db/connection");
const rules = require("../../../shared/utils/membership");
const courseRules = require("../../../shared/utils/courseAccess");
const { findInAllTenants } = require("../../student/services/practice.service");
const { loadPlans } = require("../../student/services/membership.service");

// Admin side of Free / Premium / Pro plans: plan settings, which courses and
// practice sets each plan opens, members and sales. Course Access, practice set
// pricing and purchases are only read here, never written.

const audit = (entity, entityId, action, after, req) =>
  getGlobalCollections()
    .membershipAudit.insertOne({
      entity,
      entityId: String(entityId),
      action,
      after: after || null,
      by: req.userID || null,
      byEmail: req.email || null,
      at: new Date(),
    })
    .catch((err) => console.error("[memberships] audit write failed:", err.message));

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const USER_FIELDS = { firstName: 1, lastName: 1, email: 1 };

// Students on each plan right now; renewals of one student count once.
const activeCounts = async () => {
  const now = new Date();
  const counts = await getGlobalCollections()
    .memberships.aggregate([
      { $match: { status: "active", startsAt: { $lte: now }, expiresAt: { $gt: now } } },
      { $group: { _id: "$planKey", users: { $addToSet: "$userId" } } },
      { $project: { count: { $size: "$users" } } },
    ])
    .toArray();
  return new Map(counts.map((c) => [c._id, c.count]));
};

// ─── Plans ───────────────────────────────────────────────────────────────────

// GET /membership-plans — the three plans with their active member counts and
// how many items each opens, so the page can warn about an incomplete setup.
module.exports.getPlans = async (req, res) => {
  try {
    const [plans, counts, tags] = await Promise.all([
      loadPlans(),
      activeCounts(),
      getGlobalCollections().membershipContent.find({}).toArray(),
    ]);
    const tagged = (key, itemType) => tags.filter((t) => t.minPlan === key && t.itemType === itemType).length;
    res.status(200).json({
      data: plans.map((p) => ({
        ...p,
        members: counts.get(p.key) || 0,
        courses: tagged(p.key, "course"),
        practiceSets: tagged(p.key, "practiceSet"),
      })),
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// PUT /membership-plans/:key
module.exports.savePlan = async (req, res) => {
  try {
    const { err, data } = rules.validatePlan(req.params.key, req.body);
    if (err) return res.status(400).json({ err });
    await getGlobalCollections().membershipPlans.updateOne(
      { key: req.params.key },
      { $set: { ...data, key: req.params.key, updatedAt: new Date(), updatedBy: req.userID || null } },
      { upsert: true }
    );
    audit("plan", req.params.key, "save", data, req);
    res.status(200).json({ data: { ...data, key: req.params.key } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// ─── Content ─────────────────────────────────────────────────────────────────

// GET /membership-content — every course and practice set with its plan tag.
module.exports.getContent = async (req, res) => {
  try {
    const { internshipsCollection, courseAccess, membershipContent } = getGlobalCollections();
    const [courses, configs, sets, tags] = await Promise.all([
      internshipsCollection
        .find({ type: "course" }, { projection: { title: 1, category: 1, price: 1, discountedPrice: 1, pricing: 1 } })
        .toArray(),
      courseAccess.find({}).toArray(),
      findInAllTenants("practiceSets", {}, "find"),
      membershipContent.find({}).toArray(),
    ]);
    const configsById = new Map(configs.map((c) => [String(c.courseId), c]));
    const minPlans = new Map(tags.map((t) => [rules.tagKey(t.itemType, t.itemId), t.minPlan]));

    const courseRows = courses.map((course) => {
      const id = course._id.toString();
      const config = configsById.get(id) || courseRules.defaultConfig(id, course);
      return {
        itemType: "course",
        itemId: id,
        title: course.title,
        category: course.category || "",
        access: config.access,
        visible: config.visibility === "published",
        price: courseRules.coursePrice(course),
        minPlan: minPlans.get(rules.tagKey("course", id)) || null,
      };
    });
    const setRows = sets.map((set) => {
      const id = set._id.toString();
      return {
        itemType: "practiceSet",
        itemId: id,
        title: set.title,
        category: set.category || "",
        access: set.plan,
        visible: set.status === "published",
        price: Number(set.price) || 0,
        minPlan: minPlans.get(rules.tagKey("practiceSet", id)) || null,
      };
    });
    const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));
    res.status(200).json({ data: { courses: courseRows.sort(byTitle), practiceSets: setRows.sort(byTitle) } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// PUT /membership-content — { items: [{ itemType, itemId }], minPlan }.
// A null minPlan takes the items out of every plan.
module.exports.saveContent = async (req, res) => {
  try {
    const { err, data } = rules.validateTags(req.body);
    if (err) return res.status(400).json({ err });
    const now = new Date();
    await getGlobalCollections().membershipContent.bulkWrite(
      data.items.map(({ itemType, itemId }) =>
        data.minPlan
          ? {
              updateOne: {
                filter: { itemType, itemId },
                update: { $set: { itemType, itemId, minPlan: data.minPlan, updatedAt: now } },
                upsert: true,
              },
            }
          : { deleteOne: { filter: { itemType, itemId } } }
      )
    );
    audit("content", "bulk", "tag", data, req);
    res.status(200).json({ data: { updated: data.items.length } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// ─── Members ─────────────────────────────────────────────────────────────────

// GET /memberships?status=active|ended|all&plan=&search=&page=&limit=
module.exports.getMembers = async (req, res) => {
  try {
    const { memberships, mainDBusers } = getGlobalCollections();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const now = new Date();
    const query = {};
    if (rules.PLAN_KEYS.includes(req.query.plan)) query.planKey = req.query.plan;
    if (req.query.status === "active") Object.assign(query, { status: "active", expiresAt: { $gt: now } });
    if (req.query.status === "ended") query.$or = [{ status: { $ne: "active" } }, { expiresAt: { $lte: now } }];

    const search = String(req.query.search || "").trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      const matches = await mainDBusers
        .find({ $or: [{ email: pattern }, { firstName: pattern }, { lastName: pattern }] }, { projection: { _id: 1 } })
        .limit(200)
        .toArray();
      query.userId = { $in: matches.map((u) => u._id.toString()) };
    }

    const [items, total] = await Promise.all([
      memberships.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      memberships.countDocuments(query),
    ]);
    const userIds = [...new Set(items.map((m) => m.userId))].filter((id) => ObjectId.isValid(id));
    const users = await mainDBusers
      .find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }, { projection: USER_FIELDS })
      .toArray();
    const usersById = new Map(users.map((u) => [u._id.toString(), u]));

    res.status(200).json({
      data: items.map((m) => {
        const user = usersById.get(m.userId);
        return {
          ...m,
          name: [user?.firstName, user?.lastName].filter(Boolean).join(" "),
          email: user?.email || "",
        };
      }),
      total,
      page,
      limit,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

const validDays = (value) => {
  const days = Math.floor(Number(value));
  return days >= 1 && days <= rules.MAX_DAYS ? days : null;
};

// PUT /memberships/:id/extend — { days }
module.exports.extendMembership = async (req, res) => {
  try {
    const days = validDays(req.body.days);
    if (!days) return res.status(400).json({ err: `Days must be between 1 and ${rules.MAX_DAYS}` });
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ err: "Membership not found" });

    const { memberships } = getGlobalCollections();
    const doc = await memberships.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ err: "Membership not found" });
    if (doc.status !== "active") return res.status(400).json({ err: "This membership has ended" });

    const from = Math.max(Date.now(), new Date(doc.expiresAt).getTime());
    const expiresAt = new Date(from + days * rules.DAY);
    await memberships.updateOne({ _id: doc._id }, { $set: { expiresAt }, $inc: { days } });
    audit("membership", doc._id, "extend", { days, expiresAt }, req);
    res.status(200).json({ data: { expiresAt } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// DELETE /memberships/:id — ends the student's plan now, including queued
// renewals. Records stay for history; no money is refunded here.
module.exports.revokeMembership = async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ err: "Membership not found" });
    const { memberships } = getGlobalCollections();
    const doc = await memberships.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ err: "Membership not found" });
    await memberships.updateMany(
      { userId: doc.userId, planKey: doc.planKey, status: "active" },
      { $set: { status: "revoked", revokedAt: new Date(), revokedBy: req.email || req.userID || null } }
    );
    audit("membership", doc._id, "revoke", { userId: doc.userId, planKey: doc.planKey }, req);
    res.status(200).json({ data: { revoked: true } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// ─── Sales ───────────────────────────────────────────────────────────────────

// GET /membership-stats — active members, plans ending soon and revenue per plan.
module.exports.getStats = async (req, res) => {
  try {
    const { memberships, payment } = getGlobalCollections();
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * rules.DAY);
    const [counts, endingSoon, sales] = await Promise.all([
      activeCounts(),
      memberships.countDocuments({ status: "active", expiresAt: { $gt: now, $lte: soon } }),
      payment
        .aggregate([
          { $match: { itemType: "membership" } },
          { $group: { _id: "$itemId", orders: { $sum: 1 }, revenue: { $sum: "$amountCharged" } } },
        ])
        .toArray(),
    ]);
    const salesByPlan = new Map(sales.map((s) => [s._id, s]));
    res.status(200).json({
      data: {
        endingSoon,
        plans: rules.PAID_PLAN_KEYS.map((key) => ({
          key,
          active: counts.get(key) || 0,
          orders: salesByPlan.get(key)?.orders || 0,
          revenue: salesByPlan.get(key)?.revenue || 0,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
