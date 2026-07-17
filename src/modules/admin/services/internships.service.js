require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});
const express = require("express");
const { json, urlencoded } = require("express");
const mongoDb = require("mongodb");
const mongoDB = require("mongodb");
const cors = require("cors");

// const multer = require("multer");
// const xlsx = require("xlsx");
// const fs = require("fs");
// const path = require("path");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const { getTenantDB } = require("../../../shared/db/connection");
const { internshipsCollection, mainDBusers, zoomMeetingsCollection } = require("../../../shared/db/connection").getGlobalCollections();

const app = express.Router();
const port = 2006;




app.post("/getAllInternShips", async (req, res) => {
  const internships = internshipsCollection;
  try {
    const { limit, cursor } = req.body;
    let realCursor = cursor;

    if (
      realCursor === null ||
      realCursor === undefined ||
      realCursor === "null" ||
      realCursor === ""
    ) {
      realCursor = null;
    }

    const covLimit = Number(limit);
    const baseMatch = { type: "internship" };

    const pipeline = [
      ...(realCursor
        ? [
          {
            $match: {
              ...baseMatch,
              _id: { $gt: new mongoDB.ObjectId(realCursor) },
            },
          },
        ]
        : [{ $match: baseMatch }]),
      { $limit: covLimit + 1 },
    ];

    const internShipsdata = await internships.aggregate(pipeline).toArray();
    const hasNext = internShipsdata.length > covLimit;
    const results = hasNext
      ? internShipsdata.slice(0, covLimit)
      : internShipsdata;
    const nextCursor = hasNext
      ? results[results.length - 1]._id.toString()
      : null;

    res.status(200).json({ data: results, hasNext, nextCursor });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/getAllCourses", async (req, res) => {
  const internships = internshipsCollection;
  try {
    const { limit, cursor } = req.body;
    let realCursor = cursor;

    if (
      realCursor === null ||
      realCursor === undefined ||
      realCursor === "null" ||
      realCursor === ""
    ) {
      realCursor = null;
    }

    const covLimit = Number(limit);
    const baseMatch = { type: "course" };

    const pipeline = [
      ...(realCursor
        ? [
          {
            $match: {
              ...baseMatch,
              _id: { $gt: new mongoDB.ObjectId(realCursor) },
            },
          },
        ]
        : [{ $match: baseMatch }]),
      { $limit: covLimit + 1 },
    ];

    const internShipsdata = await internships.aggregate(pipeline).toArray();
    const hasNext = internShipsdata.length > covLimit;
    const results = hasNext
      ? internShipsdata.slice(0, covLimit)
      : internShipsdata;
    const nextCursor = hasNext
      ? results[results.length - 1]._id.toString()
      : null;

    res.status(200).json({ data: results, hasNext, nextCursor });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});
app.post("/getAllWorkshops", async (req, res) => {
  const internships = internshipsCollection;
  try {
    const { limit, cursor } = req.body;
    let realCursor = cursor;

    if (
      realCursor === null ||
      realCursor === undefined ||
      realCursor === "null" ||
      realCursor === ""
    ) {
      realCursor = null;
    }

    const covLimit = Number(limit);
    const baseMatch = { type: "workshops" };

    const pipeline = [
      ...(realCursor
        ? [
          {
            $match: {
              ...baseMatch,
              _id: { $gt: new mongoDB.ObjectId(realCursor) },
            },
          },
        ]
        : [{ $match: baseMatch }]),
      { $limit: covLimit + 1 },
    ];

    const internShipsdata = await internships.aggregate(pipeline).toArray();
    const hasNext = internShipsdata.length > covLimit;
    const results = hasNext
      ? internShipsdata.slice(0, covLimit)
      : internShipsdata;
    const nextCursor = hasNext
      ? results[results.length - 1]._id.toString()
      : null;

    res.status(200).json({ data: results, hasNext, nextCursor });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

// internshipsCollection search API with regex support
app.get("/search", async (req, res) => {
  try {
    const {
      query = "",
      category,
      difficulty,
      language,
      type,
      status = "active",
      featured,
      trending,
      minPrice,
      maxPrice,
      tags,
      skills,
      page = 1,
      limit = 12,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Build search filter
    const searchFilter = {};

    // Text search across multiple fields using regex
    if (query && query.trim().length > 0) {
      const searchRegex = new RegExp(query.trim(), "i"); // case-insensitive

      searchFilter.$or = [
        { title: searchRegex },
        { subtitle: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
        { subcategories: searchRegex },
        { tags: searchRegex },
        { skills: searchRegex },
        { "toolsWithIcons.name": searchRegex },
        { targetAudience: searchRegex },
        { "seoMetadata.keywords": searchRegex },
        { "seoMetadata.metaTitle": searchRegex },
        { "seoMetadata.metaDescription": searchRegex },
      ];
    }

    // Category filter (exact match or regex)
    if (category) {
      searchFilter.category = new RegExp(category, "i");
    }

    // Difficulty filter
    if (difficulty) {
      searchFilter.difficulty = difficulty;
    }

    // Language filter
    if (language) {
      searchFilter.language = new RegExp(language, "i");
    }

    // Type filter (course, internship, etc.)
    if (type) {
      searchFilter.type = type;
    }

    // Status filter (active, draft, archived)
    if (status) {
      searchFilter.status = status;
    }

    // Featured filter
    if (featured !== undefined) {
      searchFilter.featured = featured === "true";
    }

    // Trending filter
    if (trending !== undefined) {
      searchFilter.trending = trending === "true";
    }

    // Price range filter
    if (minPrice || maxPrice) {
      searchFilter["pricing.finalPrice"] = {};

      if (minPrice) {
        searchFilter["pricing.finalPrice"].$gte = parseFloat(minPrice);
      }

      if (maxPrice) {
        searchFilter["pricing.finalPrice"].$lte = parseFloat(maxPrice);
      }
    }

    // Tags filter (match any tag)
    if (tags) {
      const tagsArray = Array.isArray(tags) ? tags : tags.split(",");
      searchFilter.tags = {
        $in: tagsArray.map((tag) => new RegExp(tag.trim(), "i")),
      };
    }

    // Skills filter (match any skill)
    if (skills) {
      const skillsArray = Array.isArray(skills) ? skills : skills.split(",");
      searchFilter.skills = {
        $in: skillsArray.map((skill) => new RegExp(skill.trim(), "i")),
      };
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Sort options
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Execute query with pagination
    const [courses, totalCount] = await Promise.all([
      internshipsCollection
        .find(searchFilter)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .select("-__v") // Exclude version key
        .lean(),
      internshipsCollection.countDocuments(searchFilter),
    ]);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / parseInt(limit));
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    res.status(200).json({
      success: true,
      data: courses,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalResults: totalCount,
        resultsPerPage: parseInt(limit),
        hasNextPage,
        hasPrevPage,
      },
      filters: {
        query,
        category,
        difficulty,
        language,
        type,
        status,
        featured,
        trending,
        minPrice,
        maxPrice,
        tags,
        skills,
      },
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({
      success: false,
      message: "Error searching courses",
      error: error.message,
    });
  }
});

// Advanced search with multiple filters and aggregation
app.get("/search/advanced", async (req, res) => {
  try {
    const {
      query = "",
      categories = [],
      difficulties = [],
      languages = [],
      types = [],
      minPrice,
      maxPrice,
      minDuration,
      maxDuration,
      hasVideoContent,
      hasCertificate,
      hasJobAssistance,
      toolNames = [],
      page = 1,
      limit = 12,
    } = req.query;

    const matchStage = { status: "active" };

    // Text search
    if (query && query.trim().length > 0) {
      const searchRegex = new RegExp(query.trim(), "i");
      matchStage.$or = [
        { title: searchRegex },
        { subtitle: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
      ];
    }

    // Multiple categories
    if (categories.length > 0) {
      const categoriesArray = Array.isArray(categories)
        ? categories
        : categories.split(",");
      matchStage.category = {
        $in: categoriesArray.map((cat) => new RegExp(cat.trim(), "i")),
      };
    }

    // Multiple difficulties
    if (difficulties.length > 0) {
      const difficultiesArray = Array.isArray(difficulties)
        ? difficulties
        : difficulties.split(",");
      matchStage.difficulty = { $in: difficultiesArray };
    }

    // Multiple languages
    if (languages.length > 0) {
      const languagesArray = Array.isArray(languages)
        ? languages
        : languages.split(",");
      matchStage.language = { $in: languagesArray };
    }

    // Multiple types
    if (types.length > 0) {
      const typesArray = Array.isArray(types) ? types : types.split(",");
      matchStage.type = { $in: typesArray };
    }

    // Price range
    if (minPrice || maxPrice) {
      matchStage["pricing.finalPrice"] = {};
      if (minPrice)
        matchStage["pricing.finalPrice"].$gte = parseFloat(minPrice);
      if (maxPrice)
        matchStage["pricing.finalPrice"].$lte = parseFloat(maxPrice);
    }

    // internshipsCollection includes filters
    if (hasVideoContent === "true") {
      matchStage["courseIncludes.videoDuration"] = { $exists: true, $ne: "" };
    }

    if (hasCertificate === "true") {
      matchStage["courseIncludes.certificateOfCompletion"] = true;
    }

    if (hasJobAssistance === "true") {
      matchStage["courseIncludes.jobAssistance"] = true;
    }

    // Tool names filter
    if (toolNames.length > 0) {
      const toolNamesArray = Array.isArray(toolNames)
        ? toolNames
        : toolNames.split(",");
      matchStage["toolsWithIcons.name"] = {
        $in: toolNamesArray.map((tool) => new RegExp(tool.trim(), "i")),
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const aggregationPipeline = [
      { $match: matchStage },
      {
        $addFields: {
          // Add calculated fields for sorting
          discountPercentage: {
            $cond: {
              if: { $gt: ["$pricing.originalPrice", 0] },
              then: {
                $multiply: [
                  {
                    $divide: [
                      {
                        $subtract: [
                          "$pricing.originalPrice",
                          "$pricing.finalPrice",
                        ],
                      },
                      "$pricing.originalPrice",
                    ],
                  },
                  100,
                ],
              },
              else: 0,
            },
          },
          enrollmentScore: {
            $add: [
              { $cond: [{ $eq: ["$featured", true] }, 10, 0] },
              { $cond: [{ $eq: ["$trending", true] }, 5, 0] },
            ],
          },
        },
      },
      {
        $facet: {
          metadata: [{ $count: "totalCount" }],
          data: [
            { $sort: { enrollmentScore: -1, createdAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) },
            {
              $project: {
                __v: 0,
              },
            },
          ],
        },
      },
    ];

    const results = await internshipsCollection.aggregate(aggregationPipeline);

    const totalCount = results[0].metadata[0]?.totalCount || 0;
    const courses = results[0].data || [];
    const totalPages = Math.ceil(totalCount / parseInt(limit));

    res.status(200).json({
      success: true,
      data: courses,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalResults: totalCount,
        resultsPerPage: parseInt(limit),
        hasNextPage: parseInt(page) < totalPages,
        hasPrevPage: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error("Advanced search error:", error);
    res.status(500).json({
      success: false,
      message: "Error in advanced search",
      error: error.message,
    });
  }
});

// Search suggestions/autocomplete
app.get("/search/suggestions", async (req, res) => {
  try {
    const { query = "", limit = 10 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(200).json({
        success: true,
        suggestions: [],
      });
    }

    const searchRegex = new RegExp(`^${query.trim()}`, "i"); // Starts with query

    const suggestions = await internshipsCollection.aggregate([
      {
        $match: {
          status: "active",
          $or: [
            { title: searchRegex },
            { category: searchRegex },
            { tags: searchRegex },
          ],
        },
      },
      {
        $project: {
          title: 1,
          category: 1,
          type: 1,
          "media.thumbnailImage": 1,
        },
      },
      { $limit: parseInt(limit) },
    ]);

    res.status(200).json({
      success: true,
      suggestions,
    });
  } catch (error) {
    console.error("Suggestions error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching suggestions",
      error: error.message,
    });
  }
});

// Get filter options (for filter dropdowns)
app.get("/search/filters", async (req, res) => {
  try {
    const filterOptions = await internshipsCollection.aggregate([
      { $match: { status: "active" } },
      {
        $group: {
          _id: null,
          categories: { $addToSet: "$category" },
          difficulties: { $addToSet: "$difficulty" },
          languages: { $addToSet: "$language" },
          types: { $addToSet: "$type" },
          allTags: { $push: "$tags" },
          allSkills: { $push: "$skills" },
          allTools: { $push: "$toolsWithIcons.name" },
        },
      },
      {
        $project: {
          _id: 0,
          categories: 1,
          difficulties: 1,
          languages: 1,
          types: 1,
          tags: {
            $reduce: {
              input: "$allTags",
              initialValue: [],
              in: { $setUnion: ["$$value", "$$this"] },
            },
          },
          skills: {
            $reduce: {
              input: "$allSkills",
              initialValue: [],
              in: { $setUnion: ["$$value", "$$this"] },
            },
          },
          tools: {
            $reduce: {
              input: "$allTools",
              initialValue: [],
              in: { $setUnion: ["$$value", "$$this"] },
            },
          },
        },
      },
    ]);

    res.status(200).json({
      success: true,
      filters: filterOptions[0] || {
        categories: [],
        difficulties: [],
        languages: [],
        types: [],
        tags: [],
        skills: [],
        tools: [],
      },
    });
  } catch (error) {
    console.error("Filters error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching filter options",
      error: error.message,
    });
  }
});

app.get("/getOneInternship/:id/:orgId", async (req, res) => {
  const { orgId } = req.params;

  const tenantDB = await getTenantDB(orgId);
  const { internships, sections, topics, zoomMeetings, lastAccessed, progress } = connectTodb(tenantDB);
  if (!tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;
    const { userId } = req.query;

    const internshipId = new mongoDB.ObjectId(id);

    const internship = await internships.findOne({ _id: internshipId });
    if (!internship) {
      return res.status(404).json({ err: "Internship not found" });
    }

    const sectionObjectIds = (internship.sections || []).map((secId) =>
      typeof secId === "string" ? new mongoDB.ObjectId(secId) : secId
    );
    const sectionDocs = await sections
      .find({ _id: { $in: sectionObjectIds } })
      .toArray();
    const enrichedSections = await Promise.all(
      sectionDocs.map(async (sectionDoc) => {
        const sectionIdStr = sectionDoc._id.toHexString();
        const sectionTopics = await topics
          .find({ sectionId: sectionIdStr })
          .toArray();

        const topicIdsStr = sectionTopics.map((t) => t._id.toString());

        const allMeetings = await zoomMeetings.find({ topicId: { $in: topicIdsStr } }).toArray();
        const meetingsMap = allMeetings.reduce((acc, m) => {
          acc[m.topicId] = m;
          return acc;
        }, {});

        let progressMap = {};
        if (userId && topicIdsStr.length > 0) {
          const allProgress = await progress.find({
            userId: userId,
            topicId: { $in: topicIdsStr }
          }).toArray();
          progressMap = allProgress.reduce((acc, p) => {
            acc[p.topicId] = p;
            return acc;
          }, {});
        }

        const enrichedTopics = sectionTopics.map((topic) => {
          const topicIdStr = topic._id.toString();
          const meeting = meetingsMap[topicIdStr] || null;
          const progressData = progressMap[topicIdStr] || null;

          const { meetingDetails, ...rest } = meeting || {};
          const topicResult = {
            ...topic,
            meetings: rest,
          };
          if (progressData && progressData.progress !== undefined) {
            topicResult.progress = progressData.progress;
          }
          if (progressData && progressData.totalDuration !== undefined) {
            topicResult.totalDuration = progressData.totalDuration;
          }
          return topicResult;
        });

        return {
          ...sectionDoc,
          topics: enrichedTopics,
        };
      })
    );

    internship.sections = enrichedSections;

    // Fetch last accessed information if userId is provided
    let lastAccessedData = null;
    if (userId) {
      // console.log("Fetching lastAccessed for userId:", userId, "itemId:", id);
      // console.log("LastAccessed collection exists:", !!lastAccessed);

      // Debug: Check all records for this user
      // const allUserRecords = await lastAccessed.find({ userId: userId }).toArray();
      // console.log("All lastAccessed records for user:", allUserRecords);

      // Try to find with exact match first
      lastAccessedData = await lastAccessed.findOne({
        userId: userId,
        itemId: id,
      });

      // console.log("LastAccessed query result:", lastAccessedData);
    }

    res.status(200).json({
      data: internship,
      lastAccessed: lastAccessedData
    });
  } catch (error) {
    console.error("getOneInternship error:", error);
    res.status(500).json({ err: error.message });
  }
});


app.get("/getInternshipSections/:id", async (req, res) => {
  const tenantDB = await getTenantDB('KSquare');
  const { internships, sections } = connectTodb(tenantDB);
  if (!tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });

    if (!findInternship)
      throw new Error("Internship not found to fetch sections");

    const sectionData = await sections
      .find({ internshipId: id })
      .sort({ _id: 1 })
      .toArray();

    res.status(200).json({ data: sectionData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});
app.use(authenticate);
app.use(selectTenantDB);

// Authenticated version of getOneInternship - uses user's tenant DB
app.get("/getOneInternshipAuth/:id", async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    const { id } = req.params;
    // Allow userId from query params to override, otherwise use authenticated user
    const userId = req.query.userId || req.userID;

    // console.log("GET /getOneInternshipAuth - id:", id, "userId:", userId, "orgId:", req.orgId);
    // console.log("req.userID (from auth):", req.userID, "req.query.userId:", req.query.userId);


    // Fetch internship from KSquare database (central storage)
    const kSquareDB = await getTenantDB('KSquare');
    const { internships, sections, topics, zoomMeetings } = connectTodb(kSquareDB);

    // Fetch lastAccessed and progress from user's tenant database
    const { lastAccessed, progress } = connectTodb(req.tenantDB);

    const internshipId = new mongoDB.ObjectId(id);

    const internship = await internships.findOne({ _id: internshipId });
    if (!internship) {
      return res.status(404).json({ error: "Internship not found" });
    }

    const sectionObjectIds = (internship.sections || []).map((secId) =>
      typeof secId === "string" ? new mongoDB.ObjectId(secId) : secId
    );
    const sectionDocs = await sections
      .find({ _id: { $in: sectionObjectIds } })
      .toArray();

    // ── N+1 QUERY FIX: Fetch all related data in 3 big queries ──
    const allSectionIdStrs = sectionDocs.map((s) => s._id.toHexString());

    // 1. Fetch ALL topics across ALL sections at once
    const allTopicsArray = await topics
      .find({ sectionId: { $in: allSectionIdStrs } })
      .toArray();
    const allTopicIdStrs = allTopicsArray.map((t) => t._id.toString());

    // 2. Fetch ALL meetings across ALL topics at once
    const allMeetings = await zoomMeetings
      .find({ topicId: { $in: allTopicIdStrs } })
      .toArray();
    const meetingsMap = allMeetings.reduce((acc, m) => {
      acc[m.topicId] = m;
      return acc;
    }, {});

    // 3. Fetch ALL progress records for this user across ALL topics at once
    let progressMap = {};
    if (userId && allTopicIdStrs.length > 0) {
      const allProgress = await progress
        .find({
          userId: userId,
          topicId: { $in: allTopicIdStrs },
        })
        .toArray();
      progressMap = allProgress.reduce((acc, p) => {
        acc[p.topicId] = p;
        return acc;
      }, {});
    }

    // Now simply assemble the JSON exactly as it was using Javascript memory mapping
    const enrichedSections = sectionDocs.map((sectionDoc) => {
      const sectionIdStr = sectionDoc._id.toHexString();
      const sectionTopics = allTopicsArray.filter(
        (t) => t.sectionId === sectionIdStr
      );

      const enrichedTopics = sectionTopics.map((topic) => {
        const topicIdStr = topic._id.toString();
        const meeting = meetingsMap[topicIdStr] || null;
        const progressData = progressMap[topicIdStr] || null;

        const { meetingDetails, ...rest } = meeting || {};
        const topicResult = {
          ...topic,
          meetings: rest,
        };
        if (progressData && progressData.progress !== undefined) {
          topicResult.progress = progressData.progress;
        }
        if (progressData && progressData.totalDuration !== undefined) {
          topicResult.totalDuration = progressData.totalDuration;
        }
        if (progressData && typeof progressData.isCompleted === "boolean") {
          topicResult.isCompleted = progressData.isCompleted;
        }
        return topicResult;
      });

      return {
        ...sectionDoc,
        topics: enrichedTopics,
      };
    });

    internship.sections = enrichedSections;

    // ── Server-side progress computation ──────────────────────────────────
    // Walk every topic, decide if it is completed based on the progress
    // record that was already merged in (progress / totalDuration >= 90%).
    const completedTopicIds = [];
    let serverCompletedCount = 0;
    let serverTotalCount = 0;

    for (const section of enrichedSections) {
      for (const topic of (section.topics || [])) {
        if (!topic._id) continue;
        serverTotalCount++;

        const progress = Number(topic.progress || 0);
        const totalDuration = Number(topic.totalDuration || 0);

        // isCompleted can be stored explicitly in the progress record,
        // or inferred: watched ≥ 90% of a timed topic, or progress ≥ 90
        // when totalDuration is unknown (treated as a percentage).
        const isCompleted =
          Boolean(topic.isCompleted) ||
          (totalDuration > 0 && progress > 0 && progress / totalDuration >= 0.9) ||
          (totalDuration === 0 && progress >= 90);

        if (isCompleted) {
          serverCompletedCount++;
          completedTopicIds.push(topic._id.toString());
          topic.isCompleted = true; // annotate so frontend can trust it
        }
      }
    }

    const serverTotalProgress =
      serverTotalCount > 0
        ? Math.round((serverCompletedCount / serverTotalCount) * 100)
        : 0;
    // ─────────────────────────────────────────────────────────────────────

    // Fetch last accessed information for the authenticated user
    let lastAccessedData = null;
    if (userId) {
      // console.log("Fetching lastAccessed for userId:", userId, "itemId:", id);

      lastAccessedData = await lastAccessed.findOne({
        userId: userId,
        itemId: id,
      });

      // console.log("LastAccessed query result:", lastAccessedData);
    }

    res.status(200).json({
      data: internship,
      lastAccessed: lastAccessedData,
      // Progress summary (computed server-side so client shows correct
      // values immediately without any re-calculation on the frontend).
      completedTopicIds,
      completedCount: serverCompletedCount,
      totalCount: serverTotalCount,
      totalProgress: serverTotalProgress,
    });
  } catch (error) {
    console.error("getOneInternshipAuth error:", error);
    res.status(500).json({ error: "Failed to fetch internship details", details: error.message });
  }
});



app.post("/assignCourseToOrgs", async (req, res) => {
  const { orgId, userID } = req;

  if (orgId !== "skill_688b1cce42c5e979f72d97d4" && orgId !== "KSquare") {
    return res.status(403).json({ err: "User not authorized to access orgs" });
  }

  const mainTenantDB = await getTenantDB(orgId);
  const { internships: courses } = connectTodb(mainTenantDB);

  try {
    const { orgIds, departmentIds, studentIds, courseId, yearOfPassing, isAllDepartments = false, isAllStudents = false } =
      req.body;

    // Validation
    if (!orgIds?.length) {
      return res.status(400).json({ err: "Organization IDs are required" });
    }

    if (!courseId) {
      return res
        .status(400)
        .json({ err: "internshipsCollection ID is required" });
    }

    // STEP 1: Get all orgs that currently have this course assigned
    const currentCourse = await courses.findOne(
      { _id: new mongoDB.ObjectId(courseId) },
      { projection: { assignedOrgs: 1 } }
    );

    const currentlyAssignedOrgs = currentCourse?.assignedOrgs || [];
    const newAssignedOrgs = orgIds || [];

    // STEP 2: Find orgs to remove (previously assigned but not in new list)
    const orgsToRemove = currentlyAssignedOrgs.filter(
      (org) => !newAssignedOrgs.includes(org)
    );

    // STEP 3: Remove assignments from orgs that are no longer assigned
    const removePromises = orgsToRemove.map(async (orgToRemove) => {
      try {
        const tenantDB = await getTenantDB(orgToRemove);
        const { assignedCourses } = connectTodb(tenantDB);

        const deleteResult = await assignedCourses.deleteMany({
          type: "course",
          refID: courseId,
          orgId: orgId, // Remove where the main org matches
        });

        return {
          orgId: orgToRemove,
          action: "removed",
          deletedCount: deleteResult.deletedCount,
          success: true,
        };
      } catch (error) {
        console.error(
          `Error removing assignment from org ${orgToRemove}:`,
          error
        );
        return {
          orgId: orgToRemove,
          action: "remove_failed",
          error: error.message,
          success: false,
        };
      }
    });

    // Helper functions (same as before)
    const getDepartmentsForOrg = async (targetOrgId) => {
      if (!departmentIds?.length) return [];

      try {
        const tenantDB = await getTenantDB(targetOrgId);
        const { departments } = connectTodb(tenantDB);

        const orgDepartments = await departments
          .find({
            _id: { $in: departmentIds.map((id) => new mongoDB.ObjectId(id)) },
          })
          .toArray();

        return orgDepartments.map((dept) => dept._id.toString());
      } catch (error) {
        console.error(
          `Error fetching departments for org ${targetOrgId}:`,
          error
        );
        return [];
      }
    };

    const getStudentsForOrg = async (targetOrgId, orgDepartmentIds) => {
      if (!studentIds?.length) return [];

      try {
        const tenantDB = await getTenantDB(targetOrgId);
        const { student } = connectTodb(tenantDB);

        const query = {
          _id: { $in: studentIds.map((id) => new mongoDB.ObjectId(id)) },
        };

        if (orgDepartmentIds.length > 0) {
          query["department"] = { $in: orgDepartmentIds };
        }

        const orgStudents = await student.find(query).toArray();
        return orgStudents.map((student) => student._id.toString());
      } catch (error) {
        console.error(`Error fetching students for org ${targetOrgId}:`, error);
        return [];
      }
    };

    // STEP 4: Update/Insert assignments for new orgs
    const upsertPromises = newAssignedOrgs.map(async (currentOrgId) => {
      try {
        const orgDepartmentIds = await getDepartmentsForOrg(currentOrgId);
        const orgStudentIds = await getStudentsForOrg(
          currentOrgId,
          orgDepartmentIds
        );

        const tenantDB = await getTenantDB(currentOrgId);
        const { assignedCourses } = connectTodb(tenantDB);

        // Check if assignment already exists
        const existingAssignment = await assignedCourses.findOne({
          type: "course",
          refID: courseId,
          orgId: orgId,
        });

        let result;
        let action;

        if (existingAssignment) {
          // UPDATE existing assignment
          result = await assignedCourses.updateOne(
            { _id: existingAssignment._id },
            {
              $set: {
                addedBy: userID,
                studentIds: orgStudentIds,
                departmentIds: orgDepartmentIds,
                yearOfPassing,
                isAllDepartments: !!isAllDepartments,
                isAllStudents: !!isAllStudents,
                updatedAt: new Date(),
              },
            }
          );
          action = "updated";
        } else {
          // INSERT new assignment
          result = await assignedCourses.insertOne({
            addedBy: userID,
            type: "course",
            refID: courseId,
            orgId: orgId,
            studentIds: orgStudentIds,
            departmentIds: orgDepartmentIds,
            yearOfPassing,
            isAllDepartments: !!isAllDepartments,
            isAllStudents: !!isAllStudents,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          action = "created";
        }

        return {
          orgId: currentOrgId,
          action,
          success: true,
          insertedId: result.insertedId || result.upsertedId,
          departmentCount: orgDepartmentIds.length,
          studentCount: orgStudentIds.length,
        };
      } catch (error) {
        console.error(`Error processing org ${currentOrgId}:`, error);
        return {
          orgId: currentOrgId,
          action: "failed",
          success: false,
          error: error.message,
          departmentCount: 0,
          studentCount: 0,
        };
      }
    });

    // Execute all operations in parallel
    const [removeResults, upsertResults] = await Promise.all([
      Promise.all(removePromises),
      Promise.all(upsertPromises),
    ]);

    // Combine all results
    const allResults = [...removeResults, ...upsertResults];

    // Calculate totals
    const totalDepartments = upsertResults.reduce(
      (sum, result) => sum + (result.departmentCount || 0),
      0
    );
    const totalStudents = upsertResults.reduce(
      (sum, result) => sum + (result.studentCount || 0),
      0
    );
    const successfulOperations = allResults.filter(
      (result) => result.success
    ).length;
    const errors = allResults.filter((result) => !result.success);

    // STEP 5: Update the main course with new assignedOrgs
    await courses.updateOne(
      { _id: new mongoDB.ObjectId(courseId) },
      {
        $set: {
          assignedOrgs: newAssignedOrgs,
          lastAssignmentUpdate: new Date(),
        },
      }
    );

    res.status(200).json({
      msg: "internshipsCollection assignment updated successfully",
      courseId,
      summary: {
        totalOrgs: newAssignedOrgs.length,
        successfulOperations,
        failedOperations: errors.length,
        totalDepartments,
        totalStudents,
        removedFromOrgs: orgsToRemove.length,
        updatedOrgs: upsertResults.filter((r) => r.action === "updated").length,
        newlyAssignedOrgs: upsertResults.filter((r) => r.action === "created")
          .length,
      },
      details: allResults,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Assignment error:", error);
    res.status(500).json({ err: error.message });
  }
});

app.post(
  "/getAssignedCourseData",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { orgId } = req;
    try {
      const { courseId } = req.body;

      const mainTenantDB = await getTenantDB(orgId);
      const { internships: courses } = connectTodb(mainTenantDB);

      const course = await courses.findOne(
        { _id: new mongoDb.ObjectId(courseId) },
        { projection: { assignedOrgs: 1 } }
      );

      if (!course?.assignedOrgs?.length) {
        return res.status(200).json({
          data: { orgIds: [], departmentIds: [], studentIds: [] },
        });
      }

      // Get detailed assignment data from the first assigned org
      const firstOrgId = course.assignedOrgs[0];
      const tenantDB = await getTenantDB(firstOrgId);
      const { assignedCourses } = connectTodb(tenantDB);

      const assignments = await assignedCourses
        .find({
          type: "course",
          refID: courseId,
        })
        .toArray();

      // Aggregate the data
      const allDepartmentIds = assignments.flatMap(
        (a) => a.departmentIds || []
      );
      const allStudentIds = assignments.flatMap((a) => a.studentIds || []);
      const isAllDepartments = assignments.some((a) => a.isAllDepartments === true);
      const isAllStudents = assignments.some((a) => a.isAllStudents === true);

      res.status(200).json({
        data: {
          orgIds: course.assignedOrgs,
          departmentIds: [...new Set(allDepartmentIds)],
          studentIds: [...new Set(allStudentIds)],
          isAllDepartments,
          isAllStudents,
        },
      });
    } catch (error) {
      res.status(500).json({ err: error.message });
    }
  }
);

app.post("/assignInternshipToOrgs", async (req, res) => {
  const { orgId, userID } = req;

  if (orgId !== "skill_688b1cce42c5e979f72d97d4" && orgId !== "KSquare") {
    return res.status(403).json({ err: "User not authorized to access orgs" });
  }

  const mainTenantDB = await getTenantDB(orgId);
  const { internships } = connectTodb(mainTenantDB);

  try {
    const { orgIds, departmentIds, studentIds, internshipId, yearOfPassing, isAllDepartments = false, isAllStudents = false } =
      req.body;

    // Validation
    if (!orgIds?.length) {
      return res.status(400).json({ err: "Organization IDs are required" });
    }

    if (!internshipId) {
      return res.status(400).json({ err: "Internship ID is required" });
    }

    // STEP 1: Get all orgs that currently have this internship assigned
    const currentInternship = await internships.findOne(
      { _id: new mongoDB.ObjectId(internshipId) },
      { projection: { assignedOrgs: 1 } }
    );

    const currentlyAssignedOrgs = currentInternship?.assignedOrgs || [];
    const newAssignedOrgs = orgIds || [];

    // STEP 2: Find orgs to remove (previously assigned but not in new list)
    const orgsToRemove = currentlyAssignedOrgs.filter(
      (org) => !newAssignedOrgs.includes(org)
    );

    // STEP 3: Remove assignments from orgs that are no longer assigned
    const removePromises = orgsToRemove.map(async (orgToRemove) => {
      try {
        const tenantDB = await getTenantDB(orgToRemove);
        const { assignedInternships } = connectTodb(tenantDB);

        const deleteResult = await assignedInternships.deleteMany({
          type: "internship",
          refID: internshipId,
          orgId: orgId, // Remove where the main org matches
        });

        return {
          orgId: orgToRemove,
          action: "removed",
          deletedCount: deleteResult.deletedCount,
          success: true,
        };
      } catch (error) {
        console.error(
          `Error removing assignment from org ${orgToRemove}:`,
          error
        );
        return {
          orgId: orgToRemove,
          action: "remove_failed",
          error: error.message,
          success: false,
        };
      }
    });

    // Helper functions
    const getDepartmentsForOrg = async (targetOrgId) => {
      if (!departmentIds?.length) return [];

      try {
        const tenantDB = await getTenantDB(targetOrgId);
        const { departments } = connectTodb(tenantDB);

        const orgDepartments = await departments
          .find({
            _id: { $in: departmentIds.map((id) => new mongoDB.ObjectId(id)) },
          })
          .toArray();

        return orgDepartments.map((dept) => dept._id.toString());
      } catch (error) {
        console.error(
          `Error fetching departments for org ${targetOrgId}:`,
          error
        );
        return [];
      }
    };

    const getStudentsForOrg = async (targetOrgId, orgDepartmentIds) => {
      if (!studentIds?.length) return [];

      try {
        const tenantDB = await getTenantDB(targetOrgId);
        const { student } = connectTodb(tenantDB);

        const query = {
          _id: { $in: studentIds.map((id) => new mongoDB.ObjectId(id)) },
        };

        if (orgDepartmentIds.length > 0) {
          query["department"] = { $in: orgDepartmentIds };
        }

        const orgStudents = await student.find(query).toArray();
        return orgStudents.map((student) => student._id.toString());
      } catch (error) {
        console.error(`Error fetching students for org ${targetOrgId}:`, error);
        return [];
      }
    };

    // STEP 4: Update/Insert assignments for new orgs
    const upsertPromises = newAssignedOrgs.map(async (currentOrgId) => {
      try {
        const orgDepartmentIds = await getDepartmentsForOrg(currentOrgId);
        const orgStudentIds = await getStudentsForOrg(
          currentOrgId,
          orgDepartmentIds
        );

        const tenantDB = await getTenantDB(currentOrgId);
        const { assignedInternships } = connectTodb(tenantDB);

        // Check if assignment already exists
        const existingAssignment = await assignedInternships.findOne({
          type: "internship",
          refID: internshipId,
          orgId: orgId,
        });

        let result;
        let action;

        if (existingAssignment) {
          // UPDATE existing assignment
          result = await assignedInternships.updateOne(
            { _id: existingAssignment._id },
            {
              $set: {
                addedBy: userID,
                studentIds: orgStudentIds,
                departmentIds: orgDepartmentIds,
                yearOfPassing,
                isAllDepartments: !!isAllDepartments,
                isAllStudents: !!isAllStudents,
                updatedAt: new Date(),
              },
            }
          );
          action = "updated";
        } else {
          // INSERT new assignment
          result = await assignedInternships.insertOne({
            addedBy: userID,
            type: "internship",
            refID: internshipId,
            orgId: orgId,
            studentIds: orgStudentIds,
            departmentIds: orgDepartmentIds,
            yearOfPassing,
            isAllDepartments: !!isAllDepartments,
            isAllStudents: !!isAllStudents,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          action = "created";
        }

        return {
          orgId: currentOrgId,
          action,
          success: true,
          insertedId: result.insertedId || result.upsertedId,
          departmentCount: orgDepartmentIds.length,
          studentCount: orgStudentIds.length,
        };
      } catch (error) {
        console.error(`Error processing org ${currentOrgId}:`, error);
        return {
          orgId: currentOrgId,
          action: "failed",
          success: false,
          error: error.message,
          departmentCount: 0,
          studentCount: 0,
        };
      }
    });

    // Execute all operations in parallel
    const [removeResults, upsertResults] = await Promise.all([
      Promise.all(removePromises),
      Promise.all(upsertPromises),
    ]);

    // Combine all results
    const allResults = [...removeResults, ...upsertResults];

    // Calculate totals
    const totalDepartments = upsertResults.reduce(
      (sum, result) => sum + (result.departmentCount || 0),
      0
    );
    const totalStudents = upsertResults.reduce(
      (sum, result) => sum + (result.studentCount || 0),
      0
    );
    const successfulOperations = allResults.filter(
      (result) => result.success
    ).length;
    const errors = allResults.filter((result) => !result.success);

    // STEP 5: Update the main internship with new assignedOrgs
    await internships.updateOne(
      { _id: new mongoDB.ObjectId(internshipId) },
      {
        $set: {
          assignedOrgs: newAssignedOrgs,
          lastAssignmentUpdate: new Date(),
        },
      }
    );

    res.status(200).json({
      msg: "Internship assignment updated successfully",
      internshipId,
      summary: {
        totalOrgs: newAssignedOrgs.length,
        successfulOperations,
        failedOperations: errors.length,
        totalDepartments,
        totalStudents,
        removedFromOrgs: orgsToRemove.length,
        updatedOrgs: upsertResults.filter((r) => r.action === "updated").length,
        newlyAssignedOrgs: upsertResults.filter((r) => r.action === "created")
          .length,
      },
      details: allResults,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Assignment error:", error);
    res.status(500).json({ err: error.message });
  }
});

app.post("/getAssignedInternshipData", async (req, res) => {
  const { orgId } = req;
  try {
    const { internshipId: courseId } = req.body;

    const mainTenantDB = await getTenantDB(orgId);
    const { internships: courses } = connectTodb(mainTenantDB);

    const course = await courses.findOne(
      { _id: new mongoDb.ObjectId(courseId) },
      { projection: { assignedOrgs: 1 } }
    );

    if (!course?.assignedOrgs?.length) {
      return res.status(200).json({
        data: { orgIds: [], departmentIds: [], studentIds: [] },
      });
    }

    const firstOrgId = course.assignedOrgs[0];
    const tenantDB = await getTenantDB(firstOrgId);
    const { assignedInternships } = connectTodb(tenantDB);

    const assignments = await assignedInternships
      .find({
        type: "internship",
        refID: courseId,
      })
      .toArray();

    // Aggregate the data
    const allDepartmentIds = assignments.flatMap((a) => a.departmentIds || []);
    const allStudentIds = assignments.flatMap((a) => a.studentIds || []);
    const isAllDepartments = assignments.some((a) => a.isAllDepartments === true);
    const isAllStudents = assignments.some((a) => a.isAllStudents === true);

    res.status(200).json({
      data: {
        orgIds: course.assignedOrgs,
        departmentIds: [...new Set(allDepartmentIds)],
        studentIds: [...new Set(allStudentIds)],
        isAllDepartments,
        isAllStudents,
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post(
  "/getAllCoursesCombo",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    if (!req.tenantDB) {
      return res.status(500).json({ error: "No tenant DB available" });
    }

    try {
      const { userID: studentId, orgId: currentOrgId } = req;
      const { pageNo = 1, searchTerm = "", category = "", difficulty = "" } = req.body;
      const limit = 20; // Fixed limit per page

      const { assignedCourses, student: students } = connectTodb(req.tenantDB);

      const [studentData, assignedCoursesData] = await Promise.all([
        students.findOne(
          {
            globalId: studentId,
          },
          { projection: { department: 1, _id: 1 } }
        ),

        assignedCourses
          .find(
            {
              type: "course",
            },
            {
              projection: {
                refID: 1,
                orgId: 1,
                departmentIds: 1,
                studentIds: 1,
                isAllDepartments: 1,
                isAllStudents: 1,
              },
            }
          )
          .toArray(),
      ]);

      if (!studentData) {
        return res.status(404).json({ error: "Student not found" });
      }

      if (!assignedCoursesData.length) {
        return res.status(200).json({
          data: [],
          pagination: {
            hasNext: false,
            nextCursor: null,
            totalLength: 0,
            currentPage: parseInt(pageNo),
            totalPages: 0,
            limit: limit,
            currentCount: 0,
          },
        });
      }

      const studentDepartmentId =
        studentData.department?.departmentId || studentData.department;

      const eligibleCourseIds = [];

      for (const course of assignedCoursesData) {
        const { departmentIds = [], studentIds = [], refID, isAllDepartments, isAllStudents } = course;

        // If flagged as whole-college, every student in the org is eligible
        if (isAllDepartments && isAllStudents) {
          eligibleCourseIds.push(refID);
          continue;
        }

        if (isAllDepartments) {
          // All departments are assigned – any student qualifies
          if (isAllStudents || studentIds.length === 0 || studentIds.includes(studentData?._id?.toString())) {
            eligibleCourseIds.push(refID);
          }
          continue;
        }

        if (departmentIds.length === 0 && studentIds.length === 0) {
          eligibleCourseIds.push(refID);
          continue;
        }

        if (studentIds.length > 0) {
          if (studentIds.includes(studentData?._id?.toString())) {
            if (
              departmentIds.length === 0 ||
              departmentIds.includes(studentDepartmentId)
            ) {
              eligibleCourseIds.push(refID);
            }
          }
          continue;
        }

        if (departmentIds.includes(studentDepartmentId)) {
          eligibleCourseIds.push(refID);
        }
      }

      if (!eligibleCourseIds.length) {
        return res.status(200).json({
          data: [],
          message: "No courses assigned to this student",
          pagination: {
            hasNext: false,
            nextCursor: null,
            totalLength: 0,
            currentPage: parseInt(pageNo),
            totalPages: 0,
            limit: limit,
            currentCount: 0,
          },
        });
      }

      // Convert to ObjectIds once
      const objectIds = eligibleCourseIds.map((id) => new mongoDb.ObjectId(id));
      const globalStuData = await mainDBusers.findOne({
        _id: new mongoDb.ObjectId(studentId),
      });
      const { enrolledData } = globalStuData;
      console.log(enrolledData);

      if (enrolledData && enrolledData?.length) {
        enrolledData
          ?.filter((e) => e.type == "course")
          .forEach((e) => {
            objectIds.push(new mongoDb.ObjectId(e.refId));
          });
      }

      // Get unique main org IDs (excluding current org)
      const uniqueMainOrgIds = [
        ...new Set(
          assignedCoursesData
            .filter((course) => eligibleCourseIds.includes(course.refID))
            .map((course) => course.orgId)
            .filter((orgId) => orgId !== currentOrgId)
        ),
      ];

      if (!uniqueMainOrgIds.length) {
        return res.status(200).json({
          data: [],
          message: "No courses available from main organizations",
          pagination: {
            hasNext: false,
            nextCursor: null,
            totalLength: 0,
            currentPage: parseInt(pageNo),
            totalPages: 0,
            limit: limit,
            currentCount: 0,
          },
        });
      }

      // Parallel execution for all main org database queries
      const coursePromises = uniqueMainOrgIds.map(async (mainOrgId) => {
        try {
          const tenantDB = await getTenantDB(mainOrgId);
          const { internships: courses } = connectTodb(tenantDB);

          const orgCourses = await courses
            .find({
              _id: { $in: objectIds },
            })
            .toArray();

          return orgCourses.map((course) => ({
            ...course,
            sourceOrgId: mainOrgId,
            _id: course._id.toString(),
          }));
        } catch (error) {
          console.error(`Error fetching from main org ${mainOrgId}:`, error);
          return [];
        }
      });

      const allCoursesArrays = await Promise.all(coursePromises);
      const allCourses = allCoursesArrays.flat();

      // Fast deduplication using Map
      const uniqueCoursesMap = new Map();

      for (const course of allCourses) {
        if (!uniqueCoursesMap.has(course._id)) {
          uniqueCoursesMap.set(course._id, course);
        }
      }

      const uniqueCourses = Array.from(uniqueCoursesMap.values());

      // Apply in-memory filters before pagination
      const lowerSearch = searchTerm.trim().toLowerCase();
      const lowerCategory = category.trim().toLowerCase();
      const lowerDifficulty = difficulty.trim().toLowerCase();

      const filteredCourses = uniqueCourses.filter((c) => {
        const matchesSearch =
          !lowerSearch ||
          (c.title || "").toLowerCase().includes(lowerSearch) ||
          (c.description || "").toLowerCase().includes(lowerSearch) ||
          (c.category || "").toLowerCase().includes(lowerSearch);
        const matchesCategory =
          !lowerCategory || (c.category || "").toLowerCase().includes(lowerCategory);
        const matchesDifficulty =
          !lowerDifficulty || (c.difficulty || "").toLowerCase() === lowerDifficulty;
        return matchesSearch && matchesCategory && matchesDifficulty;
      });

      // Apply page-based pagination
      const totalLength = filteredCourses.length;
      const totalPages = Math.ceil(totalLength / limit);
      const currentPage = parseInt(pageNo);
      const startIndex = (currentPage - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedCourses = filteredCourses.slice(startIndex, endIndex);

      const hasNext = currentPage < totalPages;
      const nextCursor = hasNext ? startIndex + limit : null;

      res.status(200).json({
        data: paginatedCourses,
        pagination: {
          hasNext,
          nextCursor,
          totalLength,
          currentPage,
          totalPages,
          limit,
          currentCount: paginatedCourses.length,
        },
        summary: {
          totalCourses: paginatedCourses.length,
          eligibleCourses: eligibleCourseIds.length,
          mainOrgsQueried: uniqueMainOrgIds.length,
          totalAvailableCourses: totalLength,
        },
      });
    } catch (error) {
      console.error("Error in getAllCoursesCombo:", error);
      res.status(500).json({ error: "Failed to fetch courses combo", details: error.message });
    }
  }
);
app.post(
  "/getAllInternshipsCombo",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    if (!req.tenantDB) {
      return res.status(500).json({ error: "No tenant DB available" });
    }

    try {
      const { userID: studentId, orgId: currentOrgId } = req;
      const { pageNo = 1, searchTerm = "", category = "", difficulty = "" } = req.body;
      const limit = 20;

      const { assignedInternships, student: students } = connectTodb(
        req.tenantDB
      );

      const [studentData, assignedInternshipsData] = await Promise.all([
        students.findOne(
          {
            globalId: studentId,
          },
          { projection: { department: 1, _id: 1 } }
        ),

        assignedInternships
          .find(
            {
              type: "internship",
            },
            {
              projection: {
                refID: 1,
                orgId: 1,
                departmentIds: 1,
                studentIds: 1,
                isAllDepartments: 1,
                isAllStudents: 1,
              },
            }
          )
          .toArray(),
      ]);

      if (!studentData) {
        return res.status(404).json({ error: "Student not found" });
      }

      if (!assignedInternshipsData.length) {
        return res.status(200).json({
          data: [],
          pagination: {
            hasNext: false,
            nextCursor: null,
            totalLength: 0,
            currentPage: parseInt(pageNo),
            totalPages: 0,
            limit: limit,
            currentCount: 0,
          },
        });
      }

      const studentDepartmentId =
        studentData.department?.departmentId || studentData.department;

      const eligibleInternshipIds = [];

      for (const internship of assignedInternshipsData) {
        const { departmentIds = [], studentIds = [], refID, isAllDepartments, isAllStudents } = internship;

        // If flagged as whole-college, every student in the org is eligible
        if (isAllDepartments && isAllStudents) {
          eligibleInternshipIds.push(refID);
          continue;
        }

        if (isAllDepartments) {
          // All departments are assigned – any student qualifies
          if (isAllStudents || studentIds.length === 0 || studentIds.includes(studentData?._id?.toString())) {
            eligibleInternshipIds.push(refID);
          }
          continue;
        }

        if (departmentIds.length === 0 && studentIds.length === 0) {
          eligibleInternshipIds.push(refID);
          continue;
        }

        if (studentIds.length > 0) {
          if (studentIds.includes(studentData?._id?.toString())) {
            if (
              departmentIds.length === 0 ||
              departmentIds.includes(studentDepartmentId)
            ) {
              eligibleInternshipIds.push(refID);
            }
          }
          continue;
        }

        if (departmentIds.includes(studentDepartmentId)) {
          eligibleInternshipIds.push(refID);
        }
      }

      if (!eligibleInternshipIds.length) {
        return res.status(200).json({
          data: [],
          message: "No internships assigned to this student",
          pagination: {
            hasNext: false,
            nextCursor: null,
            totalLength: 0,
            currentPage: parseInt(pageNo),
            totalPages: 0,
            limit: limit,
            currentCount: 0,
          },
        });
      }

      // Convert to ObjectIds once
      const objectIds = eligibleInternshipIds.map(
        (id) => new mongoDb.ObjectId(id)
      );
      const globalStuData = await mainDBusers.findOne({
        _id: new mongoDb.ObjectId(studentId),
      });
      const { enrolledData } = globalStuData;
      if (enrolledData && enrolledData?.length) {
        enrolledData
          ?.filter((e) => e.type == "internship")
          .forEach((e) => {
            objectIds.push(new mongoDb.ObjectId(e.refId));
          });
      }
      // Get unique main org IDs (excluding current org)
      const uniqueMainOrgIds = [
        ...new Set(
          assignedInternshipsData
            .filter((internship) =>
              eligibleInternshipIds.includes(internship.refID)
            )
            .map((internship) => internship.orgId)
            .filter((orgId) => orgId !== currentOrgId)
        ),
      ];

      if (!uniqueMainOrgIds.length) {
        return res.status(200).json({
          data: [],
          message: "No internships available from main organizations",
          pagination: {
            hasNext: false,
            nextCursor: null,
            totalLength: 0,
            currentPage: parseInt(pageNo),
            totalPages: 0,
            limit: limit,
            currentCount: 0,
          },
        });
      }

      // Parallel execution for all main org database queries
      const internshipPromises = uniqueMainOrgIds.map(async (mainOrgId) => {
        try {
          const tenantDB = await getTenantDB(mainOrgId);
          const { internships } = connectTodb(tenantDB);

          const orgInternships = await internships
            .find({
              _id: { $in: objectIds },
            })
            .toArray();

          return orgInternships.map((internship) => ({
            ...internship,
            sourceOrgId: mainOrgId,
            _id: internship._id.toString(),
          }));
        } catch (error) {
          console.error(`Error fetching from main org ${mainOrgId}:`, error);
          return [];
        }
      });

      const allInternshipsArrays = await Promise.all(internshipPromises);
      const allInternships = allInternshipsArrays.flat();

      // Fast deduplication using Map
      const uniqueInternshipsMap = new Map();

      for (const internship of allInternships) {
        if (!uniqueInternshipsMap.has(internship._id)) {
          uniqueInternshipsMap.set(internship._id, internship);
        }
      }

      const uniqueInternships = Array.from(uniqueInternshipsMap.values());

      // Apply in-memory filters before pagination
      const lowerSearch = searchTerm.trim().toLowerCase();
      const lowerCategory = category.trim().toLowerCase();
      const lowerDifficulty = difficulty.trim().toLowerCase();

      const filteredInternships = uniqueInternships.filter((item) => {
        const matchesSearch =
          !lowerSearch ||
          (item.title || "").toLowerCase().includes(lowerSearch) ||
          (item.description || "").toLowerCase().includes(lowerSearch) ||
          (item.category || "").toLowerCase().includes(lowerSearch);
        const matchesCategory =
          !lowerCategory || (item.category || "").toLowerCase().includes(lowerCategory);
        const matchesDifficulty =
          !lowerDifficulty || (item.difficulty || "").toLowerCase() === lowerDifficulty;
        return matchesSearch && matchesCategory && matchesDifficulty;
      });

      // Apply page-based pagination
      const totalLength = filteredInternships.length;
      const totalPages = Math.ceil(totalLength / limit);
      const currentPage = parseInt(pageNo);
      const startIndex = (currentPage - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedInternships = filteredInternships.slice(
        startIndex,
        endIndex
      );

      const hasNext = currentPage < totalPages;
      const nextCursor = hasNext ? startIndex + limit : null;

      res.status(200).json({
        data: paginatedInternships,
        pagination: {
          hasNext,
          nextCursor,
          totalLength,
          currentPage,
          totalPages,
          limit,
          currentCount: paginatedInternships.length,
        },
        summary: {
          totalInternships: paginatedInternships.length,
          eligibleInternships: eligibleInternshipIds.length,
          mainOrgsQueried: uniqueMainOrgIds.length,
          totalAvailableInternships: totalLength,
        },
      });
    } catch (error) {
      console.error("Error in getAllInternshipsCombo:", error);
      res.status(500).json({ err: error.message });
    }
  }
);

app.post("/createCourse", async (req, res) => {
  const { internships } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { title, type } = req.body;

    const findIsDuplicate = await internships.findOne({
      $and: [{ title }, { type }],
    });

    if (findIsDuplicate) throw new Error("Course Already created");

    const InternShipData = await internships.insertOne({
      ...req.body,
      createdAt: new Date().getTime(),
    });

    res
      .status(200)
      .json({ msg: "Course created successfully", data: InternShipData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.get("/searchTopics", async (req, res) => {
  const { zoomMeetings } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { query, type, limit = 10, cursor = null } = req.query;
    const parsedLimit = parseInt(limit, 10);

    const pipeline = [];

    const matchStage = { topic: { $regex: query, $options: "i" } };
    if (type && type !== "null") {
      matchStage.type = type;
    }
    if (cursor && cursor !== "null") {
      matchStage._id = { $gt: new mongoDB.ObjectId(cursor) };
    }
    pipeline.push({ $match: matchStage });

    pipeline.push({ $sort: { _id: 1 } });
    pipeline.push({ $limit: parsedLimit + 1 });

    // Execute aggregation
    const courses = await zoomMeetings.aggregate(pipeline).toArray();

    const hasNext = courses.length > parsedLimit;
    if (hasNext) {
      courses.pop();
    }

    const nextCursor = hasNext ? courses[courses.length - 1]._id : null;

    res.status(200).json({
      data: courses,
      hasNext,
      nextCursor,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/createInternship", async (req, res) => {
  const { internships } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { title } = req.body;

    const findIsDuplicate = await internships.findOne({
      $and: [{ title: title }, { type: "internship" }],
    });

    if (findIsDuplicate) throw new Error("Internship Already created");

    const InternShipData = await internships.insertOne({
      ...req.body,
      type: "internship",
      createdAt: new Date().getTime(),
    });

    res
      .status(200)
      .json({ msg: "Internship created successfully", data: InternShipData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/deleteInternship", async (req, res) => {
  const { internships } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { internshipId } = req.body;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(internshipId),
    });

    if (!findInternship)
      throw new Error("Please select valid internship to delete");

    const deletedData = await internships.deleteOne({
      _id: findInternship._id,
    });

    res
      .status(200)
      .json({ msg: "Internship deleted successfully", data: deletedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/updateInternship/:id", async (req, res) => {
  const { internships } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });

    if (!findInternship)
      throw new Error("Please select valid internship to update");

    const updatedData = await internships.updateOne(
      { _id: findInternship._id },
      {
        $set: {
          ...req.body,
          updatedAt: new Date().getTime(),
        },
      }
    );

    res
      .status(200)
      .json({ msg: "Internship updated successfully", ...updatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

// app.get("/getOneInternship/:id", async (req, res) => {
//   try {
//     const { id } = req.params;

//     const findInternship = await internships.findOne({ _id: new mongoDB.ObjectId(id) });

//     if (!findInternship) throw new Error("Internship not found");

//     res.status(200).json({ data: findInternship });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// });

// Assuming you have these collection variables already:
// const internships = db.collection("internships");
// const sections    = db.collection("sections");
// const topics      = db.collection("topics");



app.post("/createSection/:id", async (req, res) => {
  const { internships, sections } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const { title } = req.body;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });

    if (!findInternship)
      throw new Error("Internship not found to create sections");

    const findIsDuplicate = await sections.findOne({
      $and: [{ title: title }, { internshipId: id }],
    });

    if (findIsDuplicate) throw new Error("Section Already created");

    const sectionData = await sections.insertOne({
      internshipId: id,
      ...req.body,
      createdAt: new Date().getTime(),
    });

    await internships.updateOne(
      { _id: new mongoDB.ObjectId(id) },
      { $push: { sections: sectionData.insertedId.toString() } }
    );

    res
      .status(200)
      .json({ msg: "Section created successfully", ...sectionData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.get("/getOneSection/:sid", async (req, res) => {
  const { sections } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { sid } = req.params;

    const sectionData = await sections.findOne({
      _id: new mongoDB.ObjectId(sid),
    });

    if (!sectionData) throw new Error("Section data not available");

    res.status(200).json({ data: sectionData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/updateSection/:id/sections/:sid", async (req, res) => {
  const { internships, sections } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { sid, id } = req.params;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });
    const findSection = await sections.findOne({
      _id: new mongoDB.ObjectId(sid),
    });

    if (!findInternship) throw new Error("Internship not found");

    if (!findSection) throw new Error("Section not found to update");

    const sectionUpdateData = await sections.updateOne(
      { _id: new mongoDB.ObjectId(sid), internshipId: id },
      { $set: { ...req.body, updatedAt: new Date().getTime() } }
    );

    res
      .status(200)
      .json({ msg: "Section updated successfully", ...sectionUpdateData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/deleteSection/:id/sections/:sid", async (req, res) => {
  const { internships, sections } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { sid, id } = req.params;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });
    const findSection = await sections.findOne({
      _id: new mongoDB.ObjectId(sid),
    });

    if (!findInternship) throw new Error("Internship not found");

    if (!findSection) throw new Error("Section not found to update");

    const deletedSectionData = await sections.deleteOne({
      _id: new mongoDB.ObjectId(sid),
      internshipId: id,
    });
    const removedDataFromInternships = await internships.updateOne(
      { _id: new mongoDB.ObjectId(id) },
      { $pull: { sections: sid } }
    );

    res.status(200).json({
      msg: "Section deleted successfully",
      deletedSectionData,
      removedDataFromInternships,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/createTopic/:id/sections/:sid", async (req, res) => {
  const { internships, sections, topics } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id, sid } = req.params;
    const { title } = req.body;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });
    const findSection = await sections.findOne({
      _id: new mongoDB.ObjectId(sid),
    });

    if (!findInternship) throw new Error("Internship not found");

    if (!findSection) throw new Error("Section not found to update");

    const findIsDuplicate = await topics.findOne({
      $and: [{ title: title }, { internshipId: id }, { sectionId: sid }],
    });

    if (findIsDuplicate) throw new Error("Topic Already created");

    const topicInsertedData = await topics.insertOne({
      ...req.body,
      internshipId: id,
      sectionId: sid,
      createdAt: new Date().getTime(),
    });

    await sections.updateOne(
      { _id: new mongoDB.ObjectId(sid) },
      { $push: { topics: topicInsertedData.insertedId.toString() } }
    );

    res
      .status(200)
      .json({ msg: "Topic  created successfully", ...topicInsertedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.get("/getTopicsFromSection/:id/section/:sid", async (req, res) => {
  const { topics } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id, sid } = req.params;

    const getAllTopics = await topics
      .find({ $and: [{ internshipId: id }, { sectionId: sid }] })
      .toArray();

    const modifiedTopics = await Promise.all(
      getAllTopics.map(async (e) => {
        return {
          ...e,
          meetingId: await zoomMeetingsCollection.findOne({ topicId: e._id.toString() }),
        };
      })
    );

    res.status(200).json({ data: modifiedTopics });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});
app.get("/getOneTopic/:tid", async (req, res) => {
  const { topics, progress } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { tid } = req.params;

    let TopicData;

    TopicData = await topics.findOne({
      _id: new mongoDB.ObjectId(tid),
    });

    if (!TopicData) {
      const getDb = await getTenantDB("skill_688b1cce42c5e979f72d97d4");

      const { topics } = connectTodb(getDb);

      const newTopicData = await topics.findOne({
        _id: new mongoDB.ObjectId(tid),
      });

      if (newTopicData) {
        TopicData = newTopicData;
      } else {
        const getDb = await getTenantDB("KSquare");

        const { topics } = connectTodb(getDb);

        const newData = await topics.findOne({
          _id: new mongoDB.ObjectId(tid),
        });

        if (newData) {
          TopicData = newData;
        } else {
          TopicData = null;
        }
      }
    }

    if (!TopicData) throw new Error("Topic data not available");

    const userId = req.query.userId || req.userID;

    const progressData = await progress.findOne({
      userId: userId,
      topicId: tid,
    });

    res.status(200).json({ data: TopicData, progress: progressData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/updateTopic/:id/sections/:sid/topic/:tid", async (req, res) => {
  const { internships, sections, topics } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id, sid, tid } = req.params;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });
    const findSection = await sections.findOne({
      _id: new mongoDB.ObjectId(sid),
    });
    const findTopic = await topics.findOne({
      _id: new mongoDB.ObjectId(tid),
    });

    if (!findInternship) throw new Error("Internship not found");
    if (!findSection) throw new Error("Section not found");
    if (!findTopic) throw new Error("Topic not found to update");

    const topicUpdatedData = await topics.updateOne(
      {
        _id: new mongoDB.ObjectId(tid),
        internshipId: id,
        sectionId: sid,
      },
      { $set: { ...req.body, updatedAt: new Date().getTime() } }
    );

    res
      .status(200)
      .json({ msg: "topic updated successfully", ...topicUpdatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/deleteTopic/:id/section/:sid/topic/:tid", async (req, res) => {
  const { internships, sections, topics } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id, sid, tid } = req.params;

    const findInternship = await internships.findOne({
      _id: new mongoDB.ObjectId(id),
    });
    const findSection = await sections.findOne({
      _id: new mongoDB.ObjectId(sid),
    });
    const findTopic = await topics.findOne({
      _id: new mongoDB.ObjectId(tid),
    });

    if (!findInternship) throw new Error("Internship not found");
    if (!findSection) throw new Error("Section not found");
    if (!findTopic) throw new Error("Topic not found to delete");

    const deletedFromTopic = await topics.deleteOne({
      _id: new mongoDB.ObjectId(tid),
      internshipId: id,
      sectionId: sid,
    });
    const deletedFromSection = await sections.updateOne(
      { _id: new mongoDB.ObjectId(sid) },
      { $pull: { topics: tid } }
    );

    res.status(200).json({
      msg: "topic deleted successfully",
      deletedFromSection,
      deletedFromTopic,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/updateVideoProgress", async (req, res) => {
  const { progress: progressCollection } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { userId, topicId, progress, totalDuration } = req.body;

    if (!userId || !topicId) {
      return res
        .status(400)
        .json({ error: "userId and topicId are required" });
    }

    // Determine completion: ≥90% watched (both values in seconds)
    // or progress ≥ 90 when totalDuration is 0 (treated as percentage).
    const isCompleted =
      totalDuration > 0 && progress > 0
        ? progress / totalDuration >= 0.9
        : progress >= 90;

    const updatedData = await progressCollection.findOneAndUpdate(
      { userId, topicId },
      {
        $set: {
          progress,
          totalDuration,
          isCompleted,
          updatedAt: new Date().getTime(),
        },
        $setOnInsert: { createdAt: new Date().getTime() },
      },
      { upsert: true, returnDocument: "after" }
    );

    res
      .status(200)
      .json({ msg: "Progress updated successfully", data: updatedData, isCompleted });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/updateTotalProgress", async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { userId, itemId, itemType, completedCount, totalCount } = req.body;

    if (!userId || !itemId) {
      return res.status(400).json({ error: "userId and itemId are required" });
    }

    const percentage =
      totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    const { lastAccessed: lastAccessedCollection } = connectTodb(req.tenantDB);

    await lastAccessedCollection.findOneAndUpdate(
      { userId, itemId },
      {
        $set: {
          itemType: itemType || "course",
          totalProgress: percentage,
          completedCount: completedCount || 0,
          totalCount: totalCount || 0,
          progressUpdatedAt: new Date().getTime(),
        },
        $setOnInsert: { createdAt: new Date().getTime() },
      },
      { upsert: true, returnDocument: "after" }
    );

    res.status(200).json({
      msg: "Total progress updated successfully",
      data: { percentage, completedCount, totalCount },
    });
  } catch (error) {
    console.error("updateTotalProgress error:", error);
    res.status(500).json({ err: error.message });
  }
});

app.post("/updateLastAccessed", async (req, res) => {
  const { lastAccessed: lastAccessedCollection } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { userId, itemId, itemType, sectionIndex, topicIndex, orgId } =
      req.body;


    if (!userId || !itemId || !itemType) {
      return res.status(400).json({
        error: "userId, itemId, and itemType are required",
      });
    }

    console.log("Updating lastAccessed - userId:", userId, "itemId:", itemId, "itemType:", itemType);

    const updatedData = await lastAccessedCollection.findOneAndUpdate(
      { userId, itemId },
      {
        $set: {
          itemType,
          sectionIndex: sectionIndex ?? null,
          topicIndex: topicIndex ?? null,
          orgId: orgId ?? req.orgId,
          updatedAt: new Date().getTime(),
        },
        $setOnInsert: { createdAt: new Date().getTime() },
      },
      { upsert: true, returnDocument: "after" }
    );

    console.log("Updated lastAccessed data:", updatedData);


    res.status(200).json({
      msg: "Last accessed updated successfully",
      data: updatedData,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CART & WISHLIST — paste above module.exports = app;
// ─────────────────────────────────────────────────────────────────────────────

// Helper: resolve courseId from tenant DB first, then KSquare fallback
async function resolveCourse(courseId, tenantDB) {
  const { internships: tenantCourses } = connectTodb(tenantDB);
  let course = await tenantCourses.findOne({ _id: new mongoDB.ObjectId(courseId) });
  if (course) return course;

  const kSquareDB = await getTenantDB("KSquare");
  const { internships: kCourses } = connectTodb(kSquareDB);
  return await kCourses.findOne({ _id: new mongoDB.ObjectId(courseId) }) || null;
}

// Helper: compute cart total
function computeCartTotal(items = []) {
  return items.reduce((sum, i) => sum + (i.discountedPrice ?? i.price ?? 0), 0);
}

// Helper: re-fetch & return enriched cart (used after every mutation)
async function sendCartResponse(req, res) {
  const { cart, student} = connectTodb(req.tenantDB);
  const cartDoc = await cart.findOne({ student: req.userID });

  if (!cartDoc?.items?.length) return res.status(200).json({ items: [], totalAmount: 0 });

  const enriched = (
    await Promise.all(
      cartDoc.items.map(async (item) => {
        const course = await resolveCourse(item.courseId, req.tenantDB);
        if (!course) return null;
        return {
          _id: item._id,
          courseId: {
            _id: course._id.toString(),
            title: course.title,
            coverImage: course.media?.thumbnailImage || course.coverImage || null,
            category: course.category,
            difficulty: course.difficulty,
            type: course.type,
          },
          price: item.price,
          discountedPrice: item.discountedPrice,
          addedAt: item.addedAt,
        };
      })
    )
  ).filter(Boolean);

  return res.status(200).json({
    items: enriched,
    totalAmount: computeCartTotal(enriched),
  });
}

// Helper: re-fetch & return enriched wishlist (used after every mutation)
async function sendWishlistResponse(req, res) {
  const { wishlist, student} = connectTodb(req.tenantDB);
  const wishlistDoc = await wishlist.findOne({ student: req.userID });

  if (!wishlistDoc?.items?.length) return res.status(200).json({ items: [] });

  const enriched = (
    await Promise.all(
      wishlistDoc.items.map(async (item) => {
        const course = await resolveCourse(item.courseId, req.tenantDB);
        if (!course) return null;
        return {
          _id: item._id,
          courseId: {
            _id: course._id.toString(),
            title: course.title,
            coverImage: course.media?.thumbnailImage || course.coverImage || null,
            category: course.category,
            difficulty: course.difficulty,
            type: course.type,
            price: course.pricing?.originalPrice ?? course.price ?? 0,
            discountedPrice: course.pricing?.finalPrice ?? course.discountedPrice ?? 0,
          },
          addedAt: item.addedAt,
        };
      })
    )
  ).filter(Boolean);

  return res.status(200).json({ items: enriched });
}

// ── CART ──────────────────────────────────────────────────────────────────────

// GET /cart
app.get("/cart", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });
  try {
    return await sendCartResponse(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /cart  — body: { courseId }
app.post("/cart", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });

  try {
    const { cart,student } = connectTodb(req.tenantDB);
    const { courseId } = req.body;

    if (!courseId) return res.status(400).json({ error: "courseId is required" });

    const course = await resolveCourse(courseId, req.tenantDB);
    if (!course) return res.status(404).json({ error: "Course not found" });

    const cartDoc = await cart.findOne({ student: req.userID });
    if (cartDoc?.items?.some((i) => i.courseId === courseId))
      return res.status(400).json({ error: "Course already in cart" });

    await cart.findOneAndUpdate(
      { student: req.userID },
      {
        $push: {
          items: {
            _id: new mongoDB.ObjectId(),
            courseId,
            price: course.pricing?.originalPrice ?? course.price ?? 0,
            discountedPrice: course.pricing?.finalPrice ?? course.discountedPrice ?? 0,
            addedAt: new Date().getTime(),
          },
        },
        $set: { updatedAt: new Date().getTime() },
        $setOnInsert: { createdAt: new Date().getTime() },
      },
      { upsert: true }
    );

    return await sendCartResponse(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /cart/:courseId  — remove one item
app.delete("/cart/:courseId", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { cart,student } = connectTodb(req.tenantDB);
    await cart.findOneAndUpdate(
      { student: req.userID },
      { $pull: { items: { courseId: req.params.courseId } }, $set: { updatedAt: new Date().getTime() } }
    );
    return await sendCartResponse(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /cart  — clear entire cart
app.delete("/cart", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { cart,student } = connectTodb(req.tenantDB);
    await cart.findOneAndUpdate(
      { student: req.userID },
      { $set: { items: [], updatedAt: new Date().getTime() } },
      { upsert: true }
    );
    res.status(200).json({ items: [], totalAmount: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── WISHLIST ──────────────────────────────────────────────────────────────────

// GET /wishlist
app.get("/wishlist", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });
  try {
    return await sendWishlistResponse(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /wishlist  — body: { courseId }
app.post("/wishlist", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { wishlist,student } = connectTodb(req.tenantDB);
    const { courseId } = req.body;

    if (!courseId) return res.status(400).json({ error: "courseId is required" });

    const course = await resolveCourse(courseId, req.tenantDB);
    if (!course) return res.status(404).json({ error: "Course not found" });

    const wishlistDoc = await wishlist.findOne({ student: req.userID });
    if (wishlistDoc?.items?.some((i) => i.courseId === courseId))
      return res.status(400).json({ error: "Course already in wishlist" });

    await wishlist.findOneAndUpdate(
      { student: req.userID },
      {
        $push: {
          items: {
            _id: new mongoDB.ObjectId(),
            courseId,
            addedAt: new Date().getTime(),
          },
        },
        $set: { updatedAt: new Date().getTime() },
        $setOnInsert: { createdAt: new Date().getTime() },
      },
      { upsert: true }
    );

    return await sendWishlistResponse(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /wishlist/:courseId
app.delete("/wishlist/:courseId", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { wishlist,student } = connectTodb(req.tenantDB);
    await wishlist.findOneAndUpdate(
      { student: req.userID },
      { $pull: { items: { courseId: req.params.courseId } }, $set: { updatedAt: new Date().getTime() } }
    );
    return await sendWishlistResponse(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
module.exports = app;
