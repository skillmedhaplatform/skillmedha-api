'use strict';

const axios = require('axios');
const { connectTodb, getGlobalCollections } = require('../../../shared/db/connection');
const { redisClient, isRedisAvailable } = require('../../../shared/cache/redis');
const {
  CITY_DISPLAY, SKILL_NAMES, normalizeCity, detectExperience, detectJobType, detectSkills, stripHtml,
  htmlToReadableText,
} = require('./jobBoards/classify');
const { getLastSync } = require('./jobBoards/sync');

// Outside jobs come from free public sources, no API keys:
//  1. Company job boards (Greenhouse, Lever, SmartRecruiters, Ashby) — India
//     jobs with real office cities — and Jobicy remote jobs, synced into
//     `externalJobs` every 3 hours.
//  2. Himalayas — remote jobs open to India, searched live.
const HIMALAYAS_SEARCH_URL = 'https://himalayas.app/jobs/api/search';
const PAGE_SIZE = 20;
const MAX_PAGE = 20;

const CACHE_TTL_SECONDS = 60 * 60;
const CACHE_PREFIX = 'extjobs:him:';
const memoryCache = new Map();
const MEMORY_CACHE_MAX = 200;

async function getCached(key) {
  if (isRedisAvailable()) {
    try {
      const hit = await redisClient.get(CACHE_PREFIX + key);
      if (hit) return JSON.parse(hit);
    } catch (_) { /* fall through to memory cache */ }
  }
  const entry = memoryCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  memoryCache.delete(key);
  return null;
}

async function setCached(key, value) {
  if (isRedisAvailable()) {
    try {
      await redisClient.set(CACHE_PREFIX + key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
      return;
    } catch (_) { /* fall through to memory cache */ }
  }
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "developer" should also find "engineer" titles, and the other way round.
const ROLE_SYNONYMS = {
  developer: ['developer', 'engineer', 'programmer'],
  engineer: ['engineer', 'developer'],
  dev: ['developer', 'engineer', 'dev'],
  frontend: ['frontend', 'front-end', 'front end'],
  backend: ['backend', 'back-end', 'back end'],
  fullstack: ['fullstack', 'full-stack', 'full stack'],
  ml: ['ml', 'machine learning'],
  ai: ['ai', 'artificial intelligence', 'machine learning'],
  hr: ['hr', 'human resources', 'people', 'talent'],
  qa: ['qa', 'quality', 'test', 'sdet'],
};
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'in', 'of', 'for', 'job', 'jobs', 'role']);

const roleWords = (role) =>
  role
    .toLowerCase()
    .replace(/front end/g, 'frontend').replace(/back end/g, 'backend').replace(/full stack/g, 'fullstack')
    .split(/[\s,/]+/)
    .filter((w) => w && !STOP_WORDS.has(w));

// ─── Spelling help ("Dataengenner" → "data engineer") ────────────────────────
// Built from the words in real job titles, refreshed every hour.
let vocabulary = null;
let vocabularyBuiltAt = 0;

