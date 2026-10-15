const { ObjectId } = require("mongodb");
const { connectTodb, getGlobalCollections } = require("../../../shared/db/connection");
const { archiveAndDeleteOne } = require("../../../shared/utils/archive.service");
const { findInAllTenants } = require("../../student/services/practice.service");

// A practice set is a sellable card built on top of the existing question
// bank: it points at question sources (whole subjects, topics or subtopics)
// and decides how many random questions a student gets, how long they have,
// and what it costs. A bundle groups several practice sets under one price.

const PLANS = ["free", "premium"];
const LEVELS = ["beginner", "intermediate", "advanced", "pro"];
// "company" sets draw from the company-wise tests (Admin → Practice → Company-wise).
const CATEGORIES = ["nontechnical", "technical", "coding", "company"];
const STATUSES = ["draft", "published"];
// Same values the question editor stores on each question; "mixed" means
// questions of every difficulty.
const DIFFICULTIES = ["easy", "medium", "hard", "mixed"];

const toObjectId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// Questions store their ids as ObjectIds, but older bulk uploads may hold the
// plain string, so match both forms.
const idMatch = (id) => ({ $in: [new ObjectId(id), id.toString()] });

// Coding questions need the code editor; every other type runs in the
// multiple-choice player. A set only ever pulls questions its player can show.
const CODING_TYPE = "Coding Question";

// Where a set's questions come from. Each selection is one of
//   { subjectId }                       → every question in the subject
//   { subjectId, topicId }              → every question in the topic (incl. its subtopics)
//   { subjectId, topicId, subTopicId }  → only that subtopic
//   { subjectId, section }              → one section of a company test
// Company-test questions use the company test's id as their subjectId and a
// sectionName ("Aptitude", "Reasoning", …), so a whole company test is simply
// { subjectId: companyTestId }. Coding subjects have no topics at all, so
// "whole subject" is the only option there.
const sourceClause = (sel) => {
  if (sel.subTopicId) return { subTopicId: idMatch(sel.subTopicId) };
  if (sel.topicId) return { topicId: idMatch(sel.topicId) };
  if (sel.section) return { subjectId: idMatch(sel.subjectId), sectionName: sel.section };
  return { subjectId: idMatch(sel.subjectId) };
};

// Difficulty is stored with inconsistent casing ("Medium" / "medium"), and
// many older / bulk-uploaded questions have none at all. The question editor
// shows those as "Medium", so they count as medium here too.
const difficultyClause = (difficulty) => {
  if (!difficulty || difficulty === "mixed") return null;
  const matchesLevel = { difficulty: { $regex: new RegExp(`^${difficulty}$`, "i") } };
  if (difficulty !== "medium") return matchesLevel;
  return { $or: [matchesLevel, { difficulty: { $exists: false } }, { difficulty: null }, { difficulty: "" }] };
};

const buildQuestionQuery = (selections, { difficulty, category } = {}) => {
  const clauses = [{ $or: selections.map(sourceClause) }];
  if (category === "coding") clauses.push({ questionType: CODING_TYPE });
  else if (category) clauses.push({ questionType: { $ne: CODING_TYPE } });
  const diff = difficultyClause(difficulty);
  if (diff) clauses.push(diff);
  return { $and: clauses };
};

const countQuestions = (selections, options) =>
  selections.length
    ? findInAllTenants("questions", buildQuestionQuery(selections, options), "countDocuments")
    : 0;

const selectionKey = (sel) =>
  [sel.subjectId, sel.topicId, sel.subTopicId, sel.section].map((id) => (id ? id.toString() : "")).join("|");

