'use strict';

const { ObjectId } = require('mongodb');
const { getGlobalCollections } = require('../../../shared/db/connection');
const { findInAllTenants } = require('../../student/services/practice.service');
const { helpers } = require('../../admin/services/practiceSets.service');

const CATEGORY_MAP = {
  nontechnical: 'Non-Technical',
  technical: 'Technical',
  coding: 'Coding'
};

const LEVEL_MAP = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  pro: 'Pro'
};

const formatDuration = (minutes) => {
  if (!minutes || minutes <= 0) return '45 mins';
  if (minutes < 60) return `${minutes} mins`;
  const hours = minutes / 60;
  return hours % 1 === 0 ? `${hours} hours` : `${hours.toFixed(1)} hours`;
};

async function fetchFormattedDynamicPractice() {
  const [publishedSets, publishedBundles] = await Promise.all([
    findInAllTenants('practiceSets', { status: 'published' }, 'find'),
    findInAllTenants('practiceBundles', { status: 'published' }, 'find')
  ]);

  // Exclude company-wise practice sets so they do not leak into the Practice Sets section
  const nonCompanySets = (publishedSets || []).filter(
    (s) =>
      s.category !== 'company' &&
      s.category !== 'company-wise' &&
      s.category !== 'Company-wise'
  );

  const detailedSets = await helpers.withTopicDetails(helpers.sortSets(nonCompanySets));

  const loadSetsByIds = (ids) =>
    ids.length ? findInAllTenants('practiceSets', { _id: { $in: ids } }, 'find') : [];

  const nonCompanyBundles = (publishedBundles || []).filter((b) => {
    const isCompanyCat =
      b.category === 'company' || b.category === 'company-wise' || b.category === 'Company-wise';
    return !isCompanyCat;
  });

  const detailedBundles = await helpers.withBundleSummary(
    nonCompanyBundles.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    loadSetsByIds
  );

  // Exclude bundles containing company-wise practice sets
  const practiceOnlyBundles = detailedBundles.filter((b) => {
    const cats = b.summary?.categories || [];
    return (
      !cats.includes('company') &&
      !cats.includes('company-wise') &&
      !cats.includes('Company-wise')
    );
  });

  // Map sets to uniform student-portal / website card schema
  const formattedSets = detailedSets.map((s) => {
    const catKey = (s.category || 'nontechnical').toLowerCase();
    const levelKey = (s.level || 'beginner').toLowerCase();
    const catLabel = CATEGORY_MAP[catKey] || s.category;
    const lvlLabel = LEVEL_MAP[levelKey] || s.level;
    const isFree = s.plan === 'free' || Number(s.price) === 0;

    return {
      _id: s._id.toString(),
      id: s._id.toString(),
      title: s.title,
      description: s.description || '',
      thumbnail: s.thumbnail || '',
      category: catLabel,
      categoryKey: catKey,
      level: lvlLabel,
      difficulty: s.difficulty || 'mixed',
      plan: s.plan || (isFree ? 'free' : 'premium'),
      isFree,
      price: Number(s.price) || 0,
      originalPrice: Number(s.mrp) || Number(s.price) || 0,
      mrp: Number(s.mrp) || Number(s.price) || 0,
      questionsCount: Number(s.questionCount) || 0,
      questionCount: Number(s.questionCount) || 0,
      duration: formatDuration(s.timeMinutes),
      timeMinutes: Number(s.timeMinutes) || 45,
      isBundle: false,
      topics: (s.topics || []).map((t) => t.topicTitle).filter(Boolean),
      rawTopics: s.topics || [],
      status: s.status || 'published',
      createdAt: s.createdAt
    };
  });

  // Map bundles to uniform student-portal / website card schema
  const formattedBundles = practiceOnlyBundles.map((b) => {
    const summary = b.summary || {};
    const catKey = (b.category || 'nontechnical').toLowerCase();
    const catLabel = CATEGORY_MAP[catKey] || 'Bundle';

    return {
      _id: b._id.toString(),
      id: b._id.toString(),
      title: b.title,
      description: b.description || '',
      thumbnail: b.thumbnail || '',
      category: catLabel,
      categoryKey: 'bundle',
      level: 'Bundle',
      plan: 'bundle',
      isFree: false,
      price: Number(b.price) || 0,
      originalPrice: Number(b.mrp) || summary.individualTotal || Number(b.price) || 0,
      mrp: Number(b.mrp) || summary.individualTotal || Number(b.price) || 0,
      questionsCount: summary.totalQuestions || 0,
      questionCount: summary.totalQuestions || 0,
      duration: formatDuration(summary.totalMinutes),
      timeMinutes: summary.totalMinutes || 0,
      isBundle: true,
      bundleDetails: {
        levelsIncluded: (summary.levels || []).map((l) => LEVEL_MAP[l] || l),
        topicsIncluded: summary.topicTitles?.length
          ? `All ${summary.topicTitles.length}+ Topics Included`
          : b.description || 'Comprehensive Topic Bundle',
        savings: summary.savings > 0 ? `Save ₹${summary.savings} compared to individual sets` : ''
      },
      summary,
      topics: summary.topicTitles || [],
      sets: b.sets || [],
      status: b.status || 'published',
      createdAt: b.createdAt
    };
  });

  return [...formattedSets, ...formattedBundles];
}

