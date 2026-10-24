'use strict';

const { getGlobalCollections } = require('../../../shared/db/connection');
const { findInAllTenants } = require('../../student/services/practice.service');
const { defaultWebsitePracticeSets } = require('../../../shared/data/defaultWebsitePractice');
const { defaultWebsiteCompanyExams } = require('../../../shared/data/defaultWebsiteCompanyExams');
const { defaultWebsiteCourses } = require('../../../shared/data/defaultWebsiteCourses');
const { defaultWebsiteInternships } = require('../../../shared/data/defaultWebsiteInternships');

module.exports.getPracticeConfig = async (req, res) => {
  try {
    const { websitePractice, websiteSettings } = getGlobalCollections();

    const [setting, staticCount, publishedSetsCount, publishedBundlesCount] = await Promise.all([
      websiteSettings.findOne({ key: 'practice_data_mode' }),
      websitePractice.countDocuments({ status: { $ne: 'inactive' } }),
      findInAllTenants('practiceSets', { status: 'published' }, 'countDocuments').catch(() => 0),
      findInAllTenants('practiceBundles', { status: 'published' }, 'countDocuments').catch(() => 0)
    ]);

    const mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';

    res.status(200).json({
      success: true,
      data: {
        mode,
        staticCount,
        dynamicCount: (publishedSetsCount || 0) + (publishedBundlesCount || 0),
        publishedSetsCount: publishedSetsCount || 0,
        publishedBundlesCount: publishedBundlesCount || 0,
        lastUpdated: setting?.updatedAt || null,
        updatedBy: setting?.updatedBy || 'system'
      }
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching practice config:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.updatePracticeMode = async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['static', 'dynamic'].includes(mode)) {
      return res.status(400).json({ success: false, err: "Mode must be either 'static' or 'dynamic'" });
    }

    const { websiteSettings } = getGlobalCollections();
    const updatedBy = req.userID || req.adminUser?.email || 'admin';

    await websiteSettings.updateOne(
      { key: 'practice_data_mode' },
      {
        $set: {
          key: 'practice_data_mode',
          value: mode,
          updatedAt: new Date(),
          updatedBy
        }
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      msg: `Website Practice Sets mode successfully changed to ${mode}.`,
      mode
    });
  } catch (error) {
    console.error('[Admin Website] Error updating practice mode:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getStaticPracticeSets = async (req, res) => {
  try {
    const { websitePractice } = getGlobalCollections();
    const items = await websitePractice.find({}).sort({ order: 1 }).toArray();
    res.status(200).json({ success: true, count: items.length, data: items });
  } catch (error) {
    console.error('[Admin Website] Error fetching static practice sets:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.seedStaticPracticeSets = async (req, res) => {
  try {
    const { websitePractice, websiteSettings } = getGlobalCollections();

    // Re-seed all default static items
    await websitePractice.deleteMany({});
    const docs = defaultWebsitePracticeSets.map((s) => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await websitePractice.insertMany(docs);

    // Ensure mode setting exists
    const setting = await websiteSettings.findOne({ key: 'practice_data_mode' });
    if (!setting) {
      await websiteSettings.insertOne({
        key: 'practice_data_mode',
        value: 'static',
        updatedAt: new Date(),
        updatedBy: req.userID || 'admin'
      });
    }

    res.status(200).json({
      success: true,
      msg: `Successfully initialized ${docs.length} default static practice sets in website.practice collection.`,
      count: docs.length
    });
  } catch (error) {
    console.error('[Admin Website] Error seeding static practice sets:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getDynamicPracticePreview = async (req, res) => {
  try {
    const { fetchFormattedDynamicPractice } = require('../../public/controllers/website.controller');
    const dynamicSets = await fetchFormattedDynamicPractice();
    res.status(200).json({
      success: true,
      count: dynamicSets.length,
      data: dynamicSets
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching dynamic practice preview:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getCompanyConfig = async (req, res) => {
  try {
    const { websiteCompanyExams, websiteSettings } = getGlobalCollections();
    const { fetchFormattedDynamicCompanyExams } = require('../../public/controllers/website.controller');

    const [setting, staticCount, dynamicExams] = await Promise.all([
      websiteSettings.findOne({ key: 'company_data_mode' }),
      websiteCompanyExams.countDocuments({ status: { $ne: 'inactive' } }),
      fetchFormattedDynamicCompanyExams().catch(() => [])
    ]);

    const mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';
    const dynamicCount = Array.isArray(dynamicExams) ? dynamicExams.length : 0;

    res.status(200).json({
      success: true,
      data: {
        mode,
        staticCount,
        dynamicCount,
        publishedSetsCount: dynamicCount,
        lastUpdated: setting?.updatedAt || null,
        updatedBy: setting?.updatedBy || 'system'
      }
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching company config:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.updateCompanyMode = async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['static', 'dynamic'].includes(mode)) {
      return res.status(400).json({ success: false, err: "Mode must be either 'static' or 'dynamic'" });
    }

    const { websiteSettings } = getGlobalCollections();
    const updatedBy = req.userID || req.adminUser?.email || 'admin';

    await websiteSettings.updateOne(
      { key: 'company_data_mode' },
      {
        $set: {
          key: 'company_data_mode',
          value: mode,
          updatedAt: new Date(),
          updatedBy
        }
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      msg: `Website Company Mock Tests mode successfully changed to ${mode}.`,
      mode
    });
  } catch (error) {
    console.error('[Admin Website] Error updating company mode:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getStaticCompanyTests = async (req, res) => {
  try {
    const { websiteCompanyExams } = getGlobalCollections();
    const items = await websiteCompanyExams.find({}).sort({ order: 1 }).toArray();
    res.status(200).json({ success: true, count: items.length, data: items });
  } catch (error) {
    console.error('[Admin Website] Error fetching static company tests:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.seedStaticCompanyTests = async (req, res) => {
  try {
    const { websiteCompanyExams, websiteSettings } = getGlobalCollections();

    // Re-seed all default static company items
    await websiteCompanyExams.deleteMany({});
    const docs = defaultWebsiteCompanyExams.map((s) => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await websiteCompanyExams.insertMany(docs);

    // Ensure mode setting exists
    const setting = await websiteSettings.findOne({ key: 'company_data_mode' });
    if (!setting) {
      await websiteSettings.insertOne({
        key: 'company_data_mode',
        value: 'static',
        updatedAt: new Date(),
        updatedBy: req.userID || 'admin'
      });
    }

    res.status(200).json({
      success: true,
      msg: `Successfully initialized ${docs.length} default static company tests in website.companyExams collection.`,
      count: docs.length
    });
  } catch (error) {
    console.error('[Admin Website] Error seeding static company tests:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getDynamicCompanyPreview = async (req, res) => {
  try {
    const { fetchFormattedDynamicCompanyExams } = require('../../public/controllers/website.controller');
    const dynamicExams = await fetchFormattedDynamicCompanyExams();
    res.status(200).json({
      success: true,
      count: dynamicExams.length,
      data: dynamicExams
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching dynamic company preview:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

// ─── Courses Website Section ──────────────────────────────────────────────────

module.exports.getCoursesConfig = async (req, res) => {
  try {
    const { websiteCourses, websiteSettings, internshipsCollection } = getGlobalCollections();

    const [setting, staticCount, dynamicCoursesCount] = await Promise.all([
      websiteSettings.findOne({ key: 'courses_data_mode' }),
      websiteCourses.countDocuments({ status: { $ne: 'inactive' } }),
      internshipsCollection.countDocuments({ type: 'course', status: { $ne: 'inactive' } }).catch(() => 0)
    ]);

    const mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';

    res.status(200).json({
      success: true,
      data: {
        mode,
        staticCount,
        dynamicCount: dynamicCoursesCount || 0,
        publishedSetsCount: dynamicCoursesCount || 0,
        lastUpdated: setting?.updatedAt || null,
        updatedBy: setting?.updatedBy || 'system'
      }
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching courses config:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.updateCoursesMode = async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['static', 'dynamic'].includes(mode)) {
      return res.status(400).json({ success: false, err: "Mode must be either 'static' or 'dynamic'" });
    }

    const { websiteSettings } = getGlobalCollections();
    const updatedBy = req.userID || req.adminUser?.email || 'admin';

    await websiteSettings.updateOne(
      { key: 'courses_data_mode' },
      {
        $set: {
          key: 'courses_data_mode',
          value: mode,
          updatedAt: new Date(),
          updatedBy
        }
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      msg: `Website Courses Library mode successfully changed to ${mode}.`,
      mode
    });
  } catch (error) {
    console.error('[Admin Website] Error updating courses mode:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getStaticCourses = async (req, res) => {
  try {
    const { websiteCourses } = getGlobalCollections();
    const items = await websiteCourses.find({}).sort({ order: 1 }).toArray();
    res.status(200).json({ success: true, count: items.length, data: items });
  } catch (error) {
    console.error('[Admin Website] Error fetching static courses:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.seedStaticCourses = async (req, res) => {
  try {
    const { websiteCourses, websiteSettings } = getGlobalCollections();

    await websiteCourses.deleteMany({});
    const docs = defaultWebsiteCourses.map((s) => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await websiteCourses.insertMany(docs);

    const setting = await websiteSettings.findOne({ key: 'courses_data_mode' });
    if (!setting) {
      await websiteSettings.insertOne({
        key: 'courses_data_mode',
        value: 'static',
        updatedAt: new Date(),
        updatedBy: req.userID || 'admin'
      });
    }

    res.status(200).json({
      success: true,
      msg: `Successfully initialized ${docs.length} default static courses in website.courses collection.`,
      count: docs.length
    });
  } catch (error) {
    console.error('[Admin Website] Error seeding static courses:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getDynamicCoursesPreview = async (req, res) => {
  try {
    const { fetchFormattedDynamicCourses } = require('../../public/controllers/website.controller');
    const dynamicCourses = await fetchFormattedDynamicCourses();
    res.status(200).json({
      success: true,
      count: dynamicCourses.length,
      data: dynamicCourses
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching dynamic courses preview:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

// ─── Internships Website Section ──────────────────────────────────────────────

module.exports.getInternshipsConfig = async (req, res) => {
  try {
    const { websiteInternships, websiteSettings, internshipsCollection } = getGlobalCollections();

    const [setting, staticCount, dynamicInternshipsCount] = await Promise.all([
      websiteSettings.findOne({ key: 'internships_data_mode' }),
      websiteInternships.countDocuments({ status: { $ne: 'inactive' } }),
      internshipsCollection.countDocuments({ type: 'internship', status: { $ne: 'inactive' } }).catch(() => 0)
    ]);

    const mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';

    res.status(200).json({
      success: true,
      data: {
        mode,
        staticCount,
        dynamicCount: dynamicInternshipsCount || 0,
        publishedSetsCount: dynamicInternshipsCount || 0,
        lastUpdated: setting?.updatedAt || null,
        updatedBy: setting?.updatedBy || 'system'
      }
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching internships config:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.updateInternshipsMode = async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['static', 'dynamic'].includes(mode)) {
      return res.status(400).json({ success: false, err: "Mode must be either 'static' or 'dynamic'" });
    }

    const { websiteSettings } = getGlobalCollections();
    const updatedBy = req.userID || req.adminUser?.email || 'admin';

    await websiteSettings.updateOne(
      { key: 'internships_data_mode' },
      {
        $set: {
          key: 'internships_data_mode',
          value: mode,
          updatedAt: new Date(),
          updatedBy
        }
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      msg: `Website Internship Opportunities mode successfully changed to ${mode}.`,
      mode
    });
  } catch (error) {
    console.error('[Admin Website] Error updating internships mode:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getStaticInternships = async (req, res) => {
  try {
    const { websiteInternships } = getGlobalCollections();
    const items = await websiteInternships.find({}).sort({ order: 1 }).toArray();
    res.status(200).json({ success: true, count: items.length, data: items });
  } catch (error) {
    console.error('[Admin Website] Error fetching static internships:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.seedStaticInternships = async (req, res) => {
  try {
    const { websiteInternships, websiteSettings } = getGlobalCollections();

    await websiteInternships.deleteMany({});
    const docs = defaultWebsiteInternships.map((s) => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await websiteInternships.insertMany(docs);

    const setting = await websiteSettings.findOne({ key: 'internships_data_mode' });
    if (!setting) {
      await websiteSettings.insertOne({
        key: 'internships_data_mode',
        value: 'static',
        updatedAt: new Date(),
        updatedBy: req.userID || 'admin'
      });
    }

    res.status(200).json({
      success: true,
      msg: `Successfully initialized ${docs.length} default static internships in website.internships collection.`,
      count: docs.length
    });
  } catch (error) {
    console.error('[Admin Website] Error seeding static internships:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getDynamicInternshipsPreview = async (req, res) => {
  try {
    const { fetchFormattedDynamicInternships } = require('../../public/controllers/website.controller');
    const dynamicInternships = await fetchFormattedDynamicInternships();
    res.status(200).json({
      success: true,
      count: dynamicInternships.length,
      data: dynamicInternships
    });
  } catch (error) {
    console.error('[Admin Website] Error fetching dynamic internships preview:', error);
    res.status(500).json({ success: false, err: error.message });
  }
};

