'use strict';

const { Router } = require('express');
const { mandatory } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const studentCtrl = require('../../student/controllers/student.controller');

const router = Router();

// ─── Student Notes ──────────────────────────────────────────────────────────

// POST /mobileapp/saveStudentNotes
router.post('/saveStudentNotes', mandatory, selectTenantDB, studentCtrl.saveStudentNotes);

// GET /mobileapp/getStudentNotes
router.get('/getStudentNotes', mandatory, selectTenantDB, studentCtrl.getStudentNotes);

// PUT /mobileapp/updateStudentNote/:noteId
router.put('/updateStudentNote/:noteId', mandatory, selectTenantDB, studentCtrl.updateStudentNote);

// DELETE /mobileapp/deleteStudentNote/:noteId
router.delete('/deleteStudentNote/:noteId', mandatory, selectTenantDB, studentCtrl.deleteStudentNote);

module.exports = router;

