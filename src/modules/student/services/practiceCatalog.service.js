const { ObjectId } = require("mongodb");
const { connectTodb, getGlobalCollections } = require("../../../shared/db/connection");
const { findInAllTenants } = require("./practice.service");
const { helpers } = require("../../admin/services/practiceSets.service");

const { toObjectId, buildQuestionQuery, sortSets, withTopicDetails, withBundleSummary } = helpers;

// Practice sets/bundles are created by the platform admin, so — like the
// question bank — they are read from every tenant that holds practice content.
const loadSetsByIds = (ids) =>
  ids.length ? findInAllTenants("practiceSets", { _id: { $in: ids } }, "find") : [];
const loadBundlesByIds = (ids) =>
  ids.length ? findInAllTenants("practiceBundles", { _id: { $in: ids } }, "find") : [];

// enrolledData entry types written by the payment service on purchase.
const PURCHASE_TYPES = { set: "practiceSet", bundle: "practiceBundle" };

/**
 * Active (paid, not expired) practice purchases of a student.
 * Returns { sets: Map<id, expiresAt|null>, bundles: Map<id, expiresAt|null> }
 * where null means lifetime access.
 */
const getPurchases = async (userId) => {
  const result = { sets: new Map(), bundles: new Map() };
  if (!ObjectId.isValid(userId)) return result;

  const { mainDBusers } = getGlobalCollections();
  const user = await mainDBusers.findOne(
    { _id: new ObjectId(userId) },
    { projection: { enrolledData: 1 } }
  );

  const now = Date.now();
  for (const entry of user?.enrolledData || []) {
    const target =
      entry.type === PURCHASE_TYPES.set
        ? result.sets
        : entry.type === PURCHASE_TYPES.bundle
          ? result.bundles
          : null;
    if (!target || entry.active === false) continue;

    const expiresAt = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
    if (expiresAt && expiresAt <= now) continue;

    // A renewal adds a second entry; keep whichever lasts longest.
    const key = String(entry.refId);
    const current = target.get(key);
    if (current === undefined || (current !== null && (expiresAt === null || expiresAt > current))) {
      target.set(key, expiresAt);
    }
  }
  return result;
};

/** Why (and until when) a student may open a practice set. */
const getSetAccess = (set, purchases, ownedBundles) => {
  if (set.plan === "free") return { unlocked: true, reason: "free", expiresAt: null };

  const id = set._id.toString();
  if (purchases.sets.has(id)) {
    return { unlocked: true, reason: "purchased", expiresAt: purchases.sets.get(id) };
  }

  const viaBundle = ownedBundles.find((b) => (b.setIds || []).some((sid) => sid.toString() === id));
  if (viaBundle) {
    return {
      unlocked: true,
      reason: "bundle",
      bundleTitle: viaBundle.title,
      expiresAt: purchases.bundles.get(viaBundle._id.toString()),
    };
  }

  return { unlocked: false, reason: "locked", expiresAt: null };
};

const getOwnedBundles = (purchases) =>
  loadBundlesByIds([...purchases.bundles.keys()].map((id) => new ObjectId(id)));

// Admin-only bookkeeping that students never need to see.
const toStudentSet = ({ availableQuestions, createdBy, ...set }) => set;
const toStudentBundle = ({ createdBy, ...bundle }) => bundle;

