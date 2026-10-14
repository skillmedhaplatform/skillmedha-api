'use strict';

const cron = require('node-cron');
const { getGlobalCollections } = require('../../../../shared/db/connection');
const companies = require('./companies');
const { fetchCompanyJobs } = require('./providers');

const CONCURRENCY = 4;
let running = false;
let lastSync = null; // { startedAt, finishedAt, companiesOk, companiesFailed, jobs }

async function syncCompany(company, syncStartedAt) {
  const { externalJobs } = getGlobalCollections();
  const jobs = await fetchCompanyJobs(company);

  if (jobs.length) {
    await externalJobs.bulkWrite(
      jobs.map((job) => ({
        updateOne: {
          filter: { sourceKey: job.sourceKey },
          update: {
            $set: { ...job, lastSeenAt: syncStartedAt },
            $setOnInsert: { firstSeenAt: syncStartedAt },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  // Jobs the company has taken down are removed. Only runs after a successful
  // fetch, so a board that is briefly unreachable keeps its jobs.
  await externalJobs.deleteMany({
    companyKey: `${company.provider}:${company.slug}`,
    lastSeenAt: { $lt: syncStartedAt },
  });

  return jobs.length;
}

async function runJobBoardSync() {
  if (running) return lastSync;
  running = true;
  const startedAt = new Date();
  let companiesOk = 0;
  let companiesFailed = 0;
  let totalJobs = 0;

  try {
    for (let i = 0; i < companies.length; i += CONCURRENCY) {
      const batch = companies.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((c) => syncCompany(c, startedAt)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          companiesOk++;
          totalJobs += r.value;
        } else {
          companiesFailed++;
          console.warn(`[jobBoards] ${batch[idx].provider}:${batch[idx].slug} failed:`, r.reason?.message);
        }
      });
    }
    lastSync = { startedAt, finishedAt: new Date(), companiesOk, companiesFailed, jobs: totalJobs };
    console.log(`[jobBoards] sync done: ${totalJobs} India jobs from ${companiesOk} companies (${companiesFailed} failed)`);
  } catch (err) {
    console.error('[jobBoards] sync error:', err.message);
  } finally {
    running = false;
  }
  return lastSync;
}

function getLastSync() {
  return lastSync;
}

// Call once after the shared DB is connected.
function startJobBoardSync() {
  runJobBoardSync();
  // Every 3 hours, on the hour — keeps jobs fresh without hammering the boards
  cron.schedule('0 */3 * * *', runJobBoardSync);
}

module.exports = { startJobBoardSync, runJobBoardSync, getLastSync };
