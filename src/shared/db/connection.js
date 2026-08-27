'use strict';

const { MongoClient } = require('mongodb');
const { LRUCache } = require('lru-cache');
const config = require('../../config');

// ─── Shared MongoDB Client ───────────────────────────────────────────────────
let sharedClient = null;
let sharedDB = null;

// Tenant DB LRU Cache (max 10 orgs in memory)
if (!global.tenantCache) {
  global.tenantCache = new LRUCache({ max: 10 });
}

/**
 * Returns the MongoDB connection URL.
 */
function getMongoUrl() {
  return config.mongo.getUrl();
}

/**
 * Get or create the shared MongoDB client (singleton).
 */
async function getSharedMongoClient() {
  if (!sharedClient) {
    sharedClient = new MongoClient(getMongoUrl());
    await sharedClient.connect();
    console.log('[DB] Shared MongoDB client connected');
  }
  return sharedClient;
}

/**
 * Connect to the shared DB (used on server startup).
 */
async function connectSharedDB() {
  const client = await getSharedMongoClient();
  sharedDB = client.db(config.mongo.sharedDbName);
  // Initialise global collections now that client is connected
  _initGlobalCollections();
  console.log(`[DB] Connected to shared DB: ${config.mongo.sharedDbName}`);
  return sharedDB;
}

/**
 * Returns the already-connected shared DB instance.
 */
function getSharedDB() {
  if (!sharedDB) throw new Error('Shared DB not yet connected. Call connectSharedDB() first.');
  return sharedDB;
}

// ─── Global Collections (from original mongoConfig.js) ──────────────────────
let _globalCollections = null;

/**
 * Returns a lazy proxy of global collections.
 * Safe to call at module load time — each collection method is resolved at call time,
 * after connectSharedDB() has run. This avoids "MongoDB client not connected" errors
 * when service files destructure collections at the top level.
 */
function getGlobalCollections() {
  // If already initialised, return directly
  if (_globalCollections) return _globalCollections;

  // Return a Proxy so top-level destructuring (`const { X } = getGlobalCollections()`)
  // works even before connection. Each property access that returns a collection
  // will re-check _globalCollections on every DB call.
  return new Proxy({}, {
    get(target, prop) {
      if (_globalCollections) return _globalCollections[prop];
      // Return a lazy collection proxy that resolves on first access.
      return new Proxy({}, {
        get(colTarget, method) {
          if (!_globalCollections) {
            throw new Error(`[DB] getGlobalCollections(): not yet connected. Cannot access "${String(prop)}.${String(method)}". Ensure connectSharedDB() has completed before handling requests.`);
          }
          const col = _globalCollections[prop];
          if (!col) throw new Error(`[DB] Collection "${String(prop)}" not found in global collections.`);
          const value = col[method];
          if (typeof value === 'function') {
            return value.bind(col);
          }
          return value;
        }
      });
    }
  });
}

function _initGlobalCollections() {
  const client = sharedClient;
  if (!client) throw new Error('MongoDB client not connected');

  const db          = client.db('SkilmedhaDefault');
  const db_resources = client.db('skillmedha_resources');
  const KSquaredb   = client.db('KSquare');

  db.collection('users').createIndex(
    { email: 1 },
    { background: true }
  ).catch(err => console.warn('[DB] Failed to create email index:', err));

  KSquaredb.collection('internships').createIndex(
    { type: 1 },
    { background: true }
  ).catch(err => console.warn('[DB] internships type index:', err));

  _globalCollections = {
    mainDBusers:            db.collection('users'),
    organisation:           db.collection('organizations'),
    colleges:               db.collection('collegesData'),
    assessments:            db.collection('assessment'),
    questions:              db_resources.collection('questions'),
    categories:             db_resources.collection('categories'),
    skillsCollection:       db_resources.collection('skills'),
    AdminUser:              db.collection('adminusers'),
    paymentConfigCollection: db.collection('paymentConfigCollection'),
    internshipsCollection:  KSquaredb.collection('internships'),
    sectionsCollection:     KSquaredb.collection('sections'),
    topicsCollection:       KSquaredb.collection('topics'),
    zoomMeetingsCollection: KSquaredb.collection('zoomMeetings'),
    studentsCollection:     KSquaredb.collection('student'),
    rzp_payemntDetails:     db.collection('rzp_payemntDetails'),
    payment:                db.collection('payment'),
    aiUsageCollection:      db_resources.collection('ai_usage'),
    marqueeNotices:         db.collection('marqueeNotices'),
    companyTests:           db_resources.collection('companyTests'),
  };

  return _globalCollections;
}

// ─── Tenant DB Resolution ────────────────────────────────────────────────────
const { redisClient, isRedisAvailable } = require('../cache/redis');

const CACHE_KEY_PREFIX = 'skillmedhaOrgClients:';
const LOCK_TTL_SECONDS = 5;
const MAX_RETRIES = 20;