// GET /practice-catalog
module.exports.getPracticeCatalog = async (req, res) => {
  try {
    const purchases = await getPurchases(req.userID);
    const [publishedSets, publishedBundles, ownedBundles] = await Promise.all([
      findInAllTenants("practiceSets", { status: "published" }, "find"),
      findInAllTenants("practiceBundles", { status: "published" }, "find"),
      getOwnedBundles(purchases),
    ]);

    // Anything the student has paid for stays visible even if the admin
    // later unpublishes it.
    const shownIds = new Set(publishedSets.map((s) => s._id.toString()));
    const ownedSetIds = [
      ...purchases.sets.keys(),
      ...ownedBundles.flatMap((b) => (b.setIds || []).map((id) => id.toString())),
    ].filter((id) => !shownIds.has(id));
    const extraSets = await loadSetsByIds([...new Set(ownedSetIds)].map((id) => new ObjectId(id)));

    const sets = await withTopicDetails(sortSets([...publishedSets, ...extraSets]));

    const bundleIds = new Set(publishedBundles.map((b) => b._id.toString()));
    const bundles = await withBundleSummary(
      [...publishedBundles, ...ownedBundles.filter((b) => !bundleIds.has(b._id.toString()))].sort(
        (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
      ),
      loadSetsByIds
    );

    // Check if the student has completed attempts for practice sets (e.g. company-wise tests)
    let userAttemptedTestIds = new Set();
    try {
      if (req.tenantDB && req.userID) {
        const { student, mockTestAttempts } = connectTodb(req.tenantDB);
        const findStudent = await student.findOne({ globalId: req.userID });
        if (findStudent && mockTestAttempts) {
          const attempts = await mockTestAttempts
            .find({ userId: findStudent._id }, { projection: { testId: 1 } })
            .toArray();
          attempts.forEach((a) => {
            if (a.testId) userAttemptedTestIds.add(String(a.testId));
          });
        }
      }
    } catch (err) {
      console.error("Error fetching user attempts in getPracticeCatalog:", err);
    }

    res.status(200).json({
      data: {
        sets: sets.map((set) => {
          const setIdStr = set._id.toString();
          return {
            ...toStudentSet(set),
            hasCompletedTest: userAttemptedTestIds.has(setIdStr),
            access: getSetAccess(set, purchases, ownedBundles),
          };
        }),
        bundles: bundles.map((bundle) => {
          const id = bundle._id.toString();
          return {
            ...toStudentBundle(bundle),
            access: purchases.bundles.has(id)
              ? { unlocked: true, reason: "purchased", expiresAt: purchases.bundles.get(id) }
              : { unlocked: false, reason: "locked", expiresAt: null },
          };
        }),
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// POST /practice-sets/:id/start
// The server decides the questions, their count and the time limit — the
// client only names the set, so paid questions can't be pulled without access.
module.exports.startPracticeSet = async (req, res) => {
  const { pracSessions, student } = connectTodb(req.tenantDB);
  try {
    const setId = toObjectId(req.params.id);
    if (!setId) return res.status(400).json({ err: "Invalid practice set" });

    const set = await findInAllTenants("practiceSets", { _id: setId }, "findOne");
    if (!set) return res.status(404).json({ err: "Practice set not found" });

    const purchases = await getPurchases(req.userID);
    const ownedBundles = await getOwnedBundles(purchases);
    const access = getSetAccess(set, purchases, ownedBundles);

    // Unpublished sets stay open only to students who already paid for them.
    if (set.status !== "published" && !(access.unlocked && access.reason !== "free")) {
      return res.status(404).json({ err: "This practice set is no longer available" });
    }
    if (!access.unlocked) {
      return res.status(402).json({
        err: "Buy this practice set to start practising",
        code: "PAYMENT_REQUIRED",
      });
    }

    const selections = set.topics || [];
    const questions = selections.length
      ? await findInAllTenants(
          "questions",
          buildQuestionQuery(selections, { difficulty: set.difficulty, category: set.category }),
          "find",
          { limit: set.questionCount }
        )
      : [];
    if (!questions.length) {
      return res.status(404).json({ err: "No questions are available in this practice set yet" });
    }

    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }

    const session = await pracSessions.insertOne({
      userId: req.userID,
      refId: set._id.toString(),
      type: "practiceSet",
      practiceSetId: set._id.toString(),
      practiceSetTitle: set.title,
      difficulty: set.difficulty,
      timeMinutes: set.timeMinutes,
      questionsData: questions,
      createdAt: new Date().getTime(),
    });

    await student.updateOne(
      { globalId: req.userID },
      { $addToSet: { practiceSessions: session.insertedId.toString() } }
    );

    // Subject names let the coding workspace pick a sensible default language.
    const [detailed] = await withTopicDetails([set]);
    const subjectTitles = [...new Set(detailed.topics.map((t) => t.subjectTitle))];

    // Same shape as /startPractice so the existing test player can run it.
    res.status(200).json({
      msg: "Practice started successfully",
      data: session,
      questionsData: questions,
      count: questions.length,
      timeMinutes: set.timeMinutes,
      practiceSet: {
        _id: set._id,
        title: set.title,
        category: set.category,
        level: set.level,
        difficulty: set.difficulty,
        subjectTitles,
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getPurchases = getPurchases;
module.exports.PURCHASE_TYPES = PURCHASE_TYPES;
