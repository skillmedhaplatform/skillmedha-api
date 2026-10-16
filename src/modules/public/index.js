const express = require('express');
const router = express.Router();

const reviewsRoutes = require('./routes/reviews.routes');
const websiteRoutes = require('./routes/website.routes');

router.use('/', reviewsRoutes);
router.use('/website', websiteRoutes);

module.exports = router;
