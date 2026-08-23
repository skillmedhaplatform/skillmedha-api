'use strict';

const { Router } = require('express');
const multer = require('multer');

// ─── Middleware ───────────────────────────────────────────────────────────────
const { mandatory } = require('../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../shared/middleware/selectTenantDB.middleware');

// ─── Services ─────────────────────────────────────────────────────────────────
const testsSvc     = require('./services/tests.service');
const questionsSvc = require('./services/questions.service');   // Express Router

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, true) });

const router = Router();

// ─── Test Portal (TPO creates / manages tests and questions) ──────────────────
router.get('/assessments/searchQuestions',                      mandatory, selectTenantDB, testsSvc.searchQuestions);
router.get('/assessments/searchtest',                           mandatory, selectTenantDB, testsSvc.searchTest);
router.get('/assessments/searchStudent',                        mandatory, selectTenantDB, testsSvc.searchStudent);
router.post('/assessments/addTest',                             mandatory, selectTenantDB, testsSvc.addTest);
router.post('/assessments/updateTest/:id',                      mandatory, selectTenantDB, testsSvc.updateTest);
router.post('/assessments/blockedStudents/:id',                 mandatory, selectTenantDB, testsSvc.blockStudentFromTest);
router.post('/assessments/unblockedStudents/:id',               mandatory, selectTenantDB, testsSvc.unblockStudentFromTest);
router.post('/assessments/deleteTest/:id',                      mandatory, selectTenantDB, testsSvc.deleteTest);
router.post('/assessments/changeQuestionsOrder/:testId',        mandatory, selectTenantDB, testsSvc.changeQuestionsOrder);
router.post('/assessments/addQuestion',                         mandatory, selectTenantDB, testsSvc.addQuestion);
router.get('/assessments/getQuestionLength',                    mandatory, selectTenantDB, testsSvc.getQuestionLength);
router.post('/assessments/updateQuestion/:questionId',          mandatory, selectTenantDB, testsSvc.updateQuestion);
router.post('/assessments/addQuestionToTest/:testId',           mandatory, selectTenantDB, testsSvc.addQuestionToTest);
router.post('/assessments/removeQuestionFromTest/:testId',      mandatory, selectTenantDB, testsSvc.removeQuestionFromTest);
router.post('/assessments/deleteQuestion',                      mandatory, selectTenantDB, testsSvc.deleteQuestion);
router.post('/assessments/addCategory',                         mandatory, selectTenantDB, testsSvc.addCategory);
router.delete('/assessments/deleteCategory',                    mandatory, selectTenantDB, testsSvc.deleteCategory);
router.post('/assessments/addLanguage',                         mandatory, selectTenantDB, testsSvc.addLanguage);
router.delete('/assessments/deleteLanguage',                    mandatory, selectTenantDB, testsSvc.deleteLanguage);
router.post('/assessments/sendTestAccessMail',                  mandatory, selectTenantDB, testsSvc.sendTestAccessMail);
router.post('/assessments/saveTestProgress',                    mandatory, selectTenantDB, testsSvc.saveTestProgress);
router.post('/assessments/updateProgress/:progressId',          mandatory, selectTenantDB, testsSvc.updateProgress);
router.post('/assessments/addAttempts/:studentId',              mandatory, selectTenantDB, testsSvc.addAttempts);
router.post('/assessments/createCompQuestion/:testId',          mandatory, selectTenantDB, testsSvc.createCompQuestion);
router.post('/assessments/updateCompQuestion/:id',              mandatory, selectTenantDB, testsSvc.updateCompQuestion);
router.post('/assessments/addQuestionToComprehension/:id',      mandatory, selectTenantDB, testsSvc.addQuestionToComprehension);
router.post('/assessments/deleteCompQuestion/:id',              mandatory, selectTenantDB, testsSvc.deleteCompQuestion);
router.post('/assessments/deleteQuestionFromComp/:id',          mandatory, selectTenantDB, testsSvc.deleteQuestionFromComp);
router.post('/assessments/getResultsData/:id',                  mandatory, selectTenantDB, testsSvc.getResultsData);
router.post('/assessments/bulkUploadQuestions/:testId',         mandatory, selectTenantDB, upload.single('file'), testsSvc.bulkUploadQuestions);
router.post('/assessments/bulkUploadQuestionstobank',           mandatory, selectTenantDB, upload.single('file'), testsSvc.bulkUploadQuestionsToBank);
router.post('/assessments/addBankQuestion',                     mandatory, selectTenantDB, testsSvc.addQuestionToBank);
router.post('/assessments/sendBulkTestAccessMail',              mandatory, selectTenantDB, testsSvc.sendBulkTestAccessMailBatched);
router.get('/assessments/getRecentTestResults/:studentId',      mandatory, selectTenantDB, testsSvc.getRecentTestResults);
router.post('/assessments/markOneTimeResultViewed/:id',         mandatory, selectTenantDB, testsSvc.markOneTimeResultViewed);

// ─── Questions Bank (TPO manages) ────────────────────────────────────────────
router.use('/questions', mandatory, selectTenantDB, questionsSvc);

module.exports = router;
