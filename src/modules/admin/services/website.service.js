'use strict';

const { getGlobalCollections } = require('../../../shared/db/connection');
const { findInAllTenants } = require('../../student/services/practice.service');
const { defaultWebsitePracticeSets } = require('../../../shared/data/defaultWebsitePractice');

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