async function acquireLock(lockKey) {
  if (!isRedisAvailable()) {
    return true;
  }

  try {
    const result = await redisClient.set(lockKey, 'locked', 'EX', LOCK_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch (err) {
    console.warn('[Redis] acquireLock failed, proceeding without distributed lock:', err.message);
    return true;
  }
}

/**
 * Get or create a tenant-specific DB connection using shared client + LRU + Redis cache.
 */
async function getTenantDB(orgId, retryCount = 0) {
  if (!orgId) throw new Error('Missing orgId');

  const cacheKey = `${CACHE_KEY_PREFIX}${orgId}`;
  const lockKey  = `lock:tenant:${orgId}`;

  // 1. Check in-memory LRU cache
  const cached = global.tenantCache.get(orgId);
  if (cached) {
    return cached;
  }

  // 2. Check Redis
  if (isRedisAvailable()) {
    try {
      const cachedUri = await redisClient.get(cacheKey);
      if (cachedUri) {
        const client = await getSharedMongoClient();
        const db = client.db(orgId);
        global.tenantCache.set(orgId, db);
        return db;
      }
    } catch (err) {
      console.warn('[Redis] getTenantDB cache read failed, continuing without cache:', err.message);
    }
  }

  // 3. Acquire lock and create
  const lockAcquired = await acquireLock(lockKey);
  if (!lockAcquired) {
    if (retryCount >= MAX_RETRIES) throw new Error(`Max retries reached for tenant: ${orgId}`);
    await new Promise((res) => setTimeout(res, 100));
    const uriAfterWait = await redisClient.get(cacheKey);
    if (uriAfterWait) {
      const client = await getSharedMongoClient();
      const db = client.db(orgId);
      global.tenantCache.set(orgId, db);
      return db;
    }
    return getTenantDB(orgId, retryCount + 1);
  }

  try {
    if (isRedisAvailable()) {
      const finalCached = await redisClient.get(cacheKey);
      if (finalCached) {
        const client = await getSharedMongoClient();
        const db = client.db(orgId);
        global.tenantCache.set(orgId, db);
        return db;
      }
    }

    if (isRedisAvailable()) {
      await redisClient.set(cacheKey, getMongoUrl());
    }

    const client = await getSharedMongoClient();
    const db = client.db(orgId);

    db.collection('student').createIndex({ email: 1 }, { background: true })
      .catch(err => console.warn('[DB] student email index:', err));
    db.collection('student').createIndex({ globalId: 1 }, { background: true })
      .catch(err => console.warn('[DB] student globalId index:', err));

    global.tenantCache.set(orgId, db);
    return db;
  } finally {
    if (isRedisAvailable()) {
      await redisClient.del(lockKey);
    }
  }
}

/**
 * Map a tenant DB to its collections.
 * Identical mapping to original shared/tenant/dbConnection.js.
 */
function connectTodb(db) {
  try {
    return {
      users:                   db.collection('users'),
      company:                 db.collection('company'),
      organisation:            db.collection('organisation'),
      modules:                 db.collection('modules'),
      topics:                  db.collection('topics'),
      resume:                  db.collection('resume'),
      practice:                db.collection('practice'),
      job:                     db.collection('job'),
      placements:              db.collection('placements'),
      internships:             db.collection('internships'),
      sections:                db.collection('sections'),
      addressCollection:       db.collection('addressCollection'),
      colleges:                db.collection('colleges'),
      zoomMeetings:            db.collection('ZoomCreatedData'),
      departments:             db.collection('department'),
      psychometricTestCollection: db.collection('psychometricTestCollection'),
      student:                 db.collection('student'),
      tpo:                     db.collection('tpo'),
      randomUsers:             db.collection('randomUsers'),
      noticeBoard:             db.collection('noticeBoard'),
      assessment:              db.collection('assessment'),
      questions:               db.collection('questions'),
      questionTranslations:    db.collection('questionTranslations'),
      answers:                 db.collection('answers'),
      answerTranslations:      db.collection('answerTranslations'),
      assignedAssessments:     db.collection('assignedAssessments'),
      comprehensionQuestions:  db.collection('comprehensionQuestions'),
      test:                    db.collection('test'),
      categories:              db.collection('categories'),
      languages:               db.collection('languages'),
      randomStudent:           db.collection('randomStudent'),
      progress:                db.collection('progress'),
      lastAccessed:            db.collection('lastAccessed'),
      assignedCourses:         db.collection('assignedCourses'),
      studentNotes:            db.collection('studentNotes'),
      assignedInternships:     db.collection('assignedInternships'),
      assignedTests:           db.collection('assignedTests'),
      activeTests:             db.collection('activeTests'),
      proctoringSessions:      db.collection('proctoringSessions'),
      jobAssessments:          db.collection('jobAssessments'),
      aiRespAts:               db.collection('aiRespAts'),
      assignedJob:             db.collection('assignedJob'),
      jobAssessmentProgress:   db.collection('jobAssessmentProgress'),
      practiceCollection:      db.collection('practice'),
      subjects:                db.collection('subjects'),
      subtopics:               db.collection('subtopics'),
      practiceQuestions:       db.collection('practiceQuestions'),
      pracSessions:            db.collection('PracticeSessions'),
      cart:                    db.collection('cart'),
      wishlist:                db.collection('wishlist'),
    };
  } catch (error) {
    console.error('[DB] connectTodb error:', error);
    throw error;
  }
}

module.exports = {
  getMongoUrl,
  connectSharedDB,
  getSharedDB,
  getSharedMongoClient,
  getGlobalCollections,
  getTenantDB,
  connectTodb,
};
