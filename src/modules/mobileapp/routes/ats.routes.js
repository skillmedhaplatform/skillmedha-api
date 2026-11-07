'use strict';

const { Router } = require('express');
const multer = require('multer');
const { mandatory, optional } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const atsRouter = require('../../student/atsChecker/routes/ats');
const fileUploadRouter = require('../../student/atsChecker/routes/fileUpload');
const resumeCtrl = require('../../student/controllers/resume.controller');
const resumeCatalogSvc = require('../../student/services/resumeCatalog.service');

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = Router();

// ─── ATS Checker Analysis & Feedback ────────────────────────────────────────

// Mount ATS routes at /ats (e.g. /mobileapp/ats/analyze-existing, /history/:studentId, etc.)
router.use('/ats', atsRouter);

// Mount file upload routes at /api (e.g. /mobileapp/api/upload-resume, /api/resume/:studentId, /api/delete-resume)
router.use('/api', fileUploadRouter);

// ─── Resume Builder & Parsing ───────────────────────────────────────────────

// POST /mobileapp/createResume
router.post('/createResume', mandatory, selectTenantDB, resumeCtrl.createResume || ((req, res) => res.status(501).json({ error: 'Not implemented' })));

// POST /mobileapp/updateResume
router.post('/updateResume', mandatory, selectTenantDB, resumeCtrl.updateResume || ((req, res) => res.status(501).json({ error: 'Not implemented' })));

// POST /mobileapp/deleteResume
router.post('/deleteResume', mandatory, selectTenantDB, resumeCtrl.deleteResume || ((req, res) => res.status(501).json({ error: 'Not implemented' })));

// POST /mobileapp/parse-resume (Extract text & sections from uploaded resume)
router.post('/parse-resume', optional, memoryUpload.single('resume'), resumeCtrl.parseResume);

// ─── Resume Templates Catalog & Access ──────────────────────────────────────

// GET /mobileapp/resume-catalog
router.get('/resume-catalog', mandatory, resumeCatalogSvc.getResumeCatalog);

// POST /mobileapp/resume-templates/:key/authorize
router.post('/resume-templates/:key/authorize', mandatory, resumeCatalogSvc.authorizeTemplate);

module.exports = router;

