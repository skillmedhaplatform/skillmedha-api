'use strict';

const { Router } = require('express');
const { mandatory, optional } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const internshipsSvc = require('../../admin/services/internships.service');
const courseCatalogSvc = require('../../student/services/courseCatalog.service');
const { getMeetingDetails } = require('../../../shared/utils/zoom');

const router = Router();

// ─── Course & Internship Listings ───────────────────────────────────────────

// POST /mobileapp/getAllCoursesCombo
router.post('/getAllCoursesCombo', (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/getAllInternshipsCombo
router.post('/getAllInternshipsCombo', (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/getAllCourses
router.post('/getAllCourses', (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/getAllInternships
router.post('/getAllInternships', (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/getAllWorkshops
router.post('/getAllWorkshops', (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// GET /mobileapp/getOneInternshipAuth/:id
router.get('/getOneInternshipAuth/:id', (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// GET /mobileapp/getOneTopic/:tid
router.get('/getOneTopic/:tid', (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// ─── Lesson Progress & Playback Tracking ────────────────────────────────────

// POST /mobileapp/updateVideoProgress
router.post('/updateVideoProgress', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/updateTotalProgress
router.post('/updateTotalProgress', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/updateLastAccessed
router.post('/updateLastAccessed', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/getMeetingDetails (Zoom Webinar / Live Session)
router.post('/getMeetingDetails', (req, res) => {
  getMeetingDetails(req, res);
});

// ─── Course Catalog & Enrolled Purchases ────────────────────────────────────

// GET /mobileapp/course-catalog
router.get('/course-catalog', mandatory, selectTenantDB, courseCatalogSvc.getCourseCatalog);

// GET /mobileapp/my-course-purchases
router.get('/my-course-purchases', mandatory, courseCatalogSvc.getMyCoursePurchases);

// ─── Cart Management ────────────────────────────────────────────────────────

// GET /mobileapp/cart
router.get('/cart', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/cart
router.post('/cart', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// DELETE /mobileapp/cart/:courseId
router.delete('/cart/:courseId', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// DELETE /mobileapp/cart (Clear all items)
router.delete('/cart', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// ─── Wishlist Management ────────────────────────────────────────────────────

// GET /mobileapp/wishlist
router.get('/wishlist', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// POST /mobileapp/wishlist
router.post('/wishlist', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

// DELETE /mobileapp/wishlist/:courseId
router.delete('/wishlist/:courseId', mandatory, selectTenantDB, (req, res, next) => {
  internshipsSvc.handle(req, res, next);
});

module.exports = router;

