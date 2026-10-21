'use strict';

const express = require('express');
const router = express.Router();
const websiteController = require('../controllers/website.controller');

router.get('/practice', websiteController.getWebsitePractice);
router.get('/company-exams', websiteController.getWebsiteCompanyExams);

module.exports = router;
