'use strict';

const { Router } = require('express');
const multer = require('multer');
const { mandatory, optional } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const ctrl = require('../controllers/resume.controller');

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = Router();

router.post('/createResume', mandatory, selectTenantDB, ctrl.createResume);
router.post('/updateResume', mandatory, selectTenantDB, ctrl.updateResume);
router.post('/deleteResume', mandatory, selectTenantDB, ctrl.deleteResume);
router.post('/parse-resume', optional, memoryUpload.single('resume'), ctrl.parseResume);

module.exports = router;
