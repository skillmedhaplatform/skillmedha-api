'use strict';

const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ─── Middleware ───────────────────────────────────────────────────────────────
const { mandatory } = require('../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../shared/middleware/selectTenantDB.middleware');

// ─── Services ─────────────────────────────────────────────────────────────────
const agoraSvc       = require('./services/agora.service');       // Express Router
const proctoringRekognitionSvc = require('./services/proctoring.service'); // Router

const router = Router();

// Auth + tenant DB required for all proctoring routes.
// Scoped per sub-path (not a bare router.use()) — this router is mounted at
// '/' in app.js, so an unscoped router.use(mandatory) here would require auth
// for every request in the whole app, including unrelated routers mounted
// after it (aiRouter, dashboardRoutes, etc).
router.use('/agora', mandatory, selectTenantDB, agoraSvc);
router.use('/proctor', mandatory, selectTenantDB, proctoringRekognitionSvc);

// ─── Error handler for proctoring routes ─────────────────────────────────────
router.use((err, req, res, next) => {
  console.error('[PROCTORING ERROR]', err.message);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

module.exports = router;
