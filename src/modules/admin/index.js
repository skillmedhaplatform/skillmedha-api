'use strict';

const { Router } = require('express');
const multer = require('multer');

// ─── Middleware ───────────────────────────────────────────────────────────────
const { optional, mandatory } = require('../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../shared/middleware/selectTenantDB.middleware');

// ─── Services ─────────────────────────────────────────────────────────────────
const authController = require('./services/adminusers.service');
const skillsController = require('./services/cms.service');
const razorpaySvc = require('./services/razorpay.service');
const paymentRouter = require('./services/payment.service');    // Express Router
const assessmentsSvc = require('../tpo/services/assessments.service');
const marqueeSvc = require('./services/marquee.service');
const practiceSvc = require('../student/services/practice.service');
const companySvc = require('./services/company.service');
const usersSvc = require('./services/users.service');
const tpoSvc = require('./services/tpo.service');
const internshipsSvc = require('./services/internships.service');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, true) });

const router = Router();

// ─── Payment (Razorpay — public webhook, private management) ──────────────────
router.use('/payment', paymentRouter);

// ─── CMS Admin Auth (AdminUser login/register) ────────────────────────────────
router.post('/cms/auth/login', authController.loginUser);
router.post('/cms/auth/register', authController.createUser);
router.get('/cms/auth/getadminuser', mandatory, authController.getCurrentUser);
router.post('/cms/auth/refresh', authController.refreshToken);
router.post('/cms/auth/logout', authController.logoutUser);
router.post('/cms/auth/change-password', authController.changePassword);
router.get('/cms/auth/users', mandatory, authController.getAllUsers);
router.put('/cms/auth/users/:userId', mandatory, authController.editUser);
router.delete('/cms/auth/users/:userId', mandatory, authController.deleteUser);

// ─── CMS Skills / Practice / Questions ───────────────────────────────────────
router.post('/cms/skills', mandatory, selectTenantDB, skillsController.addSkills);
router.get('/cms/skills', mandatory, selectTenantDB, skillsController.getSkills);
router.get('/cms/getOneSkill/:skillId', mandatory, selectTenantDB, skillsController.getOneSkill);
router.put('/cms/skills/:skillId', mandatory, selectTenantDB, skillsController.updateSkill);
router.delete('/cms/skills/:skillId', mandatory, selectTenantDB, skillsController.deleteSkill);
router.post('/cms/practices', mandatory, selectTenantDB, skillsController.addPractice);
router.get('/cms/practices', mandatory, selectTenantDB, skillsController.getPractice);
router.put('/cms/practices/:practiceId', mandatory, selectTenantDB, skillsController.updatePractice);
router.post('/cms/questions', mandatory, selectTenantDB, skillsController.addQuestions);
router.post('/cms/addQuestions', mandatory, selectTenantDB, skillsController.addQuestions);
router.get('/cms/questions', mandatory, selectTenantDB, skillsController.getQuestions);
router.get('/cms/getSingleQuestion/:id', mandatory, selectTenantDB, skillsController.getSingleQuestion);
router.get('/cms/questions/skills/:skillId', mandatory, selectTenantDB, skillsController.getSkillQuestions);
router.get('/cms/questions/practices/:practiceId', mandatory, selectTenantDB, skillsController.getPracticeQuestion);
router.put('/cms/questions/:questionId', mandatory, selectTenantDB, skillsController.updateQuestion);
router.delete('/cms/questions/:questionId', mandatory, selectTenantDB, skillsController.deleteQuestion);
router.get('/cms/categories', mandatory, selectTenantDB, skillsController.getCategories);
router.get('/cms/categories/:category/subcategories', mandatory, selectTenantDB, skillsController.getSubcategories);
router.get('/cms/categories/:category/subcategories/:subcategory/items', mandatory, selectTenantDB, skillsController.getItemsBySubcategory);

// ─── Razorpay Credentials Management ─────────────────────────────────────────
router.post('/cms/credentials', mandatory, razorpaySvc.saveRazorpayCredentials);
router.get('/cms/credentials', mandatory, razorpaySvc.getRazorpayCredentials);
router.delete('/cms/credentials', mandatory, razorpaySvc.deleteRazorpayCredentials);