// Validates raw selections from the client, drops duplicates, and drops any
// selection already covered by a wider one (a topic inside a chosen subject,
// a subtopic inside a chosen topic). Returns { err } or { selections }.
const normaliseSelections = (raw) => {
  const list = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const subjectId = toObjectId(item?.subjectId);
    const topicId = item?.topicId ? toObjectId(item.topicId) : null;
    const subTopicId = item?.subTopicId ? toObjectId(item.subTopicId) : null;
    const section = typeof item?.section === "string" ? item.section.trim() : "";
    if (!subjectId || (item?.topicId && !topicId) || (item?.subTopicId && !subTopicId)) {
      return { err: "One of the selected subjects, topics or subtopics is invalid" };
    }
    if (subTopicId && !topicId) return { err: "A subtopic must be selected together with its topic" };
    if (section && topicId) return { err: "A company section can't be combined with a topic" };
    const sel = { subjectId };
    if (topicId) sel.topicId = topicId;
    if (subTopicId) sel.subTopicId = subTopicId;
    if (section) sel.section = section;
    list.push(sel);
  }

  const wholeSubjects = new Set(
    list.filter((s) => !s.topicId && !s.section).map((s) => s.subjectId.toString())
  );
  const wholeTopics = new Set(list.filter((s) => s.topicId && !s.subTopicId).map((s) => s.topicId.toString()));
  const seen = new Set();
  const selections = list.filter((s) => {
    if ((s.topicId || s.section) && wholeSubjects.has(s.subjectId.toString())) return false;
    if (s.subTopicId && wholeTopics.has(s.topicId.toString())) return false;
    const key = selectionKey(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { selections };
};

// Student-facing order: Beginner → Pro, then Easy → Hard, newest first.
const sortSets = (sets) =>
  [...sets].sort(
    (a, b) =>
      LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) ||
      DIFFICULTIES.indexOf(a.difficulty || "mixed") - DIFFICULTIES.indexOf(b.difficulty || "mixed") ||
      (b.createdAt || 0) - (a.createdAt || 0)
  );

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const uniqueIds = (sets, field) => [
  ...new Set(
    sets.flatMap((s) => (s.topics || []).map((t) => t[field]?.toString()).filter(Boolean))
  ),
];

const titlesById = async (collection, ids) => {
  if (!ids.length) return new Map();
  const docs = await findInAllTenants(collection, { _id: { $in: ids.map((id) => new ObjectId(id)) } }, "find");
  return new Map(docs.map((d) => [d._id.toString(), d.title]));
};

// Company tests live in one global collection rather than per tenant.
const loadCompanyTests = async (ids) => {
  if (!ids.length) return new Map();
  const { companyTests } = getGlobalCollections();
  const docs = await companyTests.find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }).toArray();
  return new Map(docs.map((d) => [d._id.toString(), d]));
};

// Attach subject / topic / subtopic / company titles so the admin list and
// the student card can show "Topics covered" without one call per item.
// `topicTitle` is the display label of each selection and `scope` says what
// it is. Company sets also get `companyBrand` (title, initials, colour) for
// the card artwork.
const withTopicDetails = async (sets) => {
  const subjectIds = uniqueIds(sets, "subjectId");
  const [subjectTitles, topicTitles, subTopicTitles, companies] = await Promise.all([
    titlesById("subjects", subjectIds),
    titlesById("topics", uniqueIds(sets, "topicId")),
    titlesById("subtopics", uniqueIds(sets, "subTopicId")),
    loadCompanyTests(subjectIds),
  ]);

  return sets.map((set) => {
    let companyBrand = null;
    const topics = (set.topics || []).map((t) => {
      const company = companies.get(t.subjectId.toString());
      if (company && !companyBrand) {
        companyBrand = { title: company.title, initials: company.initials || "", color: company.color || "" };
      }
      const subjectTitle =
        subjectTitles.get(t.subjectId.toString()) || company?.title || "Deleted subject";
      const parentTopicTitle = t.topicId ? topicTitles.get(t.topicId.toString()) || "Deleted topic" : null;
      const scope = t.subTopicId
        ? "subtopic"
        : t.topicId
          ? "topic"
          : t.section
            ? "section"
            : company
              ? "company"
              : "subject";
      const topicTitle =
        scope === "subtopic"
          ? subTopicTitles.get(t.subTopicId.toString()) || "Deleted subtopic"
          : scope === "topic"
            ? parentTopicTitle
            : scope === "section"
              ? t.section
              : `All of ${subjectTitle}`;
      return {
        subjectId: t.subjectId,
        ...(t.topicId ? { topicId: t.topicId } : {}),
        ...(t.subTopicId ? { subTopicId: t.subTopicId } : {}),
        ...(t.section ? { section: t.section } : {}),
        scope,
        subjectTitle,
        parentTopicTitle: scope === "subtopic" ? parentTopicTitle : null,
        topicTitle,
      };
    });
    return { ...set, topics, companyBrand };
  });
};