async function fetchFormattedDynamicCompanyExams() {
  const [publishedSets, publishedBundles] = await Promise.all([
    findInAllTenants(
      'practiceSets',
      {
        status: 'published',
        category: { $in: ['company', 'company-wise', 'Company-wise'] }
      },
      'find'
    ),
    findInAllTenants('practiceBundles', { status: 'published' }, 'find')
  ]);

  const detailedSets = await helpers.withTopicDetails(helpers.sortSets(publishedSets || []));

  const loadSetsByIds = (ids) =>
    ids.length ? findInAllTenants('practiceSets', { _id: { $in: ids } }, 'find') : [];

  const allDetailedBundles = await helpers.withBundleSummary(
    (publishedBundles || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    loadSetsByIds
  );

  const companyBundles = allDetailedBundles.filter((b) => {
    const isCompanyCat =
      b.category === 'company' || b.category === 'company-wise' || b.category === 'Company-wise';
    const cats = b.summary?.categories || [];
    return (
      isCompanyCat ||
      cats.includes('company') ||
      cats.includes('company-wise') ||
      cats.includes('Company-wise')
    );
  });

  const formattedSets = detailedSets.map((s, index) => {
    const levelKey = (s.level || 'intermediate').toLowerCase();
    const lvlLabel = LEVEL_MAP[levelKey] || s.level || 'Intermediate';
    const isFree = s.plan === 'free' || Number(s.price) === 0;

    const topicList = (s.topics || [])
      .map((t) => t.topicTitle || t.section || t.name)
      .filter(Boolean);

    const patternSections = (s.topics || []).map((t) => ({
      section: t.topicTitle || t.section || t.name || 'General Section',
      count: t.questionCount || 10
    }));

    const companyName = s.company || (s.title ? s.title.split(' ')[0] : 'Company');

    return {
      _id: s._id.toString(),
      id: s._id.toString(),
      title: s.title,
      description: s.description || '',
      thumbnail: s.thumbnail || '',
      image: s.thumbnail || '',
      category: 'Real-Time Exam Pattern Tests',
      categoryKey: 'company',
      company: companyName,
      level: lvlLabel,
      difficulty: s.difficulty || 'mixed',
      plan: s.plan || (isFree ? 'free' : 'premium'),
      isFree,
      price: Number(s.price) || 0,
      originalPrice: Number(s.mrp) || Number(s.price) || 0,
      mrp: Number(s.mrp) || Number(s.price) || 0,
      questionsCount: Number(s.questionCount) || 0,
      questionCount: Number(s.questionCount) || 0,
      duration: formatDuration(s.timeMinutes),
      timeMinutes: Number(s.timeMinutes) || 45,
      isBundle: false,
      isExamPattern: true,
      isCompany: true,
      topics: topicList,
      examDetails: {
        examName: s.title,
        pattern: patternSections
      },
      rawTopics: s.topics || [],
      status: s.status || 'published',
      createdAt: s.createdAt,
      order: index + 1
    };
  });

  const formattedBundles = companyBundles.map((b, index) => {
    const summary = b.summary || {};
    const companyName =
      b.company || (b.title ? b.title.split(',')[0].trim().split(' ')[0] : 'Company');

    return {
      _id: b._id.toString(),
      id: b._id.toString(),
      title: b.title,
      description: b.description || '',
      thumbnail: b.thumbnail || '',
      image: b.thumbnail || '',
      category: 'Real-Time Exam Pattern Tests',
      categoryKey: 'company',
      company: companyName,
      level: 'Bundle',
      plan: 'bundle',
      isFree: false,
      price: Number(b.price) || 0,
      originalPrice: Number(b.mrp) || summary.individualTotal || Number(b.price) || 0,
      mrp: Number(b.mrp) || summary.individualTotal || Number(b.price) || 0,
      questionsCount: summary.totalQuestions || 0,
      questionCount: summary.totalQuestions || 0,
      duration: formatDuration(summary.totalMinutes),
      timeMinutes: summary.totalMinutes || 0,
      isBundle: true,
      isExamPattern: true,
      isCompany: true,
      bundleDetails: {
        levelsIncluded: (summary.levels || []).map((l) => LEVEL_MAP[l] || l),
        topicsIncluded: summary.topicTitles?.length
          ? `All ${summary.topicTitles.length}+ Topics Included`
          : b.description || 'Comprehensive Exam Bundle',
        savings: summary.savings > 0 ? `Save ₹${summary.savings} compared to individual sets` : ''
      },
      summary,
      topics: summary.topicTitles || [],
      sets: b.sets || [],
      status: b.status || 'published',
      createdAt: b.createdAt,
      order: formattedSets.length + index + 1
    };
  });

  return [...formattedSets, ...formattedBundles];
}

module.exports.fetchFormattedDynamicPractice = fetchFormattedDynamicPractice;
module.exports.fetchFormattedDynamicCompanyExams = fetchFormattedDynamicCompanyExams;

module.exports.getWebsitePractice = async (req, res) => {
  try {
    const { websitePractice, websiteSettings } = getGlobalCollections();

    // 1. Check requested mode or current stored setting
    let mode;
    if (req.query.mode && ['static', 'dynamic'].includes(req.query.mode)) {
      mode = req.query.mode;
    } else {
      const setting = await websiteSettings.findOne({ key: 'practice_data_mode' });
      mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';
    }

    if (mode === 'static') {
      // 2a. Static mode: retrieve from website.practice collection
      const staticSets = await websitePractice
        .find({ status: { $ne: 'inactive' } })
        .sort({ order: 1 })
        .toArray();

      return res.status(200).json({
        success: true,
        mode: 'static',
        count: staticSets.length,
        data: staticSets
      });
    }

    // 2b. Dynamic mode
    const dynamicItems = await fetchFormattedDynamicPractice();

    return res.status(200).json({
      success: true,
      mode: 'dynamic',
      count: dynamicItems.length,
      data: dynamicItems
    });
  } catch (error) {
    console.error('[Public Website] Error fetching website practice sets:', error);
    return res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getWebsiteCompanyExams = async (req, res) => {
  try {
    const { websiteCompanyExams, websiteSettings } = getGlobalCollections();

    let mode;
    if (req.query.mode && ['static', 'dynamic'].includes(req.query.mode)) {
      mode = req.query.mode;
    } else {
      const setting = await websiteSettings.findOne({ key: 'company_data_mode' });
      mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';
    }

    if (mode === 'static') {
      const staticExams = await websiteCompanyExams
        .find({ status: { $ne: 'inactive' } })
        .sort({ order: 1 })
        .toArray();

      return res.status(200).json({
        success: true,
        mode: 'static',
        count: staticExams.length,
        data: staticExams
      });
    }

    // Dynamic mode
    const dynamicExams = await fetchFormattedDynamicCompanyExams();

    return res.status(200).json({
      success: true,
      mode: 'dynamic',
      count: dynamicExams.length,
      data: dynamicExams
    });
  } catch (error) {
    console.error('[Public Website] Error fetching website company exams:', error);
    return res.status(500).json({ success: false, err: error.message });
  }
};