// ─── Platform Assessments (Admin) ────────────────────────────────────────────
router.get('/getAllAssessments', mandatory, selectTenantDB, assessmentsSvc.getAllAssessments);
router.post('/createAssessment', mandatory, selectTenantDB, assessmentsSvc.createAssessment);
router.post('/updateAssessment', mandatory, selectTenantDB, assessmentsSvc.updateAssessment);
router.post('/deleteAssessment', mandatory, selectTenantDB, assessmentsSvc.deleteAssessment);
router.get('/getOneAssessment/:id', mandatory, selectTenantDB, assessmentsSvc.getOneAssessment);
router.post('/sendInvitations/:assessmentId', mandatory, selectTenantDB, assessmentsSvc.sendInvitations);
router.post('/assignAssessmentToTenant', mandatory, assessmentsSvc.assignAssessmentToTenant);

// ─── Practice management (Admin creates content) ──────────────────────────────
router.post('/subjects', mandatory, selectTenantDB, practiceSvc.createSubject);
router.put('/subjects/:subjectId', mandatory, selectTenantDB, practiceSvc.updateSubject);
router.delete('/subjects/:subjectId', mandatory, selectTenantDB, practiceSvc.deleteSubject);
router.post('/topics', mandatory, selectTenantDB, practiceSvc.createTopic);
router.put('/topics/:topicId', mandatory, selectTenantDB, practiceSvc.updateTopic);
router.delete('/topics/:topicId', mandatory, selectTenantDB, practiceSvc.deleteTopic);
router.post('/subtopics', mandatory, selectTenantDB, practiceSvc.createSubtopic);
router.put('/subtopics/:subtopicId', mandatory, selectTenantDB, practiceSvc.updateSubtopic);
router.delete('/subtopics/:subtopicId', mandatory, selectTenantDB, practiceSvc.deleteSubtopic);
router.post('/pracquestions', mandatory, selectTenantDB, practiceSvc.createQuestion);
router.post('/bulkUploadPracQuestions', mandatory, selectTenantDB, upload.single('file'), practiceSvc.bulkUploadPracQuestions);
router.put('/pracquestions/:questionId', mandatory, selectTenantDB, practiceSvc.updatePracQuestion);
router.delete('/pracquestions/:questionId', mandatory, selectTenantDB, practiceSvc.deletePracQuestion);

// ─── Marquee management (Admin creates/edits marquee notices) ─────────────────
router.get('/marquee', marqueeSvc.getMarqueeNotices);
router.post('/marquee', mandatory, upload.single('thumbnail'), marqueeSvc.createMarqueeNotice);
router.get('/marquee/settings', mandatory, marqueeSvc.getMarqueeSettings);
router.put('/marquee/settings', mandatory, marqueeSvc.updateMarqueeSettings);
router.put('/marquee/:id', mandatory, marqueeSvc.updateMarqueeNotice);
router.delete('/marquee/:id', mandatory, marqueeSvc.deleteMarqueeNotice);

// ─── Company ──────────────────────────────────────────────────────────────────
router.post('/createCompany', mandatory, selectTenantDB, companySvc.createCompany);
router.post('/loginCompany', mandatory, selectTenantDB, companySvc.loginCompany);
router.get('/getCompany', mandatory, selectTenantDB, companySvc.getCompany);
router.post('/updateCompany', mandatory, selectTenantDB, companySvc.updateCompany);
router.get('/getSkills', mandatory, companySvc.getAvailableSkills);
router.get('/organizations/:orgId/jobs/paginated', companySvc.getJobsByOrgPaginated);
router.get('/organizations/:orgId/users/paginated', companySvc.getUsersByOrgPaginated);
router.delete('/deleteHr/:hrId', mandatory, selectTenantDB, companySvc.deleteHr);

// ─── TPO Auth ─────────────────────────────────────────────────────────────────
router.post('/createTpo', mandatory, selectTenantDB, tpoSvc.createTpo);
router.post('/loginTpo', mandatory, selectTenantDB, tpoSvc.loginTpo);
router.get('/getTpo', mandatory, selectTenantDB, tpoSvc.getTpo);
router.post('/updateTpo', mandatory, selectTenantDB, tpoSvc.updateTpo);
router.put('/toggleTpoStatus/:tpoId', mandatory, selectTenantDB, tpoSvc.toggleTpoStatus);
router.delete('/deleteTpo/:tpoId', mandatory, selectTenantDB, tpoSvc.deleteTpo);

// ─── Auth / Organisation (from original users.js) ────────────────────────────
router.use('/', usersSvc);

// ─── Health check ─────────────────────────────────────────────────────────────
router.get('/cms/health', (req, res) => res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() }));

// ─── Internships (Admin manages: create/update/delete, student-facing: view/apply)
// Mount entire internships router (it handles auth internally per-route)
router.use('/internships', internshipsSvc);
router.use('/', internshipsSvc);

module.exports = router;
