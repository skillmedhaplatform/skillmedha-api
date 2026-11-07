const { ObjectId } = require("mongodb");
const { getGlobalCollections } = require("../../../shared/db/connection");
const rules = require("../../../shared/utils/membership");
const courseRules = require("../../../shared/utils/courseAccess");
const { findInAllTenants } = require("./practice.service");

// Student side of Free / Premium / Pro plans. Memberships live in their own
// collection rather than users.enrolledData, because activePurchases() reads any
// unknown enrolledData type as a course purchase.

const loadPlans = async () => rules.mergePlans(await getGlobalCollections().membershipPlans.find({}).toArray());

const loadMemberships = async (userId) => {
  if (!ObjectId.isValid(userId)) return [];
  return getGlobalCollections().memberships.find({ userId: String(userId) }).toArray();
};

/**
 * Plan answers for one student, shared by the course and practice catalogues.
 * accessFor: { expiresAt, planKey, planName } when their plan opens the item.
 * upgradeFor: the plan to advertise on a locked item — only a plan that is on.
 */
const loadPlanContext = async (userId) => {
  const [plans, docs, tags] = await Promise.all([
    loadPlans(),
    loadMemberships(userId),
    getGlobalCollections().membershipContent.find({}).toArray(),
  ]);
  const current = rules.currentMembership(docs);
  const planName = (key) => plans.find((p) => p.key === key)?.name || key;
  const minPlans = new Map(tags.map((t) => [rules.tagKey(t.itemType, t.itemId), t.minPlan]));

  const accessFor = (itemType, itemId) => {
    const minPlan = minPlans.get(rules.tagKey(itemType, itemId));
    if (!rules.planCovers(current, minPlan)) return null;
    return { expiresAt: current.expiresAt, planKey: current.planKey, planName: planName(current.planKey) };
  };
  const upgradeFor = (itemType, itemId) => {
    const minPlan = minPlans.get(rules.tagKey(itemType, itemId));
    const plan = plans.find((p) => p.key === minPlan && p.status === "published");
    if (!plan) return null;
    const prices = (plan.options || []).map((o) => o.price);
    return { key: plan.key, name: plan.name, fromPrice: prices.length ? Math.min(...prices) : null };
  };

  return { current, accessFor, upgradeFor };
};

/**
 * What each plan opens, so students can see it before buying. Hidden courses
 * and unpublished sets are left out. Returns Map<planKey, { courses, practiceSets }>.
 */
const loadPlanItems = async () => {
  const { membershipContent, internshipsCollection, courseAccess } = getGlobalCollections();
  const tags = await membershipContent.find({}).toArray();
  const idsOf = (itemType) => tags.filter((t) => t.itemType === itemType).map((t) => new ObjectId(t.itemId));
  const [courses, configs, sets] = await Promise.all([
    internshipsCollection
      .find({ _id: { $in: idsOf("course") }, type: "course" }, { projection: { title: 1, price: 1, discountedPrice: 1, pricing: 1 } })
      .toArray(),
    courseAccess.find({ courseId: { $in: tags.map((t) => t.itemId) } }).toArray(),
    findInAllTenants("practiceSets", { _id: { $in: idsOf("practiceSet") }, status: "published" }, "find"),
  ]);
  const configsById = new Map(configs.map((c) => [String(c.courseId), c]));
  const minPlans = new Map(tags.map((t) => [rules.tagKey(t.itemType, t.itemId), t.minPlan]));

  const items = new Map(rules.PAID_PLAN_KEYS.map((key) => [key, { courses: [], practiceSets: [] }]));
  for (const course of courses) {
    const id = course._id.toString();
    const config = configsById.get(id) || courseRules.defaultConfig(id, course);
    const planItems = items.get(minPlans.get(rules.tagKey("course", id)));
    if (planItems && config.visibility === "published") planItems.courses.push({ _id: id, title: course.title });
  }
  for (const set of sets) {
    const id = set._id.toString();
    const planItems = items.get(minPlans.get(rules.tagKey("practiceSet", id)));
    if (planItems) planItems.practiceSets.push({ _id: id, title: set.title });
  }
  return items;
};

// GET /membership — plans on offer (with what this student would pay), their
// current plan and their membership history.
module.exports.getMembership = async (req, res) => {
  try {
    const [plans, docs, items] = await Promise.all([loadPlans(), loadMemberships(req.userID), loadPlanItems()]);
    const current = rules.currentMembership(docs);
    const visible = plans.filter((p) => p.status === "published");
    const nameOf = (key) => plans.find((p) => p.key === key)?.name || key;

    res.status(200).json({
      data: {
        // Free alone means no paid plan is on yet.
        enabled: visible.some((p) => p.key !== "free"),
        current: current ? { ...current, name: nameOf(current.planKey) } : null,
        plans: visible.map((p) => ({
          key: p.key,
          rank: p.rank,
          name: p.name,
          description: p.description,
          features: p.features,
          highlighted: !!p.highlighted,
          blocked: rules.purchaseBlock(current, p.key),
          options: (p.options || []).map((o) => ({ ...o, ...rules.quote(o, docs, p.key) })),
          courses: items.get(p.key)?.courses || [],
          practiceSets: items.get(p.key)?.practiceSets || [],
        })),
        history: docs
          .filter((d) => d.status !== "revoked")
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .map((d) => ({
            _id: d._id,
            planKey: d.planKey,
            planName: nameOf(d.planKey),
            source: d.source,
            status: d.status,
            days: d.days,
            amountCharged: d.amountCharged,
            startsAt: d.startsAt,
            expiresAt: d.expiresAt,
          })),
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.loadPlans = loadPlans;
module.exports.loadMemberships = loadMemberships;
module.exports.loadPlanContext = loadPlanContext;
