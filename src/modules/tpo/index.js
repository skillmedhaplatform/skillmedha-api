'use strict';

const { Router } = require('express');
const multer = require('multer');

// ─── Middleware ───────────────────────────────────────────────────────────────
const { mandatory } = require('../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../shared/middleware/selectTenantDB.middleware');

// ─── Services ─────────────────────────────────────────────────────────────────
const assessmentsSvc   = require('./services/assessments.service');
const departmentsSvc   = require('./services/departments.service');
const noticeBoardSvc   = require('./services/noticeBoard.service');
const placementsSvc    = require('../student/services/placements.service');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, true) });

const router = Router();

// ─── Departments ──────────────────────────────────────────────────────────────
router.post('/createDepartment',               mandatory, selectTenantDB, departmentsSvc.createDepartment);
router.post('/updateDepartment/:id',           mandatory, selectTenantDB, departmentsSvc.updateDepartment);
router.get('/deleteDepartment/:id',            mandatory, selectTenantDB, departmentsSvc.deleteDepartment);
router.get('/getAllDepartments',               mandatory, selectTenantDB, departmentsSvc.getAllDepartments);
router.get('/getOneDepartmentsWithId/:id',    mandatory, selectTenantDB, departmentsSvc.getOneDepartmentsWithId);
router.get('/getStudentsInDepartments/:departmentId', mandatory, selectTenantDB, departmentsSvc.getStudentsInDepartments);
router.get('/getStudentsWithoutValidDepartment',      mandatory, selectTenantDB, departmentsSvc.getStudentsWithoutValidDepartment);
router.get('/getStudentsByOrgAndDepartment',  mandatory, selectTenantDB, departmentsSvc.getStudentsByOrgAndDepartment);

// ─── Notice Board ─────────────────────────────────────────────────────────────
router.post('/createNoticeBoard',              mandatory, selectTenantDB, noticeBoardSvc.createNoticeBoard);
router.post('/updateNoticeBoard/:id',          mandatory, selectTenantDB, noticeBoardSvc.updateNoticeBoard);
router.get('/setStatusActive/:id',             mandatory, selectTenantDB, noticeBoardSvc.setStatusActive);
router.get('/setStatusExpire/:id',             mandatory, selectTenantDB, noticeBoardSvc.setStatusExpire);
router.post('/getAllNoticeBoards',             mandatory, selectTenantDB, noticeBoardSvc.getAllNoticeBoards);
router.post('/getNoticeByStatus',             mandatory, selectTenantDB, noticeBoardSvc.getNoticeByStatus);
router.get('/getOneNoticeBoard/:id',          mandatory, selectTenantDB, noticeBoardSvc.getOneNoticeBoard);
router.get('/deleteNoticeBoard/:id',          mandatory, selectTenantDB, noticeBoardSvc.deleteNoticeBoard);
router.get('/getNoticeByStudent',             mandatory, selectTenantDB, noticeBoardSvc.getNoticeByStudent);

// ─── TPO Placements/Jobs management ────────────────────────────────────────
router.post('/createJobProfile',                mandatory, selectTenantDB, placementsSvc.createJobProfile);
router.post('/updateJobProfile/:profileId',     mandatory, selectTenantDB, placementsSvc.updateJobProfile);
router.post('/deleteJobProfile/:profileId',     mandatory, selectTenantDB, placementsSvc.deleteJobProfile);
router.get('/getOneJobProfile/:profileId',      mandatory, selectTenantDB, placementsSvc.getOneJobProfile);
router.get('/getAllJobProfiles',                 mandatory, selectTenantDB, placementsSvc.getAllJobProfiles);
router.post('/createAJob/:profileId',           mandatory, selectTenantDB, placementsSvc.createAJob);
router.post('/updateAJob/:jobId',               mandatory, selectTenantDB, placementsSvc.updateAJob);
router.post('/createJobAssessment/:jobId',      mandatory, selectTenantDB, placementsSvc.createJobAssessment);
router.post('/updateJobAssessment/:id',         mandatory, selectTenantDB, placementsSvc.updateJobAssessment);
router.get('/getOneJobAssessment/:id',          mandatory, selectTenantDB, placementsSvc.getOneJobAssessment);
router.get('/getAllJobAssessment',              mandatory, selectTenantDB, placementsSvc.getAllJobAssessment);
router.post('/getAllAppliedStudents',            mandatory, selectTenantDB, placementsSvc.getAllAppliedStudents);
router.get('/getJobAssessmentResultsByAssessmentId', mandatory, selectTenantDB, placementsSvc.getJobAssessmentResultsByAssessmentId);
router.post('/getAllAppliedStudentsWithAssesmentResults', mandatory, selectTenantDB, placementsSvc.getAllAppliedStudentsWithAssesmentResults);
router.post('/updateStudentAndJobStatus',       mandatory, selectTenantDB, placementsSvc.updateStudentAndJobStatus);
router.post('/addAssessmentToStudent',          mandatory, selectTenantDB, placementsSvc.addAssessmentToStudent);
router.post('/scheduleInterview',               mandatory, selectTenantDB, placementsSvc.scheduleInterview);
router.get('/getScheduledInterviewsForJob/:jobId', mandatory, selectTenantDB, placementsSvc.getScheduledInterviewsForJob);

// ─── Psychometric Test Results (from original main index) ────────────────────
const { getGlobalCollections, connectTodb } = require('../../shared/db/connection');
const mongoDB = require('mongodb');

router.post('/addPsychometricTestResults/:studentId', mandatory, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  try {
    const { studentId } = req.params;
    const covId = new mongoDB.ObjectId(studentId);
    const result = await student.updateOne(
      { _id: covId },
      { $set: { psychometricTestResults: req.body } }
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

router.get('/getPsychometricTestResults/:id', mandatory, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const covId = new mongoDB.ObjectId(id);
    const studentData = await student.findOne({ _id: covId });
    res.status(200).json({ data: studentData?.psychometricTestResults });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

module.exports = router;