async function getVocabulary() {
  if (vocabulary && Date.now() - vocabularyBuiltAt < CACHE_TTL_SECONDS * 1000) return vocabulary;
  const { externalJobs } = getGlobalCollections();
  const titles = await externalJobs.distinct('title');
  const words = new Set(Object.keys(ROLE_SYNONYMS));
  [...titles, ...SKILL_NAMES].forEach((t) =>
    String(t).toLowerCase().split(/[^a-z]+/).forEach((w) => w.length >= 2 && words.add(w))
  );
  vocabulary = words;
  vocabularyBuiltAt = Date.now();
  return vocabulary;
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function closestWord(word, vocab) {
  if (vocab.has(word)) return word;
  const maxDist = word.length <= 4 ? 1 : 2;
  let best = null;
  let bestDist = maxDist + 1;
  for (const v of vocab) {
    // Short typos ("jva") only match words of nearly the same length ("java").
    if (v.length < 3 || (word.length <= 4 && Math.abs(v.length - word.length) > 1)) continue;
    const d = editDistance(word, v);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

function correctWord(word, vocab) {
  if (vocab.has(word) || word.length < 3) return word;
  const close = closestWord(word, vocab);
  if (close) return close;
  // Two words typed together: "dataengineer", "dataengenner"
  for (let i = 3; i <= word.length - 3; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    if (vocab.has(left)) {
      const r = closestWord(right, vocab);
      if (r) return `${left} ${r}`;
    }
  }
  return word;
}

async function correctRole(role) {
  if (!role) return role;
  try {
    const vocab = await getVocabulary();
    return roleWords(role).map((w) => correctWord(w, vocab)).join(' ');
  } catch (err) {
    console.warn('[externalJobs] spelling help unavailable:', err.message);
    return role;
  }
}

function roleConditions(role) {
  const words = roleWords(role);

  return words.map((w) => {
    const variants = ROLE_SYNONYMS[w] || [w];
    const re = new RegExp(variants.map((v) => `\\b${escapeRegex(v)}`).join('|'), 'i');
    // A word that is a skill ("react", "python") also finds jobs needing it.
    const skillRe = new RegExp(`^(${variants.map(escapeRegex).join('|')})$`, 'i');
    return { $or: [{ title: re }, { department: re }, { skills: skillRe }] };
  });
}

// Skills the student picked, kept only if they are skills we know.
function parseSkills(value) {
  const known = new Map(SKILL_NAMES.map((s) => [s.toLowerCase(), s]));
  return String(value || '')
    .split(',')
    .map((s) => known.get(s.trim().toLowerCase()))
    .filter(Boolean)
    .slice(0, 10);
}

function parseFilters(q) {
  let page = parseInt(q.page, 10);
  if (isNaN(page) || page < 1) page = 1;
  if (page > MAX_PAGE) page = MAX_PAGE;

  let years = q.years === undefined || q.years === '' ? null : parseInt(q.years, 10);
  if (isNaN(years) || years < 0 || years > 40) years = null;

  const pick = (v, allowed) => (allowed.includes(v) ? v : '');
  return {
    role: String(q.role || '').trim().slice(0, 100),
    location: String(q.location || '').trim().slice(0, 100),
    experience: pick(q.experience, ['fresher', 'experienced']),
    years,
    skills: parseSkills(q.skills),
    workMode: pick(q.workMode, ['onsite', 'hybrid', 'remote']),
    jobType: pick(q.jobType, ['fulltime', 'internship', 'contract']),
    postedWithin: [1, 3, 7, 30].includes(Number(q.postedWithin)) ? Number(q.postedWithin) : null,
    company: String(q.company || '').trim().slice(0, 100),
    sort: pick(q.sort, ['relevance', 'recent', 'match']) || 'relevance',
    mySkills: [],
    page,
  };
}

// Titles that usually need more experience than the student has.
function tooSeniorTitleRe(years) {
  if (years < 3) return /\b(senior|sr\.?|staff|principal|lead|manager|director|head|architect|vp|vice president|chief)\b/i;
  if (years < 6) return /\b(staff|principal|director|head|architect|vp|vice president|chief)\b/i;
  if (years < 10) return /\b(director|head|vp|vice president|chief)\b/i;
  return null;
}

// ─── Company board jobs (MongoDB) ────────────────────────────────────────────
// Search conditions grouped by filter.
function buildConditions(f) {
  const c = { role: [], location: [], workMode: [], jobType: [], experience: [], posted: [], company: [], skills: [] };

  if (f.role) c.role.push(...roleConditions(f.role));

  // Jobs needing ANY of the picked skills.
  if (f.skills.length) c.skills.push({ skills: { $in: f.skills } });

  const loc = f.location.toLowerCase();
  // Remote jobs aren't tied to a city, so the city is ignored for Remote.
  if (loc && loc !== 'india' && f.workMode !== 'remote') {
    const city = normalizeCity(loc);
    c.location.push(city ? { cities: city } : { location: new RegExp(escapeRegex(f.location), 'i') });
  }

  if (f.workMode) c.workMode.push({ workplace: f.workMode });

  if (f.jobType === 'internship') c.jobType.push({ jobType: 'Internship' });
  if (f.jobType === 'contract') c.jobType.push({ jobType: 'Contract' });
  // Boards that don't state a type (most Greenhouse jobs) list regular roles.
  if (f.jobType === 'fulltime') c.jobType.push({ jobType: { $in: ['Full-time', null] } });

  if (f.experience === 'fresher') c.experience.push({ experienceLevel: 'fresher' });
  if (f.experience === 'experienced') c.experience.push({ experienceLevel: 'experienced' });

  if (f.years !== null) {
    // Jobs asking for no more than the student's years (and not capped below
    // them), plus roles at that level that don't state years.
    c.experience.push({
      $or: [
        {
          minExperience: { $ne: null, $lte: f.years },
          $or: [{ maxExperience: null }, { maxExperience: { $gte: f.years } }],
        },
        f.years <= 1
          ? { minExperience: null, experienceLevel: 'fresher' }
          : { minExperience: null, experienceLevel: 'experienced' },
      ],
    });
    // Jobs that don't state years: leave out titles clearly above this level.
    const tooSenior = tooSeniorTitleRe(f.years);
    if (tooSenior) c.experience.push({ $or: [{ minExperience: { $ne: null } }, { title: { $not: tooSenior } }] });
  }

  if (f.postedWithin) {
    c.posted.push({ postedAt: { $gte: new Date(Date.now() - f.postedWithin * 24 * 60 * 60 * 1000) } });
  }

  if (f.company) c.company.push({ company: f.company });

  return c;
}

const toQuery = (conds, skip) => {
  const and = Object.entries(conds)
    .filter(([key]) => key !== skip)
    .flatMap(([, list]) => list);
  return and.length ? { $and: and } : {};
};

// The list never carries the full description — the details view loads it.
const LIST_PROJECTION = { _id: 0, lastSeenAt: 0, firstSeenAt: 0, companyKey: 0, description: 0 };

async function searchCompanyJobs(f) {
  const { externalJobs } = getGlobalCollections();
  const query = toQuery(buildConditions(f));
  const skip = (f.page - 1) * PAGE_SIZE;

  let docsPromise;
  if (f.sort === 'match' && f.mySkills.length) {
    // Jobs needing the most of the student's own skills first, then newest.
    docsPromise = externalJobs
      .aggregate([
        { $match: query },
        { $addFields: { _match: { $size: { $setIntersection: [{ $ifNull: ['$skills', []] }, f.mySkills] } } } },
        { $sort: { _match: -1, postedAt: -1 } },
        { $skip: skip },
        { $limit: PAGE_SIZE },
        { $project: { ...LIST_PROJECTION, _match: 0 } },
      ])
      .toArray();
  } else if (f.role && f.sort !== 'recent') {
    // Titles containing the whole role phrase first, then newest.
    const phrase = roleWords(f.role).map(escapeRegex).join('[\\s\\-/,]+');
    docsPromise = externalJobs
      .aggregate([
        { $match: query },
        {
          $addFields: {
            _score: {
              $cond: [{ $regexMatch: { input: '$title', regex: phrase, options: 'i' } }, 1, 0],
            },
          },
        },
        { $sort: { _score: -1, postedAt: -1 } },
        { $skip: skip },
        { $limit: PAGE_SIZE },
        { $project: { ...LIST_PROJECTION, _score: 0 } },
      ])
      .toArray();
  } else {
    docsPromise = externalJobs
      .find(query, { projection: LIST_PROJECTION })
      .sort({ postedAt: -1 })
      .skip(skip)
      .limit(PAGE_SIZE)
      .toArray();
  }

  const [docs, total] = await Promise.all([docsPromise, externalJobs.countDocuments(query)]);

  return {
    jobs: docs.map(({ sourceKey, ...d }) => ({ ...d, id: sourceKey, source: d.source || 'Company careers page' })),
    total,
  };
}

// ─── Himalayas remote jobs (live) ────────────────────────────────────────────
function normalizeHimalayasJob(j) {
  const title = stripHtml(j.title);
  const description = stripHtml(j.excerpt);
  const seniority = (j.seniority || []).join(' ');
  const exp = detectExperience(title, `${title}. ${description}`, /entry/i.test(seniority) ? 'entry_level' : seniority);
  const places = Array.isArray(j.locationRestrictions) ? j.locationRestrictions : [];
  const hasSalary = j.minSalary || j.maxSalary;

  return {
    id: j.guid || j.applicationLink,
    provider: 'himalayas',
    company: j.companyName || 'Company',
    companyLogo: j.companyLogo || null,
    title,
    department: null,
    location: places.length ? `Remote · ${places.slice(0, 3).join(', ')}` : 'Remote · Worldwide',
    cities: [],
    workplace: 'remote',
    jobType: detectJobType(j.employmentType, title),
    experienceLevel: exp.experienceLevel,
    minExperience: exp.minExperience,
    maxExperience: exp.maxExperience,
    skills: detectSkills(title, `${description} ${(j.categories || []).join(' ').replace(/-/g, ' ')}`, null),
    applyLink: j.applicationLink,
    postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
    salary: hasSalary
      ? { min: j.minSalary || null, max: j.maxSalary || null, currency: j.currency || null, period: j.salaryPeriod || null }
      : null,
    description: description.slice(0, 600),
    source: 'Himalayas',
  };
}

function himalayasMatches(job, f) {
  if (f.company && job.company !== f.company) return false;
  if (f.skills.length && !f.skills.some((s) => job.skills.includes(s))) return false;
  if (f.postedWithin && (!job.postedAt || Date.now() - new Date(job.postedAt) > f.postedWithin * 86400000)) return false;
  if (f.experience && job.experienceLevel !== f.experience) return false;
  if (f.jobType === 'internship' && job.jobType !== 'Internship') return false;
  if (f.jobType === 'contract' && job.jobType !== 'Contract') return false;
  if (f.jobType === 'fulltime' && job.jobType && job.jobType !== 'Full-time') return false;
  if (f.years !== null) {
    if (job.minExperience !== null) {
      if (job.minExperience > f.years) return false;
      if (job.maxExperience !== null && job.maxExperience < f.years) return false;
    } else if (f.years <= 1 ? job.experienceLevel !== 'fresher' : job.experienceLevel !== 'experienced') {
      return false;
    } else {
      const tooSenior = tooSeniorTitleRe(f.years);
      if (tooSenior && tooSenior.test(job.title)) return false;
    }
  }
  return true;
}

async function searchHimalayas(f) {
  const cacheKey = `${f.role.toLowerCase()}|${f.page}`;
  let data = await getCached(cacheKey);
  if (!data) {
    const res = await axios.get(HIMALAYAS_SEARCH_URL, {
      params: { q: f.role, country: 'India', page: f.page },
      headers: { 'User-Agent': 'SkillmedhaJobs/1.0' },
      timeout: 15000,
    });
    data = { jobs: res.data?.jobs || [], total: Number(res.data?.totalCount) || 0 };
    await setCached(cacheKey, data);
  }
  const jobs = data.jobs
    .filter((j) => j.applicationLink)
    .map(normalizeHimalayasJob)
    .filter((j) => himalayasMatches(j, f));
  return { jobs, total: data.total };
}

// Profile skills are free text ("react js", "pyhton") — map them to the same
// skill names jobs use, fixing typos on the way.
async function getProfileSkills(req) {
  if (!req.tenantDB || !req.userId) return [];
  try {
    const { student } = connectTodb(req.tenantDB);
    const doc = await student.findOne({ globalId: req.userId }, { projection: { technical: 1 } });
    const entries = Array.isArray(doc?.technical) ? doc.technical.filter((t) => typeof t === 'string') : [];
    if (!entries.length) return [];
    const corrected = await Promise.all(entries.slice(0, 50).map((e) => correctRole(e)));
    const text = [...entries, ...corrected].join(', ');
    return detectSkills(text, text, null);
  } catch (err) {
    console.warn('[externalJobs] profile skills unavailable:', err.message);
    return [];
  }
}

/* GET /external-jobs
 *   role, location (Indian city or "India"), experience (fresher|experienced),
 *   years (student's experience), workMode (onsite|hybrid|remote),
 *   jobType (fulltime|internship|contract), page
 */
async function searchExternalJobs(req, res) {
  const f = parseFilters(req.query);
  const typedRole = f.role;
  f.role = await correctRole(f.role);
  const correctedRole =
    f.role && f.role.toLowerCase() !== roleWords(typedRole).join(' ') ? f.role : null;

  // The student's own skills (profile → Skills) — used to show matching skills
  // on each job and for the "Best match for me" sort.
  f.mySkills = await getProfileSkills(req);

  // Remember the student's latest choice — used later for job alerts.
  if (req.tenantDB && req.userId && (f.role || f.location || f.skills.length)) {
    const { student } = connectTodb(req.tenantDB);
    const { page, mySkills, ...prefs } = f;
    student
      .updateOne({ globalId: req.userId }, { $set: { jobPreferences: { ...prefs, updatedAt: new Date() } } })
      .catch((err) => console.error('[externalJobs] save preferences failed:', err.message));
  }

  // Himalayas only has remote jobs and needs a role. It is shown when the
  // student picks Remote, or searches all of India with no work mode — never
  // mixed into a city search, which should show only that city's jobs.
  const hasCity = Boolean(f.location) && f.location.toLowerCase() !== 'india';
  const includeRemoteBoard =
    Boolean(f.role) && !f.company && (f.workMode === 'remote' || (!f.workMode && !hasCity));

  try {
    let locationNote = null;
    const [firstCompany, remote] = await Promise.all([
      searchCompanyJobs(f),
      includeRemoteBoard
        ? searchHimalayas(f).catch((err) => {
            console.error('[externalJobs] Himalayas error:', err?.response?.status || err.message);
            return { jobs: [], total: 0 };
          })
        : Promise.resolve({ jobs: [], total: 0 }),
    ]);

    // A city search shows only that city's jobs; say so when there are none.
    const company = firstCompany;
    if (hasCity && f.workMode !== 'remote' && company.total === 0) {
      locationNote = `No jobs${f.role ? ` for "${f.role}"` : ''} in ${f.location} right now. Try another city, or choose Remote.`;
    }

    // Company jobs first (already in relevance / newest / match order), then remote jobs.
    const byDate = (a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0);
    const withMatch = (j) => ({ ...j, matchedSkills: (j.skills || []).filter((s) => f.mySkills.includes(s)) });
    const remoteSorted = remote.jobs.map(withMatch).sort(
      f.sort === 'match' ? (a, b) => b.matchedSkills.length - a.matchedSkills.length || byDate(a, b) : byDate
    );
    const jobs = [...company.jobs.map(withMatch), ...remoteSorted];
    const hasNextPage =
      f.page < MAX_PAGE &&
      (f.page * PAGE_SIZE < company.total || (includeRemoteBoard && f.page * PAGE_SIZE < remote.total));

    return res.status(200).json({
      success: true,
      data: jobs,
      correctedRole,
      locationNote,
      mySkills: f.mySkills,
      pagination: {
        page: f.page,
        companyJobsTotal: company.total,
        remoteJobsTotal: includeRemoteBoard ? remote.total : 0,
        hasNextPage,
      },
    });
  } catch (error) {
    console.error('[externalJobs] search error:', error.message);
    return res.status(500).json({ success: false, error: 'Could not load outside jobs. Please try again.' });
  }
}

/* GET /external-jobs/filters — real options for the filter bar */
async function getExternalJobFilters(req, res) {
  try {
    const { externalJobs } = getGlobalCollections();
    const popular = (field) => [
      { $unwind: `$${field}` },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
    const [cities, skills, latest] = await Promise.all([
      externalJobs.aggregate(popular('cities')).toArray(),
      externalJobs.aggregate(popular('skills')).toArray(),
      externalJobs.find({}, { projection: { lastSeenAt: 1 } }).sort({ lastSeenAt: -1 }).limit(1).toArray(),
    ]);

    // Names only, most common first — only options that have real jobs.
    return res.status(200).json({
      success: true,
      data: {
        cities: cities.map((c) => ({ value: c._id, label: CITY_DISPLAY[c._id] || c._id })),
        skills: skills.map((s) => s._id),
        lastSyncedAt: getLastSync()?.finishedAt || latest[0]?.lastSeenAt || null,
      },
    });
  } catch (error) {
    console.error('[externalJobs] filters error:', error.message);
    return res.status(500).json({ success: false, error: 'Could not load filters.' });
  }
}

/* GET /external-jobs/detail?id=<job id> — full description for the details view */
async function getExternalJobDetail(req, res) {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ success: false, error: 'id is required' });
  try {
    const { externalJobs } = getGlobalCollections();
    const job = await externalJobs.findOne(
      { sourceKey: id },
      { projection: { _id: 0, lastSeenAt: 0, firstSeenAt: 0, companyKey: 0 } }
    );
    if (!job) {
      return res.status(404).json({ success: false, error: 'This job is no longer listed.' });
    }

    // SmartRecruiters lists come without descriptions — fetch this one job's
    // real description once, then keep it with the job.
    if (!job.description && job.provider === 'smartrecruiters') {
      try {
        const [, companyId, postingId] = job.sourceKey.split(':');
        const { data } = await axios.get(
          `https://api.smartrecruiters.com/v1/companies/${companyId}/postings/${postingId}`,
          { timeout: 15000 }
        );
        const sections = data?.jobAd?.sections || {};
        const text = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
          .map((k) => sections[k] && `<h4>${sections[k].title || ''}</h4>${sections[k].text || ''}`)
          .filter(Boolean)
          .map(htmlToReadableText)
          .join('\n\n')
          .slice(0, 6000);
        if (text) {
          const exp = detectExperience(job.title, `${job.title}. ${text}`, null);
          const update = { description: text };
          if (job.minExperience === null && exp.minExperience !== null) {
            update.minExperience = exp.minExperience;
            update.maxExperience = exp.maxExperience;
          }
          Object.assign(job, update);
          externalJobs.updateOne({ sourceKey: job.sourceKey }, { $set: update }).catch(() => {});
        }
      } catch (err) {
        console.warn('[externalJobs] SmartRecruiters detail failed:', err?.response?.status || err.message);
      }
    }

    const { sourceKey, ...rest } = job;
    return res.status(200).json({
      success: true,
      data: { ...rest, id: sourceKey, source: rest.source || 'Company careers page' },
    });
  } catch (error) {
    console.error('[externalJobs] detail error:', error.message);
    return res.status(500).json({ success: false, error: 'Could not load job details.' });
  }
}

// ─── Suggestions while typing ────────────────────────────────────────────────
// Role names are cleaned real job titles: "Senior Software Engineer II (Backend)"
// → "Software Engineer". Rebuilt every hour.
const LEVEL_WORDS = /\b(senior|sr|staff|lead|principal|junior|jr|chief|head|associate|i{1,3}|iv|v|[1-5])\b\.?/gi;
let roleIndex = null;
let roleIndexBuiltAt = 0;

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

async function getRoleIndex() {
  if (roleIndex && Date.now() - roleIndexBuiltAt < CACHE_TTL_SECONDS * 1000) return roleIndex;
  const { externalJobs } = getGlobalCollections();
  const titles = await externalJobs.find({}, { projection: { _id: 0, title: 1 } }).toArray();
  const counts = new Map();
  for (const { title } of titles) {
    const base = String(title || '')
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .split(/\s[-–|:]\s|,|\|/)[0]
      .replace(LEVEL_WORDS, ' ')
      .replace(/[^a-zA-Z+#./& ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (base.length >= 3 && base.split(' ').length <= 5) counts.set(base, (counts.get(base) || 0) + 1);
  }
  roleIndex = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  roleIndexBuiltAt = Date.now();
  return roleIndex;
}

function matchRoles(index, q) {
  return index
    .filter((r) => r.name.includes(q))
    .sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || b.count - a.count)
    .slice(0, 8)
    .map((r) => titleCase(r.name));
}

/* GET /external-jobs/suggest?q=… — roles and skills as the student types,
   with spelling help ("pyhton" → Python, "dataengenner" → Data Engineer). */
async function suggestExternalJobs(req, res) {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
  if (q.length < 2) return res.status(200).json({ success: true, data: { roles: [], skills: [], didYouMean: null } });

  try {
    const index = await getRoleIndex();
    let roles = matchRoles(index, q);
    let skills = SKILL_NAMES.filter((s) => s.toLowerCase().includes(q)).slice(0, 6);
    let didYouMean = null;

    if (!roles.length && !skills.length) {
      const corrected = await correctRole(q);
      if (corrected && corrected !== q) {
        didYouMean = titleCase(corrected);
        roles = matchRoles(index, corrected);
        skills = SKILL_NAMES.filter((s) => s.toLowerCase() === corrected || corrected.split(' ').includes(s.toLowerCase())).slice(0, 6);
      }
    }
    return res.status(200).json({ success: true, data: { roles, skills, didYouMean } });
  } catch (error) {
    console.error('[externalJobs] suggest error:', error.message);
    return res.status(200).json({ success: true, data: { roles: [], skills: [], didYouMean: null } });
  }
}

// ─── Saved / applied jobs (per student) ──────────────────────────────────────
// Stored on the student record with a small copy of the job, so the list still
// shows after the company takes the job down.
const MAX_TRACKED = 300;
const pickJobCopy = (j = {}) => ({
  id: String(j.id || '').slice(0, 300),
  title: String(j.title || '').slice(0, 200),
  company: String(j.company || '').slice(0, 120),
  location: String(j.location || '').slice(0, 200),
  workplace: ['onsite', 'hybrid', 'remote'].includes(j.workplace) ? j.workplace : null,
  applyLink: /^https?:\/\//i.test(String(j.applyLink || '')) ? String(j.applyLink).slice(0, 600) : null,
  source: String(j.source || '').slice(0, 60),
});

/* POST /external-jobs/track  { action: 'apply' | 'unapply' | 'save' | 'unsave', job } */
async function trackExternalJob(req, res) {
  const { action } = req.body || {};
  const job = pickJobCopy(req.body?.job);
  if (!['apply', 'unapply', 'save', 'unsave'].includes(action) || !job.id) {
    return res.status(400).json({ success: false, error: 'action and job are required' });
  }
  if (!req.tenantDB || !req.userId) return res.status(401).json({ success: false, error: 'Not signed in' });

  try {
    const { student } = connectTodb(req.tenantDB);
    const field = action === 'apply' || action === 'unapply' ? 'externalJobs.applied' : 'externalJobs.saved';
    // Remove any old entry for this job, then add the new one (keeps one per job).
    await student.updateOne({ globalId: req.userId }, { $pull: { [field]: { id: job.id } } });
    if (action === 'apply' || action === 'save') {
      await student.updateOne(
        { globalId: req.userId },
        { $push: { [field]: { $each: [{ ...job, at: new Date() }], $position: 0, $slice: MAX_TRACKED } } }
      );
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[externalJobs] track error:', error.message);
    return res.status(500).json({ success: false, error: 'Could not save. Please try again.' });
  }
}

/* GET /external-jobs/mine — the student's saved and applied outside jobs */
async function getMyExternalJobs(req, res) {
  if (!req.tenantDB || !req.userId) return res.status(401).json({ success: false, error: 'Not signed in' });
  try {
    const { student } = connectTodb(req.tenantDB);
    const doc = await student.findOne({ globalId: req.userId }, { projection: { externalJobs: 1 } });
    return res.status(200).json({
      success: true,
      data: { applied: doc?.externalJobs?.applied || [], saved: doc?.externalJobs?.saved || [] },
    });
  } catch (error) {
    console.error('[externalJobs] mine error:', error.message);
    return res.status(500).json({ success: false, error: 'Could not load your jobs.' });
  }
}

module.exports = {
  searchExternalJobs,
  getExternalJobFilters,
  getExternalJobDetail,
  suggestExternalJobs,
  trackExternalJob,
  getMyExternalJobs,
};
