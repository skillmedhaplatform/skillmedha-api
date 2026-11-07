'use strict';

const { Router } = require('express');
const mongoDB = require('mongodb');
const { mandatory, optional } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const { getGlobalCollections, connectTodb } = require('../../../shared/db/connection');
const studentCtrl = require('../../student/controllers/student.controller');
const studentRouter = require('../../student/services/studentRouter.service');
const noticeBoardSvc = require('../../tpo/services/noticeBoard.service');
const marqueeSvc = require('../../admin/services/marquee.service');

const router = Router();

// ─── Student Profile & Credentials ──────────────────────────────────────────

// GET /mobileapp/getStudentCreds
router.get('/getStudentCreds', mandatory, selectTenantDB, studentCtrl.getStudentCreds);

// GET /mobileapp/ (Fetch current authenticated student)
router.get('/', mandatory, selectTenantDB, (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// GET /mobileapp/getStudentByGlobalIdAndOrgId?globalId=&orgId=&includeJobs=true
router.get('/getStudentByGlobalIdAndOrgId', (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// POST /mobileapp/updateStudent (Update profile fields: education, experiences, projects, etc.)
router.post('/updateStudent', mandatory, selectTenantDB, (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// POST /mobileapp/updateStudentWithId/:studentId (Update profile with KYC face data)
router.post('/updateStudentWithId/:studentId', mandatory, selectTenantDB, (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// ─── Dashboard Stats & Notices ──────────────────────────────────────────────

// GET /mobileapp/dashboard/stats
router.get('/dashboard/stats', mandatory, selectTenantDB, studentCtrl.getDashboardStats);

// GET /mobileapp/getNoticeByStudent
router.get('/getNoticeByStudent', mandatory, selectTenantDB, noticeBoardSvc.getNoticeByStudent);

// GET /mobileapp/marquee
router.get('/marquee', marqueeSvc.getMarqueeNotices);

// ─── Universities & Colleges Metadata ───────────────────────────────────────

// GET /mobileapp/getAllUniversities
router.get('/getAllUniversities', async (req, res) => {
  const { colleges } = getGlobalCollections();
  try {
    const data = await colleges.distinct('universityName');
    res.status(200).json({ data });
  } catch (e) {
    res.status(500).json({ err: e.message });
  }
});

// GET /mobileapp/getColleges/:code
router.get('/getColleges/:code', async (req, res) => {
  const { colleges } = getGlobalCollections();
  try {
    const data = await colleges.find({ universityCode: req.params.code }).toArray();
    res.status(200).json({ data });
  } catch (e) {
    res.status(500).json({ err: e.message });
  }
});

// ─── Psychometric Results ───────────────────────────────────────────────────

// GET /mobileapp/getPsychometricTestResults/:id
router.get('/getPsychometricTestResults/:id', mandatory, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    let covId;
    try { covId = new mongoDB.ObjectId(id); } catch (_) { covId = id; }
    const studentData = await student.findOne({ $or: [{ _id: covId }, { globalId: id }] });
    res.status(200).json({ data: studentData?.psychometricTestResults || null });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

// POST /mobileapp/addPsychometricTestResults/:studentId
router.post('/addPsychometricTestResults/:studentId', mandatory, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  try {
    const { studentId } = req.params;
    let covId;
    try { covId = new mongoDB.ObjectId(studentId); } catch (_) { covId = studentId; }
    const result = await student.updateOne(
      { $or: [{ _id: covId }, { globalId: studentId }] },
      { $set: { psychometricTestResults: req.body } }
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

module.exports = router;