// Validates the request body and returns either { err } or { data } with
// every field normalised to the stored shape.
const buildSetPayload = async (body) => {
  const title = String(body.title || "").trim();
  if (!title) return { err: "Title is required" };

  const plan = body.plan;
  if (!PLANS.includes(plan)) return { err: "Plan must be free or premium" };

  const level = body.level;
  if (!LEVELS.includes(level)) return { err: `Level must be one of: ${LEVELS.join(", ")}` };

  const category = body.category;
  if (!CATEGORIES.includes(category)) return { err: `Category must be one of: ${CATEGORIES.join(", ")}` };

  const difficulty = body.difficulty || "mixed";
  if (!DIFFICULTIES.includes(difficulty)) return { err: "Difficulty must be easy, medium, hard or mixed" };

  const status = STATUSES.includes(body.status) ? body.status : "draft";

  const { err: selectionErr, selections: topics } = normaliseSelections(body.topics);
  if (selectionErr) return { err: selectionErr };
  if (!topics.length) return { err: "Select at least one subject, topic or subtopic" };

  const questionCount = Math.floor(toNumber(body.questionCount));
  if (questionCount < 1) return { err: "Number of questions must be at least 1" };

  const timeMinutes = Math.floor(toNumber(body.timeMinutes));
  if (timeMinutes < 1) return { err: "Time limit must be at least 1 minute" };

  const availableQuestions = await countQuestions(topics, { difficulty, category });
  if (questionCount > availableQuestions) {
    const which = difficulty === "mixed" ? "" : `${difficulty} `;
    const kind = category === "coding" ? "coding " : "";
    return {
      err: `Only ${availableQuestions} ${which}${kind}questions exist in the selection; lower the number of questions, add more topics or change the difficulty`,
    };
  }

  let price = 0;
  let mrp = 0;
  if (plan === "premium") {
    price = toNumber(body.price);
    mrp = toNumber(body.mrp, price) || price;
    if (price <= 0) return { err: "Premium practice sets need a price greater than 0" };
    if (mrp < price) return { err: "MRP cannot be lower than the offer price" };
  }

  const validityDays = Math.max(0, Math.floor(toNumber(body.validityDays)));

  return {
    data: {
      title,
      description: String(body.description || "").trim(),
      thumbnail: String(body.thumbnail || "").trim(),
      plan,
      level,
      difficulty,
      category,
      topics,
      questionCount,
      timeMinutes,
      availableQuestions,
      price,
      mrp,
      validityDays,
      status,
    },
  };
};

// ─── Practice Sets ────────────────────────────────────────────────────────────

