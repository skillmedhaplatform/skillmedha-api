'use strict';

const { Router } = require('express');
const { mandatory } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const placementsSvc = require('../../student/services/placements.service');
const externalJobsSvc = require('../../student/services/externalJobs.service');

const router = Router();

// ─── Campus Placements & Internal Jobs ──────────────────────────────────────

// GET /mobileapp/getAllJobs?page=&limit=
router.get('/getAllJobs', mandatory, selectTenantDB, placementsSvc.getAllJobs);

// GET /mobileapp/applyJob?jobId=&studentId=
router.get('/applyJob', mandatory, selectTenantDB, placementsSvc.applyJob);

// POST /mobileapp/getOneJob/:jobId
router.post('/getOneJob/:jobId', mandatory, selectTenantDB, placementsSvc.getOneJob);

// GET /mobileapp/getJobAssessmentResultsForStudent/:assessmentId/:studentId
router.get(
  '/getJobAssessmentResultsForStudent/:assessmentId/:studentId',
  mandatory,
  selectTenantDB,
  placementsSvc.getJobAssessmentResultsForStudent
);

// ─── External & Remote Jobs Board ───────────────────────────────────────────

// GET /mobileapp/external-jobs
router.get('/external-jobs', mandatory, selectTenantDB, externalJobsSvc.searchExternalJobs);

// GET /mobileapp/external-jobs/detail
router.get('/external-jobs/detail', mandatory, externalJobsSvc.getExternalJobDetail);

// GET /mobileapp/external-jobs/filters
router.get('/external-jobs/filters', mandatory, externalJobsSvc.getExternalJobFilters);

// GET /mobileapp/external-jobs/suggest
router.get('/external-jobs/suggest', mandatory, externalJobsSvc.suggestExternalJobs);

// GET /mobileapp/external-jobs/mine
router.get('/external-jobs/mine', mandatory, selectTenantDB, externalJobsSvc.getMyExternalJobs);

// POST /mobileapp/external-jobs/track
router.post('/external-jobs/track', mandatory, selectTenantDB, externalJobsSvc.trackExternalJob);

module.exports = router;

