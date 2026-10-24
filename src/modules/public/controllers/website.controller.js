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

const createSlug = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const matchesSlugOrId = (doc, identifier) => {
  if (!doc || !identifier) return false;
  const clean = String(identifier).trim().toLowerCase();
  const rawClean = clean.replace(/[^a-z0-9]/g, '');

  if (doc._id && String(doc._id).toLowerCase() === clean) return true;
  if (doc.id && String(doc.id).toLowerCase() === clean) return true;
  if (doc.slug && String(doc.slug).toLowerCase().replace(/[^a-z0-9]/g, '') === rawClean) return true;

  const docSlug = createSlug(doc.slug || doc.title || doc.name);
  if (docSlug && docSlug === rawClean) return true;

  return false;
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

async function fetchFormattedDynamicCourses() {
  const { internshipsCollection } = getGlobalCollections();
  const dynamicList = await internshipsCollection
    .find({ type: 'course', status: { $ne: 'inactive' } })
    .sort({ createdAt: -1 })
    .toArray();

  const fallbackImages = [
    'https://images.unsplash.com/photo-1587620962725-abab7fe55159?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1581291518857-4e27b48ff24e?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1451187580459-43490279c0fa?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1460925895917-afdab827c52f?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
  ];

  return dynamicList.map((c, index) => {
    const rawPrice = c.pricing?.finalPrice !== undefined ? Number(c.pricing.finalPrice) : Number(c.price);
    const price = !isNaN(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
    const rawOrig = c.pricing?.originalPrice ? Number(c.pricing.originalPrice) : (price > 0 ? Math.round(price * 1.5) : 0);
    const originalPrice = !isNaN(rawOrig) ? rawOrig : price;
    const discount = originalPrice > price && originalPrice > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;
    const isFree = price === 0;

    let weeks = 8;
    if (typeof c.duration === 'string') {
      const match = c.duration.match(/\d+/);
      if (match) {
        weeks = c.duration.toLowerCase().includes('month') ? parseInt(match[0]) * 4 : parseInt(match[0]);
      }
    } else if (typeof c.duration === 'number') {
      weeks = c.duration * 4;
    }

    const img = c.media?.thumbnailImage || c.media?.coverImage || c.media?.bannerImage || c.thumbnail || c.image || fallbackImages[index % fallbackImages.length];
    const previewImg = c.media?.coverImage || c.media?.thumbnailImage || c.media?.bannerImage || img;

    return {
      _id: c._id.toString(),
      id: c._id.toString(),
      title: c.title,
      category: c.category || 'Development',
      level: c.difficulty || 'Intermediate',
      rating: c.rating || 4.8,
      reviews: c.reviews || 120 + (index * 45),
      weeks: weeks || 8,
      lessons: c.sections?.length ? c.sections.length : (c.learningPoints?.length || 5),
      instructor: c.instructor || 'SkillMedha Faculty',
      instructorAvatar: 'instructor-2',
      price,
      originalPrice,
      discount,
      isFree,
      badge: isFree ? 'FREE' : c.trending ? 'TRENDING' : c.featured ? 'POPULAR' : 'FEATURED',
      badgeColor: isFree ? 'bg-emerald-500' : 'bg-primary',
      image: img,
      previewImage: previewImg,
      imageKey: null,
      subtitle: c.subtitle || `Master ${c.title} and elevate your career in ${c.category || 'tech'}.`,
      description: typeof c.description === 'string' ? c.description.replace(/<[^>]*>/g, '') : '',
      whatYoullLearn: Array.isArray(c.learningPoints) && c.learningPoints.length > 0
        ? c.learningPoints
        : [
            `Master the core concepts of ${c.title}.`,
            'Build real-world projects reflecting modern industry standards.',
            'Develop a portfolio-ready project to showcase your skills.'
          ],
      relatedTopics: Array.isArray(c.skills) && c.skills.length > 0 ? c.skills : [c.category || 'Programming'],
      requirements: Array.isArray(c.preRequisites) && c.preRequisites.length > 0
        ? c.preRequisites
        : ['Basic computer knowledge', 'Willingness to learn and practice'],
      totalDuration: c.courseIncludes?.videoDuration || `${(weeks || 8) * 2} hours`,
      courseIncludes: c.courseIncludes || {},
      status: c.status || 'active',
      order: index + 1,
      isDynamic: true,
      slug: (c.slug || c.title || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
      createdAt: c.createdAt
    };
  });
}

async function fetchFormattedDynamicInternships() {
  const { internshipsCollection } = getGlobalCollections();
  const dynamicList = await internshipsCollection
    .find({ type: 'internship', status: { $ne: 'inactive' } })
    .sort({ createdAt: -1 })
    .toArray();

  const fallbackImages = [
    'https://images.unsplash.com/photo-1587620962725-abab7fe55159?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1460925895917-afdab827c52f?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1581291518857-4e27b48ff24e?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
  ];

  const gradients = [
    'from-blue-600/80 to-indigo-900/90',
    'from-emerald-600/80 to-teal-900/90',
    'from-orange-600/80 to-rose-900/90',
    'from-fuchsia-600/80 to-purple-900/90',
  ];

  return dynamicList.map((i, index) => {
    const rawPrice = Number(i.price);
    const price = !isNaN(rawPrice) && rawPrice >= 0 ? rawPrice : 4999;
    const rawOrig = Number(i.originalPrice) || Math.round(price * 1.8);
    const originalPrice = rawOrig > price ? rawOrig : price;

    let durationStr = '3 Months';
    if (typeof i.duration === 'string') {
      durationStr = i.duration.includes('Month') ? i.duration : `${i.duration} Months`;
    } else if (typeof i.duration === 'number') {
      durationStr = `${i.duration} Months`;
    }

    const domain = i.domain || (
      (i.title || '').toLowerCase().includes('design') ? 'Design' :
      (i.title || '').toLowerCase().includes('marketing') ? 'Management' : 'Tech'
    );

    const schedule = i.schedule || (index % 2 === 0 ? 'Evening' : 'Weekends');
    const timing = i.timing || (schedule === 'Weekends' ? 'Sat - Sun | 10:00 AM - 02:00 PM' : 'Mon - Fri | 06:00 PM - 08:00 PM');
    const startDate = i.startDate || 'Upcoming Batch';

    const img = i.image || i.media?.thumbnailImage || i.media?.coverImage || fallbackImages[index % fallbackImages.length];

    return {
      _id: i._id.toString(),
      id: i._id.toString(),
      title: i.title,
      domain,
      duration: durationStr,
      schedule,
      startDate,
      timing,
      price,
      originalPrice,
      image: img,
      imageKey: `course-${(index % 4) + 1}`,
      gradient: i.gradient || gradients[index % gradients.length],
      badge: 'LIVE INTERNSHIP',
      badgeColor: 'bg-red-500',
      description: typeof i.description === 'string' ? i.description.replace(/<[^>]*>/g, '') : '',
      status: i.status || 'active',
      order: index + 1,
      isDynamic: true,
      slug: (i.slug || i.title || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
      createdAt: i.createdAt
    };
  });
}

module.exports.fetchFormattedDynamicCourses = fetchFormattedDynamicCourses;
module.exports.fetchFormattedDynamicInternships = fetchFormattedDynamicInternships;

module.exports.getWebsiteCourses = async (req, res) => {
  try {
    const { websiteCourses, websiteSettings } = getGlobalCollections();

    let mode;
    if (req.query.mode && ['static', 'dynamic'].includes(req.query.mode)) {
      mode = req.query.mode;
    } else {
      const setting = await websiteSettings.findOne({ key: 'courses_data_mode' });
      mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';
    }

    if (mode === 'static') {
      const staticCourses = await websiteCourses
        .find({ status: { $ne: 'inactive' } })
        .sort({ order: 1 })
        .toArray();

      const formattedStatic = staticCourses.map((c) => ({
        ...c,
        slug: c.slug || createSlug(c.title)
      }));

      return res.status(200).json({
        success: true,
        mode: 'static',
        count: formattedStatic.length,
        data: formattedStatic
      });
    }

    // Dynamic mode
    const dynamicCourses = await fetchFormattedDynamicCourses();

    return res.status(200).json({
      success: true,
      mode: 'dynamic',
      count: dynamicCourses.length,
      data: dynamicCourses
    });
  } catch (error) {
    console.error('[Public Website] Error fetching website courses:', error);
    return res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getWebsiteCourseDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { internshipsCollection, sectionsCollection, topicsCollection, websiteCourses, websiteSettings } = getGlobalCollections();

    let mode;
    if (req.query.mode && ['static', 'dynamic'].includes(req.query.mode)) {
      mode = req.query.mode;
    } else {
      const setting = await websiteSettings.findOne({ key: 'courses_data_mode' });
      mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';
    }

    let courseDoc = null;
    let isDynamicDoc = false;

    // 1. Try finding by MongoDB ObjectId in dynamic collection
    if (ObjectId.isValid(id) && id.length === 24) {
      courseDoc = await internshipsCollection.findOne({ _id: new ObjectId(id) });
      if (courseDoc) {
        isDynamicDoc = true;
      }
    }

    // 2. Try finding by slug or title in dynamic courses
    if (!courseDoc) {
      const dynamicCourses = await internshipsCollection.find({ type: 'course', status: { $ne: 'inactive' } }).toArray();
      const matched = dynamicCourses.find((c) => matchesSlugOrId(c, id));
      if (matched) {
        courseDoc = matched;
        isDynamicDoc = true;
      }
    }

    // 3. Try finding by slug, id, or _id in static courses
    if (!courseDoc) {
      const staticCourses = await websiteCourses.find({}).toArray();
      const matched = staticCourses.find((c) => matchesSlugOrId(c, id));
      if (matched) {
        courseDoc = matched;
        isDynamicDoc = false;
      }
    }

    // 4. Try numeric id in static collection
    if (!courseDoc && !isNaN(Number(id))) {
      courseDoc = await websiteCourses.findOne({ numericId: Number(id) });
    }

    // 5. If still not found and in dynamic mode, return first dynamic course as fallback
    if (!courseDoc && mode === 'dynamic') {
      courseDoc = await internshipsCollection.findOne({ type: 'course', status: { $ne: 'inactive' } });
      if (courseDoc) isDynamicDoc = true;
    }

    if (!courseDoc) {
      return res.status(404).json({ success: false, err: 'Course not found' });
    }

    const courseSlug = createSlug(courseDoc.slug || courseDoc.title);

    if (isDynamicDoc) {
      // Enrich with real sections and topics from MongoDB
      const sectionIds = (courseDoc.sections || []).map((s) => (typeof s === 'string' ? new ObjectId(s) : s));
      const sectionDocs = sectionIds.length
        ? await sectionsCollection.find({ _id: { $in: sectionIds } }).toArray()
        : [];

      const allSecIdStrs = sectionDocs.map((s) => s._id.toString());
      const allTopics = allSecIdStrs.length
        ? await topicsCollection.find({ sectionId: { $in: allSecIdStrs } }).toArray()
        : [];

      const enrichedSections = sectionDocs.map((s) => {
        const sId = s._id.toString();
        const secTopics = allTopics.filter((t) => t.sectionId === sId);
        return {
          title: s.title || s.name || 'Module',
          lectures: secTopics.length,
          duration: s.duration || (secTopics.length > 0 ? `${secTopics.length * 15}min` : '30min'),
          items: secTopics.map((t, idx) => ({
            title: t.title || t.name || `Topic ${idx + 1}`,
            type: t.type || 'video',
            duration: t.duration || '15:00',
            preview: idx === 0
          }))
        };
      });

      const rawPrice = courseDoc.pricing?.finalPrice !== undefined ? Number(courseDoc.pricing.finalPrice) : Number(courseDoc.price);
      const price = !isNaN(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
      const rawOrig = courseDoc.pricing?.originalPrice ? Number(courseDoc.pricing.originalPrice) : (price > 0 ? Math.round(price * 1.5) : 0);
      const originalPrice = !isNaN(rawOrig) ? rawOrig : price;
      const discount = originalPrice > price && originalPrice > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;
      const isFree = price === 0;

      let weeks = 8;
      if (typeof courseDoc.duration === 'string') {
        const match = courseDoc.duration.match(/\d+/);
        if (match) {
          weeks = courseDoc.duration.toLowerCase().includes('month') ? parseInt(match[0]) * 4 : parseInt(match[0]);
        }
      } else if (typeof courseDoc.duration === 'number') {
        weeks = courseDoc.duration * 4;
      }

      const img = courseDoc.media?.coverImage || courseDoc.media?.thumbnailImage || courseDoc.media?.bannerImage || courseDoc.image;

      const relatedTopics = Array.isArray(courseDoc.skills) && courseDoc.skills.length > 0
        ? courseDoc.skills.map((s) => (typeof s === 'object' && s.name ? s.name : typeof s === 'string' ? s : 'Skill'))
        : Array.isArray(courseDoc.tools) && courseDoc.tools.length > 0
          ? courseDoc.tools.map((t) => (typeof t === 'object' && t.name ? t.name : typeof t === 'string' ? t : 'Tool'))
          : [courseDoc.category || 'General'];

      const totalLects = enrichedSections.reduce((acc, s) => acc + s.lectures, 0);

      const dynamicCourseDetail = {
        _id: courseDoc._id.toString(),
        id: courseDoc._id.toString(),
        slug: courseSlug,
        title: courseDoc.title,
        subtitle: courseDoc.subtitle || `Master ${courseDoc.title} and elevate your career in ${courseDoc.category || 'your field'}.`,
        category: courseDoc.category || 'Development',
        level: courseDoc.difficulty || 'Intermediate',
        rating: courseDoc.rating || 4.8,
        reviewCount: courseDoc.reviews || 120,
        totalStudents: Math.floor((courseDoc.reviews || 120) * 4.5),
        weeks: weeks || 8,
        instructor: courseDoc.instructor || 'SkillMedha Faculty',
        instructorAvatar: 'instructor-2',
        price,
        originalPrice,
        discount,
        isFree,
        badge: isFree ? 'FREE' : courseDoc.trending ? 'TRENDING' : courseDoc.featured ? 'POPULAR' : 'FEATURED',
        badgeColor: isFree ? 'bg-emerald-500' : 'bg-primary',
        image: img,
        previewImage: img,
        breadcrumb: [courseDoc.category || 'General', `${courseDoc.difficulty || 'All'} Level`, 'Courses'],
        lastUpdated: '3/2026',
        language: courseDoc.language || 'English',
        hoursLeft: 8,
        whatYoullLearn: Array.isArray(courseDoc.learningPoints) && courseDoc.learningPoints.length > 0
          ? courseDoc.learningPoints
          : [
              `Master the core concepts of ${courseDoc.title}.`,
              'Build real-world projects reflecting modern industry standards.',
              'Develop a portfolio-ready project to showcase your skills.'
            ],
        relatedTopics,
        requirements: Array.isArray(courseDoc.preRequisites) && courseDoc.preRequisites.length > 0
          ? courseDoc.preRequisites
          : ['Basic computer knowledge', 'Willingness to learn and practice'],
        description: courseDoc.description || '',
        courseIncludes: courseDoc.courseIncludes || {},
        sections: enrichedSections.length > 0 ? enrichedSections : (
          (courseDoc.learningPoints && courseDoc.learningPoints.length > 0)
            ? courseDoc.learningPoints.map((lp, idx) => ({
                title: lp,
                lectures: 2,
                duration: '30min',
                items: [
                  { title: `${lp} - Overview & Principles`, type: 'video', duration: '15:00', preview: idx === 0 },
                  { title: `${lp} - Practical Implementation`, type: 'video', duration: '15:00', preview: false }
                ]
              }))
            : []
        ),
        totalSections: enrichedSections.length > 0 ? enrichedSections.length : (courseDoc.learningPoints?.length || 5),
        totalLectures: totalLects > 0 ? totalLects : ((courseDoc.learningPoints?.length || 5) * 2),
        totalDuration: courseDoc.courseIncludes?.videoDuration || `${(weeks || 8) * 2} hours`,
        isDynamic: true,
        pricing: courseDoc.pricing || null,
        couponCode: courseDoc.pricing?.couponCode || '',
        couponDiscount: Number(courseDoc.pricing?.couponDiscount) || 0,
        hasCoupon: Boolean(courseDoc.pricing?.couponCode && courseDoc.pricing.couponCode.trim().length > 0)
      };

      return res.status(200).json({ success: true, mode: 'dynamic', data: dynamicCourseDetail });
    }

    const staticCouponCode = courseDoc.pricing?.couponCode || courseDoc.couponCode || '';
    const staticCouponDiscount = Number(courseDoc.pricing?.couponDiscount || courseDoc.couponDiscount) || 0;
    const enrichedStaticDoc = {
      ...courseDoc,
      slug: courseSlug,
      couponCode: staticCouponCode,
      couponDiscount: staticCouponDiscount,
      hasCoupon: Boolean(staticCouponCode && staticCouponCode.trim().length > 0)
    };

    return res.status(200).json({ success: true, mode: 'static', data: enrichedStaticDoc });
  } catch (error) {
    console.error('[Public Website] Error fetching website course details:', error);
    return res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.checkWebsiteCourseCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const { internshipsCollection, websiteCourses, websiteInternships } = getGlobalCollections();

    let courseDoc = null;
    if (ObjectId.isValid(id) && id.length === 24) {
      courseDoc = await internshipsCollection.findOne({ _id: new ObjectId(id) });
    }
    if (!courseDoc) {
      const dynamicItems = await internshipsCollection.find({ status: { $ne: 'inactive' } }).toArray();
      courseDoc = dynamicItems.find((c) => matchesSlugOrId(c, id));
    }
    if (!courseDoc) {
      const staticCourses = await websiteCourses.find({}).toArray();
      courseDoc = staticCourses.find((c) => matchesSlugOrId(c, id));
    }
    if (!courseDoc && websiteInternships) {
      const staticInternships = await websiteInternships.find({}).toArray();
      courseDoc = staticInternships.find((c) => matchesSlugOrId(c, id));
    }
    if (!courseDoc && !isNaN(Number(id))) {
      courseDoc = (await websiteCourses.findOne({ numericId: Number(id) })) || (websiteInternships ? await websiteInternships.findOne({ numericId: Number(id) }) : null);
    }

    if (!courseDoc) {
      return res.status(404).json({ success: false, hasCoupon: false, message: 'There are no coupons available.' });
    }

    const couponCode = courseDoc.pricing?.couponCode || courseDoc.couponCode || '';
    const couponDiscount = Number(courseDoc.pricing?.couponDiscount || courseDoc.couponDiscount) || 0;
    const hasCoupon = Boolean(couponCode && couponCode.trim().length > 0);

    return res.status(200).json({
      success: true,
      hasCoupon,
      couponCode: hasCoupon ? couponCode.trim() : '',
      couponDiscount: hasCoupon ? couponDiscount : 0,
      message: hasCoupon ? 'Coupon is available' : 'There are no coupons available.'
    });
  } catch (error) {
    console.error('[Public Website] Error checking course coupon:', error);
    return res.status(500).json({ success: false, hasCoupon: false, message: 'There are no coupons available.', err: error.message });
  }
};

module.exports.getWebsiteInternships = async (req, res) => {
  try {
    const { websiteInternships, websiteSettings } = getGlobalCollections();

    let mode;
    if (req.query.mode && ['static', 'dynamic'].includes(req.query.mode)) {
      mode = req.query.mode;
    } else {
      const setting = await websiteSettings.findOne({ key: 'internships_data_mode' });
      mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';
    }

    if (mode === 'static') {
      const staticInternships = await websiteInternships
        .find({ status: { $ne: 'inactive' } })
        .sort({ order: 1 })
        .toArray();

      const formattedStatic = staticInternships.map((i) => ({
        ...i,
        slug: i.slug || createSlug(i.title)
      }));

      return res.status(200).json({
        success: true,
        mode: 'static',
        count: formattedStatic.length,
        data: formattedStatic
      });
    }

    // Dynamic mode
    const dynamicInternships = await fetchFormattedDynamicInternships();

    return res.status(200).json({
      success: true,
      mode: 'dynamic',
      count: dynamicInternships.length,
      data: dynamicInternships
    });
  } catch (error) {
    console.error('[Public Website] Error fetching website internships:', error);
    return res.status(500).json({ success: false, err: error.message });
  }
};

module.exports.getWebsiteInternshipDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { internshipsCollection, websiteInternships, websiteSettings } = getGlobalCollections();

    let mode;
    if (req.query.mode && ['static', 'dynamic'].includes(req.query.mode)) {
      mode = req.query.mode;
    } else {
      const setting = await websiteSettings.findOne({ key: 'internships_data_mode' });
      mode = setting?.value === 'dynamic' ? 'dynamic' : 'static';
    }

    let itemDoc = null;
    let isDynamicDoc = false;

    if (ObjectId.isValid(id) && id.length === 24) {
      itemDoc = await internshipsCollection.findOne({ _id: new ObjectId(id) });
      if (itemDoc) isDynamicDoc = true;
    }

    if (!itemDoc) {
      const dynamicInternships = await internshipsCollection
        .find({ type: { $in: ['internship', 'internships'] }, status: { $ne: 'inactive' } })
        .toArray();
      itemDoc = dynamicInternships.find((i) => matchesSlugOrId(i, id));
      if (itemDoc) isDynamicDoc = true;
    }

    if (!itemDoc) {
      const staticInternships = await websiteInternships.find({}).toArray();
      itemDoc = staticInternships.find((i) => matchesSlugOrId(i, id));
      if (itemDoc) isDynamicDoc = false;
    }

    if (!itemDoc && !isNaN(Number(id))) {
      itemDoc = await websiteInternships.findOne({ numericId: Number(id) });
    }

    if (!itemDoc && mode === 'dynamic') {
      itemDoc = await internshipsCollection.findOne({ type: 'internship', status: { $ne: 'inactive' } });
      if (itemDoc) isDynamicDoc = true;
    }

    if (!itemDoc) {
      return res.status(404).json({ success: false, err: 'Internship not found' });
    }

    const rawPrice = Number(itemDoc.price);
    const price = !isNaN(rawPrice) && rawPrice >= 0 ? rawPrice : 4999;
    const rawOrig = Number(itemDoc.originalPrice) || Math.round(price * 1.8);
    const originalPrice = rawOrig > price ? rawOrig : price;

    let durationStr = '3 Months';
    if (typeof itemDoc.duration === 'string') {
      durationStr = itemDoc.duration.includes('Month') ? itemDoc.duration : `${itemDoc.duration} Months`;
    } else if (typeof itemDoc.duration === 'number') {
      durationStr = `${itemDoc.duration} Months`;
    }

    const domain = itemDoc.domain || (
      (itemDoc.title || '').toLowerCase().includes('design') ? 'Design' :
      (itemDoc.title || '').toLowerCase().includes('marketing') ? 'Management' : 'Tech'
    );

    const schedule = itemDoc.schedule || 'Evening';
    const timing = itemDoc.timing || 'Mon - Fri | 06:00 PM - 08:00 PM';
    const startDate = itemDoc.startDate || 'Upcoming Batch';
    const img = itemDoc.image || itemDoc.media?.thumbnailImage || itemDoc.media?.coverImage || 'https://images.unsplash.com/photo-1587620962725-abab7fe55159?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80';
    const slug = createSlug(itemDoc.slug || itemDoc.title);

    return res.status(200).json({
      success: true,
      mode: isDynamicDoc ? 'dynamic' : 'static',
      data: {
        ...itemDoc,
        _id: itemDoc._id.toString(),
        id: itemDoc._id.toString(),
        slug,
        title: itemDoc.title,
        domain,
        duration: durationStr,
        schedule,
        startDate,
        timing,
        price,
        originalPrice,
        image: img,
        previewImage: img,
        badge: 'LIVE INTERNSHIP',
        badgeColor: 'bg-red-500',
        description: typeof itemDoc.description === 'string' ? itemDoc.description.replace(/<[^>]*>/g, '') : '',
        status: itemDoc.status || 'active',
        isDynamic: isDynamicDoc
      }
    });
  } catch (error) {
    console.error('[Public Website] Error fetching website internship details:', error);
    return res.status(500).json({ success: false, err: error.message });
  }
};
