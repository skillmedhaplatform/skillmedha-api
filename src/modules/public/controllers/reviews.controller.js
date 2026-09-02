const { getReviewsDB } = require('../../../shared/db/connection');
const { ObjectId } = require('mongodb');

const formatCollectionName = (programName) => {
    if (!programName) return 'general';
    return programName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
};

const createReview = async (req, res, next) => {
    try {
        const db = getReviewsDB();
        const { name, email, program, customProgram, rating, text, phone } = req.body;
        
        if (!name || !email || !program || !rating || !text) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        let finalProgram = program;

        if (program === 'Others' || program === 'Other') {
            finalProgram = customProgram || 'Others';
        }
        
        let collectionName = formatCollectionName(finalProgram);

        const reviewData = {
            name,
            email,
            phone: phone || null,
            program: finalProgram,
            rating: Number(rating),
            text,
            createdAt: new Date(),
            verified: false,
            helpful: 0
        };

        const result = await db.collection(collectionName).insertOne(reviewData);

        res.status(201).json({ success: true, message: 'Review created successfully', data: { ...reviewData, _id: result.insertedId } });
    } catch (error) {
        next(error);
    }
};

const getReviews = async (req, res, next) => {
    try {
        const db = getReviewsDB();
        const { program, limit = 20, page = 1 } = req.query;
        
        const skip = (Number(page) - 1) * Number(limit);
        let allReviews = [];
        
        if (program && program !== 'all') {
            let collectionName = formatCollectionName(program);
            allReviews = await db.collection(collectionName)
                .find({})
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .toArray();
        } else {
            const collections = await db.listCollections().toArray();
            let promises = collections.map(col => {
                return db.collection(col.name).find({}).sort({ createdAt: -1 }).limit(Number(limit)).toArray();
            });
            const results = await Promise.all(promises);
            allReviews = results.flat().sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + Number(limit));
        }

    res.status(200).json({ success: true, data: allReviews });
    } catch (error) {
        next(error);
    }
};

const incrementHelpful = async (req, res, next) => {
    try {
        const db = getReviewsDB();
        const { id } = req.params;
        const { program } = req.body;
        
        if (!id || !program) {
            return res.status(400).json({ success: false, message: 'Missing review id or program' });
        }
        
        const collectionName = formatCollectionName(program);
        const result = await db.collection(collectionName).updateOne(
            { _id: new ObjectId(id) },
            { $inc: { helpful: 1 } }
        );
        
        if (result.modifiedCount === 0) {
            return res.status(404).json({ success: false, message: 'Review not found' });
        }
        
        res.status(200).json({ success: true, message: 'Helpful count updated' });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    createReview,
    getReviews,
    incrementHelpful
};
