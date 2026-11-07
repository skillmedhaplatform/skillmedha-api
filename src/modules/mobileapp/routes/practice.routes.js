'use strict';

const { Router } = require('express');
const { mandatory } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const practiceSvc = require('../../student/services/practice.service');
const practiceCatalogSvc = require('../../student/services/practiceCatalog.service');
const companyTestsSvc = require('../../admin/services/companyTests.service');
const compilerCtrl = require('../../student/controllers/compiler.controller');

const router = Router();

// ─── Practice Subjects & Structure ──────────────────────────────────────────

// GET /mobileapp/subjects
router.get('/subjects', mandatory, selectTenantDB, practiceSvc.getAllSubjects);

// GET /mobileapp/subjects/type/:type
router.get('/subjects/type/:type', mandatory, selectTenantDB, practiceSvc.getSubjectsByType);

// GET /mobileapp/topics/subject/:subjectId
router.get('/topics/subject/:subjectId', mandatory, selectTenantDB, practiceSvc.getTopicsBySubject);

// GET /mobileapp/subtopics/topic/:topicId
router.get('/subtopics/topic/:topicId', mandatory, selectTenantDB, practiceSvc.getSubtopicsByTopic);

// GET /mobileapp/difficultyStats
router.get('/difficultyStats', mandatory, selectTenantDB, practiceSvc.getDifficultyStats);

// ─── Practice Execution & Results ───────────────────────────────────────────

// POST /mobileapp/startPractice
router.post('/startPractice', mandatory, selectTenantDB, practiceSvc.startPractice);

// POST /mobileapp/savePracResults/:pracId
router.post('/savePracResults/:pracId', mandatory, selectTenantDB, practiceSvc.savePracResults);

// GET /mobileapp/getStudentPracResults/:userId
router.get('/getStudentPracResults/:userId', mandatory, selectTenantDB, practiceSvc.getStudentPracResults);

// GET /mobileapp/getpracquestions
router.get('/getpracquestions', mandatory, selectTenantDB, practiceSvc.getQuestionsByTopicAndSubject);

// ─── Company Mock Tests ─────────────────────────────────────────────────────

// GET /mobileapp/company-tests
router.get('/company-tests', mandatory, selectTenantDB, companyTestsSvc.getCompanyTests);

// GET /mobileapp/practice/top-scores/:testId
router.get('/practice/top-scores/:testId', mandatory, selectTenantDB, practiceSvc.getTopMockScores);

// POST /mobileapp/practice/top-scores
router.post('/practice/top-scores', mandatory, selectTenantDB, practiceSvc.saveTopMockScore);

// ─── Practice Sets Catalog ──────────────────────────────────────────────────

// GET /mobileapp/practice-catalog
router.get('/practice-catalog', mandatory, selectTenantDB, practiceCatalogSvc.getPracticeCatalog);

// POST /mobileapp/practice-sets/:id/start
router.post('/practice-sets/:id/start', mandatory, selectTenantDB, practiceCatalogSvc.startPracticeSet);

// ─── Code Compiler Execution ────────────────────────────────────────────────

// POST /mobileapp/compiler/run
router.post('/compiler/run', mandatory, selectTenantDB, compilerCtrl.runCode);

module.exports = router;