// GET /practice-sets/company-sources
// Company tests with their sections and question counts per difficulty, built
// from the questions that actually exist (the test's own `sections` list can
// mention sections that have no questions yet). Coding questions are left out:
// company sets run in the multiple-choice player.
module.exports.getCompanySources = async (req, res) => {
  try {
    const { companyTests } = getGlobalCollections();
    const tests = await companyTests.find({}).sort({ title: 1 }).toArray();
    const ids = tests.flatMap((t) => [t._id, t._id.toString()]);
    const questions = ids.length
      ? await findInAllTenants(
          "questions",
          { subjectId: { $in: ids }, questionType: { $ne: CODING_TYPE } },
          "find"
        )
      : [];

    const emptyCounts = () => ({ totalQuestions: 0, easyQuestions: 0, mediumQuestions: 0, hardQuestions: 0 });
    // Same rule as difficultyClause: no difficulty counts as medium.
    const addTo = (counts, q) => {
      const level = q.difficulty ? String(q.difficulty).toLowerCase() : "medium";
      counts.totalQuestions += 1;
      if (counts[`${level}Questions`] !== undefined) counts[`${level}Questions`] += 1;
    };

    const byCompany = new Map(tests.map((t) => [t._id.toString(), { counts: emptyCounts(), sections: new Map() }]));
    for (const q of questions) {
      const entry = byCompany.get(q.subjectId.toString());
      if (!entry) continue;
      addTo(entry.counts, q);
      const name = String(q.sectionName || "").trim();
      if (!name) continue;
      if (!entry.sections.has(name)) entry.sections.set(name, emptyCounts());
      addTo(entry.sections.get(name), q);
    }

    res.status(200).json({
      data: tests.map((t) => {
        const entry = byCompany.get(t._id.toString());
        return {
          _id: t._id,
          title: t.title,
          initials: t.initials,
          color: t.color,
          hiringType: t.hiringType,
          patternName: t.patternName,
          ...entry.counts,
          sections: [...entry.sections.entries()].map(([name, counts]) => ({ name, ...counts })),
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getQuestionCountForTopics = async (req, res) => {
  try {
    const { err, selections } = normaliseSelections(req.body.selections);
    if (err) return res.status(400).json({ err });
    const difficulty = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : "mixed";
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : undefined;
    const count = await countQuestions(selections, { difficulty, category });
    res.status(200).json({ data: { count } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getPracticeSets = async (req, res) => {
  const { practiceSets } = connectTodb(req.tenantDB);
  try {
    const { category, plan, level, difficulty, status, search } = req.query;
    const query = {};
    if (CATEGORIES.includes(category)) query.category = category;
    if (PLANS.includes(plan)) query.plan = plan;
    if (LEVELS.includes(level)) query.level = level;
    if (DIFFICULTIES.includes(difficulty)) query.difficulty = difficulty;
    if (STATUSES.includes(status)) query.status = status;
    if (search?.trim()) query.title = { $regex: escapeRegex(search.trim()), $options: "i" };

    const sets = await practiceSets.find(query).toArray();
    res.status(200).json({ data: await withTopicDetails(sortSets(sets)) });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getPracticeSet = async (req, res) => {
  const { practiceSets } = connectTodb(req.tenantDB);
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid practice set id" });

    const set = await practiceSets.findOne({ _id: id });
    if (!set) return res.status(404).json({ err: "Practice set not found" });

    const [detailed] = await withTopicDetails([set]);
    res.status(200).json({ data: detailed });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.createPracticeSet = async (req, res) => {
  const { practiceSets } = connectTodb(req.tenantDB);
  try {
    const { err, data } = await buildSetPayload(req.body);
    if (err) return res.status(400).json({ err });

    const duplicate = await practiceSets.findOne({
      title: { $regex: `^${escapeRegex(data.title)}$`, $options: "i" },
    });
    if (duplicate) return res.status(400).json({ err: "A practice set with this title already exists" });

    const doc = { ...data, createdBy: req.userID || null, createdAt: Date.now(), updatedAt: Date.now() };
    const result = await practiceSets.insertOne(doc);
    res.status(201).json({ msg: "Practice set created successfully", data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updatePracticeSet = async (req, res) => {
  const { practiceSets } = connectTodb(req.tenantDB);
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid practice set id" });

    const { err, data } = await buildSetPayload(req.body);
    if (err) return res.status(400).json({ err });

    const duplicate = await practiceSets.findOne({
      _id: { $ne: id },
      title: { $regex: `^${escapeRegex(data.title)}$`, $options: "i" },
    });
    if (duplicate) return res.status(400).json({ err: "A practice set with this title already exists" });

    const result = await practiceSets.updateOne({ _id: id }, { $set: { ...data, updatedAt: Date.now() } });
    if (result.matchedCount === 0) return res.status(404).json({ err: "Practice set not found" });

    res.status(200).json({ msg: "Practice set updated successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deletePracticeSet = async (req, res) => {
  const { practiceSets, practiceBundles } = connectTodb(req.tenantDB);
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid practice set id" });

    // Deleting a set that a bundle still sells would silently shrink what
    // students paid for, so make the admin remove it from bundles first.
    const usedIn = await practiceBundles.find({ setIds: id }).project({ title: 1 }).toArray();
    if (usedIn.length) {
      return res.status(400).json({
        err: `Remove this set from these bundles first: ${usedIn.map((b) => b.title).join(", ")}`,
      });
    }

    const result = await archiveAndDeleteOne(practiceSets, { _id: id }, {
      deletedBy: req.userID || null,
      reason: req.body?.reason || null,
    });
    if (result.deletedCount === 0) return res.status(404).json({ err: "Practice set not found" });

    res.status(200).json({ msg: "Practice set deleted successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// ─── Practice Bundles ─────────────────────────────────────────────────────────

// Everything on the bundle card except title/price is derived from the sets
// inside it, so it can never drift out of date when a set is edited.
// `loadSets(objectIds)` returns the set documents: the admin reads its own
// tenant, the student catalog reads every tenant that holds practice content.
const withBundleSummary = async (bundles, loadSets) => {
  const setIds = [...new Set(bundles.flatMap((b) => (b.setIds || []).map((id) => id.toString())))];
  const sets = setIds.length ? await loadSets(setIds.map((id) => new ObjectId(id))) : [];
  const detailedSets = await withTopicDetails(sets);
  const setsById = new Map(detailedSets.map((s) => [s._id.toString(), s]));

  return bundles.map((bundle) => {
    const included = (bundle.setIds || []).map((id) => setsById.get(id.toString())).filter(Boolean);
    const topicTitles = [...new Set(included.flatMap((s) => s.topics.map((t) => t.topicTitle)))];
    const individualTotal = included.reduce((sum, s) => sum + (s.price || 0), 0);

    return {
      ...bundle,
      sets: included.map((s) => ({
        _id: s._id,
        title: s.title,
        plan: s.plan,
        level: s.level,
        difficulty: s.difficulty,
        category: s.category,
        price: s.price,
        questionCount: s.questionCount,
        timeMinutes: s.timeMinutes,
        status: s.status,
      })),
      summary: {
        totalQuestions: included.reduce((sum, s) => sum + (s.questionCount || 0), 0),
        totalMinutes: included.reduce((sum, s) => sum + (s.timeMinutes || 0), 0),
        levels: LEVELS.filter((l) => included.some((s) => s.level === l)),
        categories: CATEGORIES.filter((c) => included.some((s) => s.category === c)),
        topicCount: topicTitles.length,
        topicTitles,
        individualTotal,
        savings: Math.max(0, individualTotal - (bundle.price || 0)),
      },
    };
  });
};

const loadTenantSets = (practiceSets) => (ids) => practiceSets.find({ _id: { $in: ids } }).toArray();

const buildBundlePayload = async (body, practiceSets) => {
  const title = String(body.title || "").trim();
  if (!title) return { err: "Title is required" };

  const status = STATUSES.includes(body.status) ? body.status : "draft";

  const rawIds = Array.isArray(body.setIds) ? body.setIds : [];
  if (rawIds.some((id) => !ObjectId.isValid(id))) return { err: "Invalid practice set selected" };
  const setIds = [...new Set(rawIds.map(String))].map((id) => new ObjectId(id));
  if (setIds.length < 2) return { err: "A bundle needs at least 2 practice sets" };

  const found = await practiceSets.countDocuments({ _id: { $in: setIds } });
  if (found !== setIds.length) return { err: "One or more selected practice sets no longer exist" };

  const price = toNumber(body.price);
  const mrp = toNumber(body.mrp, price) || price;
  if (price <= 0) return { err: "Bundle price must be greater than 0" };
  if (mrp < price) return { err: "MRP cannot be lower than the offer price" };

  return {
    data: {
      title,
      description: String(body.description || "").trim(),
      thumbnail: String(body.thumbnail || "").trim(),
      topicsText: String(body.topicsText || "").trim(),
      setIds,
      price,
      mrp,
      validityDays: Math.max(0, Math.floor(toNumber(body.validityDays))),
      status,
    },
  };
};

module.exports.getPracticeBundles = async (req, res) => {
  const { practiceSets, practiceBundles } = connectTodb(req.tenantDB);
  try {
    const { status, search } = req.query;
    const query = {};
    if (STATUSES.includes(status)) query.status = status;
    if (search?.trim()) query.title = { $regex: escapeRegex(search.trim()), $options: "i" };

    const bundles = await practiceBundles.find(query).sort({ createdAt: -1 }).toArray();
    res.status(200).json({ data: await withBundleSummary(bundles, loadTenantSets(practiceSets)) });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getPracticeBundle = async (req, res) => {
  const { practiceSets, practiceBundles } = connectTodb(req.tenantDB);
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle id" });

    const bundle = await practiceBundles.findOne({ _id: id });
    if (!bundle) return res.status(404).json({ err: "Bundle not found" });

    const [detailed] = await withBundleSummary([bundle], loadTenantSets(practiceSets));
    res.status(200).json({ data: detailed });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.createPracticeBundle = async (req, res) => {
  const { practiceSets, practiceBundles } = connectTodb(req.tenantDB);
  try {
    const { err, data } = await buildBundlePayload(req.body, practiceSets);
    if (err) return res.status(400).json({ err });

    const duplicate = await practiceBundles.findOne({
      title: { $regex: `^${escapeRegex(data.title)}$`, $options: "i" },
    });
    if (duplicate) return res.status(400).json({ err: "A bundle with this title already exists" });

    const doc = { ...data, createdBy: req.userID || null, createdAt: Date.now(), updatedAt: Date.now() };
    const result = await practiceBundles.insertOne(doc);
    res.status(201).json({ msg: "Bundle created successfully", data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updatePracticeBundle = async (req, res) => {
  const { practiceSets, practiceBundles } = connectTodb(req.tenantDB);
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle id" });

    const { err, data } = await buildBundlePayload(req.body, practiceSets);
    if (err) return res.status(400).json({ err });

    const duplicate = await practiceBundles.findOne({
      _id: { $ne: id },
      title: { $regex: `^${escapeRegex(data.title)}$`, $options: "i" },
    });
    if (duplicate) return res.status(400).json({ err: "A bundle with this title already exists" });

    const result = await practiceBundles.updateOne({ _id: id }, { $set: { ...data, updatedAt: Date.now() } });
    if (result.matchedCount === 0) return res.status(404).json({ err: "Bundle not found" });

    res.status(200).json({ msg: "Bundle updated successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deletePracticeBundle = async (req, res) => {
  const { practiceBundles } = connectTodb(req.tenantDB);
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ err: "Invalid bundle id" });

    const result = await archiveAndDeleteOne(practiceBundles, { _id: id }, {
      deletedBy: req.userID || null,
      reason: req.body?.reason || null,
    });
    if (result.deletedCount === 0) return res.status(404).json({ err: "Bundle not found" });

    res.status(200).json({ msg: "Bundle deleted successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// Shared with the student practice catalog so both sides compute questions,
// topic names and bundle totals the same way.
module.exports.helpers = {
  LEVELS,
  DIFFICULTIES,
  toObjectId,
  buildQuestionQuery,
  sortSets,
  withTopicDetails,
  withBundleSummary,
};
