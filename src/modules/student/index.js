'use strict';

const { Router } = require('express');
const multer = require('multer');
const path = require('path');

// ─── Middleware ───────────────────────────────────────────────────────────────
const { optional, mandatory } = require('../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../shared/middleware/selectTenantDB.middleware');

// ─── Services (original business logic, re-imported with fixed paths) ─────────
const studentRouter     = require('./services/studentRouter.service');
const atsChecker     = require('./atsChecker/server');

const resumeSvc         = require('./services/resume.service');
const placementsSvc     = require('./services/placements.service');
const practiceSvc       = require('./services/practice.service');


// ─── testPortal router (student-facing: progress, assigned tests) ─────────────
const testPortalRouter  = require('./services/testPortalRouter.service');
const studentCtrl       = require('./controllers/student.controller');

// ─── Multer config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, true) });

const router = Router();
//const atsRouter = require('./routes/atscheckerRoutes/ats');
//const fileUploadRouter = require('./routes/atscheckerRoutes/fileUpload');


// ─── Auth / Profile (student registration, login, profile management) ─────────
router.use('/', studentRouter);

router.use('/', atsChecker);

// ─── Resume ──────────────────────────────────────────────────────────────────
router.post('/createResume', mandatory, selectTenantDB, resumeSvc.createResume || ((req, res) => res.status(501).json({ error: 'Not implemented' })));
router.post('/updateResume', mandatory, selectTenantDB, resumeSvc.updateResume || ((req, res) => res.status(501).json({ error: 'Not implemented' })));
router.post('/deleteResume', mandatory, selectTenantDB, resumeSvc.deleteResume || ((req, res) => res.status(501).json({ error: 'Not implemented' })));

// ─── Placements / Jobs (student-facing) ──────────────────────────────────────
router.get('/getAllJobs',                      mandatory, selectTenantDB, placementsSvc.getAllJobs);
router.get('/applyJob',                        mandatory, selectTenantDB, placementsSvc.applyJob);
router.get('/setJobStatus',                    mandatory, selectTenantDB, placementsSvc.setJobStatus);
router.post('/getOneJob/:jobId',              mandatory, selectTenantDB, placementsSvc.getOneJob);
router.get('/getAllJobsBasedOnplacements',     mandatory, selectTenantDB, placementsSvc.getAllJobsBasedOnplacements);
router.get('/getAssignedAssessments',         mandatory, selectTenantDB, placementsSvc.getAssignedAssessments);
router.get('/getOneAssessmentFromStudent/:assessmentId', mandatory, selectTenantDB, placementsSvc.getOneAssessmentFromStudent);
router.get('/getJobAssessmentResultsForStudent',         mandatory, selectTenantDB, placementsSvc.getJobAssessmentResultsForStudent);

// ─── Practice (student-facing) ────────────────────────────────────────────────
router.get('/subjects',                        mandatory, selectTenantDB, practiceSvc.getAllSubjects);
router.get('/subjects/type/:type',             mandatory, selectTenantDB, practiceSvc.getSubjectsByType);
router.get('/topics/subject/:subjectId',       mandatory, selectTenantDB, practiceSvc.getTopicsBySubject);
router.get('/subtopics/topic/:topicId',        mandatory, selectTenantDB, practiceSvc.getSubtopicsByTopic);
router.get('/getpracquestions',               mandatory, selectTenantDB, practiceSvc.getQuestionsByTopicAndSubject);
router.post('/startPractice',                  mandatory, selectTenantDB, practiceSvc.startPractice);
router.post('/savePracResults/:pracId',        mandatory, selectTenantDB, practiceSvc.savePracResults);
router.get('/getStudentPracResults/:userId',   mandatory, selectTenantDB, practiceSvc.getStudentPracResults);


router.get('/dashboard/stats', mandatory, selectTenantDB, studentCtrl.getDashboardStats);

//router.use('/ats', optional, selectTenantDB, atsRouter);

//router.use('/api', optional, selectTenantDB, fileUploadRouter);

module.exports = router;
