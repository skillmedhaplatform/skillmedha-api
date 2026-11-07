'use strict';

const { Router } = require('express');
const { mandatory } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const agoraSvc = require('../../proctoring/services/agora.service');
const proctoringRekognitionSvc = require('../../proctoring/services/proctoring.service');

const router = Router();

// ─── Agora Live Video Proctoring Sessions ───────────────────────────────────

// Mount entire agora router under /agora
router.use('/agora', mandatory, selectTenantDB, agoraSvc);

// ─── AWS Rekognition Facial Verification & Anti-Cheating ─────────────────────

// Mount entire proctoring rekognition router under /proctor
router.use('/proctor', mandatory, selectTenantDB, proctoringRekognitionSvc);

module.exports = router;

