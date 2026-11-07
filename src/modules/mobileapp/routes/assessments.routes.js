'use strict';

const { Router } = require('express');
const { mandatory } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const placementsSvc = require('../../student/services/placements.service');
const testsSvc = require('../../test/services/tests.service');

const router = Router();

// ─── Assigned Assessments & Questions ───────────────────────────────────────

// GET /mobileapp/getAssignedAssessments?page=&limit=
router.get('/getAssignedAssessments', mandatory, selectTenantDB, placementsSvc.getAssignedAssessments);

// GET /mobileapp/getOneAssessmentFromStudent/:assessmentId
router.get(
  '/getOneAssessmentFromStudent/:assessmentId',
  mandatory,
  selectTenantDB,
  placementsSvc.getOneAssessmentFromStudent
);

// ─── Assessment Progress, Submission & Evaluation ───────────────────────────

// POST /mobileapp/assessments/saveTestProgress (Submit test upon completion)
router.post('/assessments/saveTestProgress', mandatory, selectTenantDB, testsSvc.saveTestProgress);

// POST /mobileapp/assessments/updateProgress/:progressId (Autosave answers during test)
router.post('/assessments/updateProgress/:progressId', mandatory, selectTenantDB, testsSvc.updateProgress);

// POST /mobileapp/assessments/getResultsData/:id (Fetch test scoring and feedback)
router.post('/assessments/getResultsData/:id', mandatory, selectTenantDB, testsSvc.getResultsData);

// GET /mobileapp/assessments/getRecentTestResults/:studentId (Test attempts history)
router.get('/assessments/getRecentTestResults/:studentId', mandatory, selectTenantDB, testsSvc.getRecentTestResults);

// POST /mobileapp/assessments/markOneTimeResultViewed/:id (Invalidate one-time result view)
router.post('/assessments/markOneTimeResultViewed/:id', mandatory, selectTenantDB, testsSvc.markOneTimeResultViewed);

module.exports = router;

