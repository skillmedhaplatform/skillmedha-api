'use strict';

const express = require('express');
const router = express.Router();
const websiteController = require('../controllers/website.controller');

router.get('/practice', websiteController.getWebsitePractice);
router.get('/company-exams', websiteController.getWebsiteCompanyExams);
router.get('/courses', websiteController.getWebsiteCourses);
router.get('/courses/:id', websiteController.getWebsiteCourseDetails);
router.get('/courses/:id/coupon', websiteController.checkWebsiteCourseCoupon);
router.get('/internships', websiteController.getWebsiteInternships);
router.get('/internships/:id', websiteController.getWebsiteInternshipDetails);
router.get('/internships/:id/coupon', websiteController.checkWebsiteCourseCoupon);

module.exports = router;
