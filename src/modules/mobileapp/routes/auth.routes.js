'use strict';

const { Router } = require('express');
const { mandatory, optional } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const studentRouter = require('../../student/services/studentRouter.service');
const usersSvc = require('../../admin/services/users.service');

const router = Router();

// ─── Authentication & Account Endpoints ─────────────────────────────────────

// POST /mobileapp/loginStudent
router.post('/loginStudent', (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// POST /mobileapp/studentLogin (alias)
router.post('/studentLogin', (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// POST /mobileapp/registerStudent
router.post('/registerStudent', (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// POST /mobileapp/forgotStudentPassword
router.post('/forgotStudentPassword', (req, res, next) => {
  usersSvc.handle(req, res, next);
});

// POST /mobileapp/resendVerifyEmail (Requires auth & tenant DB)
router.post('/resendVerifyEmail', mandatory, selectTenantDB, (req, res, next) => {
  studentRouter.handle(req, res, next);
});

// GET /mobileapp/verify (Email verification link)
router.get('/verify', (req, res, next) => {
  studentRouter.handle(req, res, next);
});

module.exports = router;

