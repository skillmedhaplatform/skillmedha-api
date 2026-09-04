const express = require('express');
const router = express.Router();
const { getReviews, createReview, incrementHelpful } = require('../controllers/reviews.controller');

router.get('/reviews', getReviews);
router.post('/reviews', createReview);
router.post('/reviews/:id/helpful', incrementHelpful);

module.exports = router;
