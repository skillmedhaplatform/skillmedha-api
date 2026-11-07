'use strict';

const { Router } = require('express');
const paymentRouter = require('../../admin/services/payment.service');
const websiteController = require('../../public/controllers/website.controller');

const router = Router();

// ─── Razorpay Payment Orders & Verification ─────────────────────────────────

// Mount payment router at /payment
// Endpoints:
//   POST /mobileapp/payment/buyNow/createOrder
//   POST /mobileapp/payment/buyNow/verify
//   POST /mobileapp/payment/cart/createOrder
//   POST /mobileapp/payment/cart/verify
//   POST /mobileapp/payment/practice/createOrder
//   POST /mobileapp/payment/practice/verify
//   POST /mobileapp/payment/course/createOrder
//   POST /mobileapp/payment/course/verify
//   POST /mobileapp/payment/resume/createOrder
//   POST /mobileapp/payment/resume/verify
//   GET  /mobileapp/payment/getKey
router.use('/payment', paymentRouter);

// ─── Coupons & Discounts ────────────────────────────────────────────────────

// GET /mobileapp/coupon/course/:id
router.get('/coupon/course/:id', websiteController.checkWebsiteCourseCoupon);

// GET /mobileapp/coupon/internship/:id
router.get('/coupon/internship/:id', websiteController.checkWebsiteCourseCoupon);

// Alias to match web app public coupon URL
router.get('/api/public/website/courses/:id/coupon', websiteController.checkWebsiteCourseCoupon);
router.get('/api/public/website/internships/:id/coupon', websiteController.checkWebsiteCourseCoupon);

module.exports = router;

