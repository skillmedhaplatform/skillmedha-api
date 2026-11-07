'use strict';

const { Router } = require('express');

const authRoutes = require('./routes/auth.routes');
const profileRoutes = require('./routes/profile.routes');
const learnRoutes = require('./routes/learn.routes');
const notesRoutes = require('./routes/notes.routes');
const practiceRoutes = require('./routes/practice.routes');
const jobsRoutes = require('./routes/jobs.routes');
const assessmentsRoutes = require('./routes/assessments.routes');
const proctoringRoutes = require('./routes/proctoring.routes');
const atsRoutes = require('./routes/ats.routes');
const paymentsRoutes = require('./routes/payments.routes');
const aiRoutes = require('./routes/ai.routes');
const uploadRoutes = require('./routes/upload.routes');

const router = Router();

// ─── Mobile Health & Diagnostics ────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    module: 'SkillMedha Mobile App API',
    timestamp: new Date().toISOString(),
  });
});

// ─── Mount Domain Sub-Routers ───────────────────────────────────────────────
router.use('/', authRoutes);
router.use('/', profileRoutes);
router.use('/', learnRoutes);
router.use('/', notesRoutes);
router.use('/', practiceRoutes);
router.use('/', jobsRoutes);
router.use('/', assessmentsRoutes);
router.use('/', proctoringRoutes);
router.use('/', atsRoutes);
router.use('/', paymentsRoutes);
router.use('/', aiRoutes);
router.use('/', uploadRoutes);

module.exports = router;

