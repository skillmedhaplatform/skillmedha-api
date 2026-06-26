'use strict';

const { getTenantDB } = require('../db/connection');
const { getGlobalCollections } = require('../db/connection');

/**
 * Resolves the tenant DB for the authenticated org and attaches it to req.tenantDB.
 * Identical behaviour to original shared/tenant/selectDbMiddleware.js.
 */
async function selectTenantDB(req, res, next) {
  const orgId = req.orgId;
  
  if (!orgId) return res.status(400).json({ error: 'Missing orgId' });

  try {
    const { organisation } = getGlobalCollections();
    const orgRecord = await organisation.findOne({ orgId });
    if (!orgRecord) {
      return res.status(404).json({ error: `Organization "${orgId}" not found` });
    }

    req.tenantDB = await getTenantDB(orgId);
    req.orgId = orgId;
    next();
  } catch (err) {
    console.error(`[selectTenantDB] Failed for org: ${orgId}`, err);
    return res.status(500).json({ error: 'Internal server error', details: err.message, stack: err.stack });
  }
}

module.exports = { selectTenantDB };
