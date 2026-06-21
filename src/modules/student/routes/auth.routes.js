'use strict';

const { Router } = require('express');
const { optional, mandatory } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const ctrl = require('../controllers/student.controller');

const router = Router();

// ─── Public routes (no auth required) ────────────────────────────────────────
router.post('/registerStudent', ctrl.registerStudent);
router.get('/verify', ctrl.verifyStudent);
router.get('/partnerColleges', ctrl.getPartnerColleges);
router.get('/getAllStudentsFromAllClgs', ctrl.getAllStudentsFromAllClgs);
router.get('/getStudentByGlobalIdAndOrgId', ctrl.getStudentByGlobalIdAndOrgId);
router.post('/loginStudent', ctrl.loginStudent);

// ─── Protected routes (auth + tenant DB required) ────────────────────────────
router.get('/', mandatory, selectTenantDB, ctrl.getStudent);
router.get('/getAllStudents', mandatory, selectTenantDB, ctrl.getAllStudents);
router.get('/getStudentCreds', mandatory, selectTenantDB, ctrl.getStudentCreds);
router.get('/getSingleStudent/:studentId', mandatory, selectTenantDB, ctrl.getSingleStudent);
router.post('/createStudentAccount', mandatory, selectTenantDB, ctrl.createStudentAccount);
router.post('/updateStudent', mandatory, selectTenantDB, ctrl.updateStudent);
router.post('/updateStudentWithId/:studentId', mandatory, selectTenantDB, ctrl.updateStudentWithId);
router.post('/deleteStudent/:userID', mandatory, selectTenantDB, ctrl.deleteStudent);
router.post('/deleteAllStudent/:deptId', mandatory, selectTenantDB, ctrl.deleteAllStudent);
router.post('/changeStudentEmail', mandatory, selectTenantDB, ctrl.changeStudentEmail);
router.post('/deleteAllStudentsFromOrg', mandatory, selectTenantDB, ctrl.deleteAllStudentsFromOrg);
router.get('/batches', mandatory, selectTenantDB, ctrl.getBatches);
router.post('/studentsByIDs', mandatory, selectTenantDB, ctrl.studentsByIDs);
router.get('/getAllStudentsAgg', mandatory, selectTenantDB, ctrl.getAllStudentsAgg);
router.get('/getStudentProgress', mandatory, selectTenantDB, ctrl.getStudentProgress);
router.post('/saveStudentNotes', mandatory, selectTenantDB,ctrl.saveStudentNotes);
router.get('/getStudentNotes', mandatory, selectTenantDB, ctrl.getStudentNotes);
router.put('/updateStudentNote/:noteId', mandatory, selectTenantDB, ctrl.updateStudentNote);
router.delete('/deleteStudentNote/:noteId', mandatory, selectTenantDB, ctrl.deleteStudentNote);

module.exports = router;
