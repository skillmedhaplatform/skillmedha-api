/**
 * atsController.js
 * Express controller handling all ATS Checker API endpoints.
 * Orchestrates: file upload → text extraction → AI analysis → blob storage → DB save
 *
 * Place this file in your Node.js/Express API repo under: controllers/atsController.js
 */

const { v4: uuidv4 } = require("uuid");
const ATSAnalysis = require("../models/ATSAnalysis");
const ATSFeedback = require("../models/ATSFeedback");
const Resume = require("../models/Resume");
const atsAIService = require("../services/atsAIService");
const azureBlobService = require("../services/azureBlobService");

// ── Input Validators ──────────────────────────────────────────────────────

const validateStudentId = (studentId) => {
  if (!studentId || typeof studentId !== "string" || studentId.trim().length < 3) {
    return "Invalid or missing student ID.";
  }
  return null;
};

const validateAnalysisId = (analysisId) => {
  if (!analysisId || typeof analysisId !== "string") {
    return "Invalid or missing analysis ID.";
  }
  return null;
};

// ── AI usage guard ───────────────────────────────────────────────────────
// This is a free (unpaid) Cloudflare Workers AI account: a single shared
// 10,000-neuron/day budget for the WHOLE account, used by every AI feature
// in the app (src/shared/utils/ai.js), not just this one — and on the free
// plan, once it's gone for the day requests just start failing (no
// overage billing to fall back on). We have no read access to Cloudflare's
// live usage meter (the configured API token is scoped to run inference
// only, not account analytics), so this guards the shared budget with our
// own accounting instead, tracked in one consistent unit — neurons, the
// real thing being rationed — rather than a flat request count:
//
//   1. A hard global daily neuron cap *for this feature*, summed from the
//      real `neurons` value Cloudflare returns on every call (persisted as
//      ATSAnalysis.neuronsUsed) — reserving the rest of the 10,000/day for
//      every other AI feature sharing the account. This is the backstop
//      that can never be exceeded, no matter how few students are active.
//
//   2. A per-student daily neuron allowance that is NOT a fixed number —
//      it's tiered against how much of that global budget is still
//      unspent. A flat "3 analyses/student/day" wastes capacity on a quiet
//      day (one active student gets turned away at 3 while the shared pool
//      sits 95% unused) and is still too generous on a busy day (30
//      students at 3 each could still exhaust the pool). Scaling the
//      per-student share to remaining headroom fixes both: generous when
//      the account is barely touched, automatically tightening as it
//      fills up so late-day students aren't locked out by early heavy
//      users, and the hard global cap is what ultimately protects the
//      account either way.
//
// Cloudflare's own daily quota resets at 00:00 UTC, so "today" here is
// computed in UTC to stay aligned with it.
const ATS_DAILY_NEURON_BUDGET = parseInt(process.env.ATS_DAILY_NEURON_BUDGET || "4000", 10);

// Tiers checked in order (most headroom first) — the first one whose
// threshold the *remaining* budget fraction still clears wins. Roughly
// 40-50 neurons/analysis on the cheap model, so these translate to about
// 10 / 5 / 2 / 1 analyses per student per day at each tier.
const PER_STUDENT_NEURON_TIERS = [
  { remainingFractionAtLeast: 0.5, allowance: 500 },
  { remainingFractionAtLeast: 0.2, allowance: 250 },
  { remainingFractionAtLeast: 0.05, allowance: 100 },
  { remainingFractionAtLeast: 0, allowance: 50 },
];

const getPerStudentNeuronAllowance = (remainingFraction) => {
  const tier = PER_STUDENT_NEURON_TIERS.find((t) => remainingFraction >= t.remainingFractionAtLeast);
  return tier.allowance;
};

const getStartOfTodayUTC = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const sumNeuronsToday = async (match) => {
  const startOfDayUTC = getStartOfTodayUTC();
  const result = await ATSAnalysis.aggregate([
    { $match: { ...match, createdAt: { $gte: startOfDayUTC } } },
    { $group: { _id: null, total: { $sum: "$neuronsUsed" } } },
  ]);
  return result[0]?.total || 0;
};

/**
 * Checks both usage guards in one pass. Returns null if the request may
 * proceed, or a { message } object describing which cap was hit.
 */
const checkAIUsageGuards = async (studentId) => {
  const [studentNeuronsToday, globalNeuronsToday] = await Promise.all([
    sumNeuronsToday({ studentId }),
    sumNeuronsToday({}),
  ]);

  if (globalNeuronsToday >= ATS_DAILY_NEURON_BUDGET) {
    return {
      message: "Our AI resume analyzer has reached its usage limit for now. Please try again later.",
    };
  }

  const remainingFraction = (ATS_DAILY_NEURON_BUDGET - globalNeuronsToday) / ATS_DAILY_NEURON_BUDGET;
  const studentAllowance = getPerStudentNeuronAllowance(remainingFraction);

  if (studentNeuronsToday >= studentAllowance) {
    return {
      message: "You've reached today's fair-share limit for resume analysis, since a lot of students are using it right now. Please try again later today or tomorrow.",
    };
  }

  return null;
};

// ── POST /ats/analyze ─────────────────────────────────────────────────────
/**
 * Analyze uploaded resume with AI.
 * Steps: validate → extract text → AI analysis → upload blobs → save to DB → respond
 */
const analyzeResume = async (req, res) => {
  const startTime = Date.now();

  try {
    // ── 1. Validate inputs ──────────────────────────────────────────────
    const studentId = (req.body.studentId || req.user?.studentId || "").trim();
    const studentIdError = validateStudentId(studentId);
    if (studentIdError) {
      return res.status(400).json({ success: false, message: studentIdError });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No resume file provided.",
      });
    }

    const usageGuardHit = await checkAIUsageGuards(studentId);
    if (usageGuardHit) {
      return res.status(429).json({ success: false, message: usageGuardHit.message });
    }

    const jobDescription = (req.body.jobDescription || "").slice(0, 5000).trim();

    // ── 2. Run AI analysis ──────────────────────────────────────────────
    const { analysis, extractedText, tokensUsed, neuronsUsed, processingTimeMs, model } =
      await atsAIService.analyzeResume(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
        jobDescription
      );

    // ── 3. Upload original resume to Azure Blob Storage ─────────────────
    let originalFileUrl = null;
    let originalBlobName = null;
    try {
      const uploadResult = await azureBlobService.uploadResumeFile(
        req.file.buffer,
        req.file.originalname,
        studentId,
        "original"
      );
      originalFileUrl = uploadResult.sasUrl;  // Time-limited download URL
      originalBlobName = uploadResult.blobName;
    } catch (uploadErr) {
      console.error("[ATSController] Failed to upload original file to Azure:", uploadErr);
      return res.status(500).json({
        success: false,
        message: "Failed to upload resume to Azure Blob Storage.",
        error: process.env.NODE_ENV === "development" ? uploadErr.message : undefined,
      });
    }

    // ── 4. Save resume to Resume collection ─────────────────────────────
    const resume = await Resume.create({
      fileName: req.file.originalname,
      fileUrl: originalFileUrl,
      blobName: originalBlobName,
      extractedText: extractedText.slice(0, 10000),
      atsScore: analysis.overallScore,
    });

    // ── 5. Save analysis to ATSAnalysis collection ──────────────────────
    const analysisId = uuidv4();
    const doc = await ATSAnalysis.create({
      analysisId,
      studentId,
      overallScore: analysis.overallScore,
      grade: analysis.grade,
      categoryScores: analysis.categoryScores,
      suggestions: analysis.suggestions,
      strengths: analysis.strengths,
      criticalIssues: analysis.criticalIssues,
      decisions: {},
      jobDescription,
      extractedText: extractedText.slice(0, 10000), // Store truncated for re-analysis
      originalFileName: req.file.originalname,
      originalFileUrl,
      originalBlobName,
      updatedResumeUrl: null,
      aiModel: model,
      tokensUsed,
      neuronsUsed,
      processingTimeMs: Date.now() - startTime,
      status: "complete",
    });

    // ── 6. Return response ───────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: "Resume analyzed successfully.",
      data: {
        analysisId: doc.analysisId,
        resumeId: resume._id,
        overallScore: doc.overallScore,
        grade: doc.grade,
        categoryScores: doc.categoryScores,
        suggestions: doc.suggestions,
        strengths: doc.strengths,
        criticalIssues: doc.criticalIssues,
        originalFileName: doc.originalFileName,
        originalFileUrl: doc.originalFileUrl,
        updatedResumeUrl: null,
        createdAt: doc.createdAt,
      },
    });
  } catch (error) {
    console.error("[ATSController.analyzeResume] Error:", error);

    // Classify error for appropriate HTTP status code
    const isClientError =
      error.message?.includes("Unsupported file") ||
      error.message?.includes("Could not extract") ||
      error.message?.includes("empty");
    const isQuotaError = error.message?.includes("usage limit");

    return res.status(isQuotaError ? 429 : isClientError ? 400 : 500).json({
      success: false,
      message: error.message || "Failed to analyze resume. Please try again.",
    });
  }
};

// ── POST /ats/analyze-existing ────────────────────────────────────────────
/**
 * Analyze an already uploaded resume by blob name.
 * Steps: download from Azure → extract text → AI analysis → update DB → respond
 */
const analyzeExistingResume = async (req, res) => {
  const startTime = Date.now();

  try {
    // ── 1. Validate inputs ──────────────────────────────────────────────
    const { blobName, studentId, jobDescription, resumeId } = req.body;
    const studentIdError = validateStudentId(studentId);
    if (studentIdError) {
      return res.status(400).json({ success: false, message: studentIdError });
    }

    if (!blobName) {
      return res.status(400).json({
        success: false,
        message: "Blob name is required.",
      });
    }

    const usageGuardHit = await checkAIUsageGuards(studentId);
    if (usageGuardHit) {
      return res.status(429).json({ success: false, message: usageGuardHit.message });
    }

    // ── 2. Download file from Azure Blob Storage ───────────────────────
    let fileBuffer, fileName, mimeType;
    try {
      const downloadResult = await azureBlobService.downloadResumeFile(blobName);
      fileBuffer = downloadResult.buffer;
      fileName = downloadResult.fileName;
      mimeType = downloadResult.mimeType;
    } catch (downloadErr) {
      console.error("[ATSController] Failed to download from Azure:", downloadErr);
      return res.status(500).json({
        success: false,
        message: "Failed to download resume from Azure Blob Storage.",
        error: process.env.NODE_ENV === "development" ? downloadErr.message : undefined,
      });
    }

    // ── 3. Run AI analysis ──────────────────────────────────────────────
    const { analysis, extractedText, tokensUsed, neuronsUsed, processingTimeMs, model } =
      await atsAIService.analyzeResume(
        fileBuffer,
        mimeType,
        fileName,
        jobDescription || ""
      );

    // ── 4. Update Resume collection ─────────────────────────────────────
    if (resumeId) {
      await Resume.findByIdAndUpdate(resumeId, {
        atsScore: analysis.overallScore,
        extractedText: extractedText.slice(0, 10000),
      });
    }

    // ── 5. Save analysis to ATSAnalysis collection ──────────────────────
    const analysisId = uuidv4();
    const doc = await ATSAnalysis.create({
      analysisId,
      studentId,
      overallScore: analysis.overallScore,
      grade: analysis.grade,
      categoryScores: analysis.categoryScores,
      suggestions: analysis.suggestions,
      strengths: analysis.strengths,
      criticalIssues: analysis.criticalIssues,
      decisions: {},
      jobDescription: jobDescription || "",
      extractedText: extractedText.slice(0, 10000),
      originalFileName: fileName,
      originalFileUrl: req.body.fileUrl, // Pass the SAS URL if available
      originalBlobName: blobName,
      updatedResumeUrl: null,
      aiModel: model,
      tokensUsed,
      neuronsUsed,
      processingTimeMs: Date.now() - startTime,
      status: "complete",
    });

    // ── 6. Return response ───────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: "Resume analyzed successfully.",
      data: {
        analysisId: doc.analysisId,
        resumeId,
        overallScore: doc.overallScore,
        grade: doc.grade,
        categoryScores: doc.categoryScores,
        suggestions: doc.suggestions,
        strengths: doc.strengths,
        criticalIssues: doc.criticalIssues,
        originalFileName: doc.originalFileName,
        originalFileUrl: doc.originalFileUrl,
        updatedResumeUrl: null,
        createdAt: doc.createdAt,
      },
    });
  } catch (error) {
    console.error("[ATSController.analyzeExistingResume] Error:", error);

    const isClientError =
      error.message?.includes("Unsupported file") ||
      error.message?.includes("Could not extract") ||
      error.message?.includes("empty");
    const isQuotaError = error.message?.includes("usage limit");

    return res.status(isQuotaError ? 429 : isClientError ? 400 : 500).json({
      success: false,
      message: error.message || "Failed to analyze resume. Please try again.",
    });
  }
};

// ── POST /ats/generate-updated-resume ─────────────────────────────────────
/**
 * Generate and upload updated resume with user's kept suggestions applied.
 * Returns a signed Azure Blob Storage URL for download.
 */
const generateUpdatedResume = async (req, res) => {
  try {
    // ── 1. Validate ──────────────────────────────────────────────────────
    const { analysisId, decisions } = req.body;

    const analysisIdError = validateAnalysisId(analysisId);
    if (analysisIdError) {
      return res.status(400).json({ success: false, message: analysisIdError });
    }

    if (!decisions || typeof decisions !== "object") {
      return res.status(400).json({
        success: false,
        message: "Decisions object is required.",
      });
    }

    // ── 2. Fetch original analysis from DB ───────────────────────────────
    const doc = await ATSAnalysis.findOne({
      analysisId,
      isDeleted: { $ne: true },
    });

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Analysis not found. It may have expired or been deleted.",
      });
    }

    // ── 3. Count kept suggestions ────────────────────────────────────────
    const keptCount = Object.values(decisions).filter((d) => d === "keep").length;
    const abortedCount = Object.values(decisions).filter((d) => d === "abort").length;

    if (keptCount === 0) {
      return res.status(400).json({
        success: false,
        message: "No suggestions were kept. Please keep at least one suggestion to generate an updated resume.",
      });
    }

    // ── 4. Generate updated resume content via AI ────────────────────────
    const updatedContent = await atsAIService.generateUpdatedResume(
      doc.extractedText || "",
      doc.suggestions,
      decisions
    );

    // ── 5. Convert text to PDF buffer and upload to Azure ────────────────
    // CONFIGURE: For production, use a PDF generation library like puppeteer, pdfkit, or html-pdf-node
    // For now, we upload the text content as a .txt file as placeholder.
    // Replace with actual PDF generation in production.
    let updatedResumeUrl = null;
    let updatedBlobName = null;

    try {
      const textBuffer = Buffer.from(updatedContent, "utf-8");
      const uploadResult = await azureBlobService.uploadUpdatedResume(
        textBuffer,
        doc.studentId,
        analysisId
      );
      updatedResumeUrl = uploadResult.sasUrl;
      updatedBlobName = uploadResult.blobName;
    } catch (uploadErr) {
      console.error("[ATSController] Failed to upload updated resume:", uploadErr.message);
      return res.status(500).json({
        success: false,
        message: "Analysis complete but failed to generate download file. Please try again.",
      });
    }

    // ── 6. Persist decisions and updated resume URL to DB ────────────────
    const decisionsMap = new Map(Object.entries(decisions));
    await ATSAnalysis.findOneAndUpdate(
      { analysisId },
      {
        decisions: decisionsMap,
        keptCount,
        abortedCount,
        updatedResumeUrl,
        updatedBlobName,
      }
    );

    // ── 7. Respond ───────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: "Updated resume generated successfully.",
      data: {
        downloadUrl: updatedResumeUrl,
        updatedResumeUrl,
        keptCount,
        abortedCount,
      },
    });
  } catch (error) {
    console.error("[ATSController.generateUpdatedResume] Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to generate updated resume.",
    });
  }
};

// ── GET /ats/history/:studentId ───────────────────────────────────────────
/**
 * Fetch paginated ATS analysis history for a student.
 * Returns a summary list (not full analysis data).
 */
const getHistory = async (req, res) => {
  try {
    const { studentId } = req.params;
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "20", 10)));
    const skip = (page - 1) * limit;

    const studentIdError = validateStudentId(studentId);
    if (studentIdError) {
      return res.status(400).json({ success: false, message: studentIdError });
    }

    const [items, total] = await Promise.all([
      ATSAnalysis.find(
        { studentId, isDeleted: { $ne: true }, status: "complete" },
        {
          analysisId: 1,
          overallScore: 1,
          grade: 1,
          originalFileName: 1,
          updatedResumeUrl: 1,
          keptCount: 1,
          createdAt: 1,
          // Virtual
          suggestionsCount: { $size: { $ifNull: ["$suggestions", []] } },
        }
      )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ATSAnalysis.countDocuments({
        studentId,
        isDeleted: { $ne: true },
        status: "complete",
      }),
    ]);

    // Refresh SAS URLs for updated resumes (they expire)
    const itemsWithFreshUrls = await Promise.all(
      items.map(async (item) => {
        if (item.updatedBlobName) {
          const freshUrl = await azureBlobService.refreshSasUrl(item.updatedBlobName);
          return { ...item, updatedResumeUrl: freshUrl };
        }
        return item;
      })
    );

    return res.status(200).json({
      success: true,
      data: itemsWithFreshUrls,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[ATSController.getHistory] Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch analysis history.",
    });
  }
};

// ── GET /ats/analysis/:analysisId ─────────────────────────────────────────
/**
 * Fetch full analysis details by ID (for viewing history detail).
 */
const getAnalysisById = async (req, res) => {
  try {
    const { analysisId } = req.params;

    const analysisIdError = validateAnalysisId(analysisId);
    if (analysisIdError) {
      return res.status(400).json({ success: false, message: analysisIdError });
    }

    const doc = await ATSAnalysis.findOne({
      analysisId,
      isDeleted: { $ne: true },
    }).lean();

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Analysis not found or has expired.",
      });
    }

    // Refresh SAS URLs before returning
    let freshOriginalUrl = doc.originalFileUrl;
    let freshUpdatedUrl = doc.updatedResumeUrl;

    if (doc.originalBlobName) {
      freshOriginalUrl = await azureBlobService.refreshSasUrl(doc.originalBlobName);
    }
    if (doc.updatedBlobName) {
      freshUpdatedUrl = await azureBlobService.refreshSasUrl(doc.updatedBlobName);
    }

    // Convert Map decisions back to plain object for JSON serialization
    const decisions = doc.decisions instanceof Map
      ? Object.fromEntries(doc.decisions)
      : doc.decisions || {};

    return res.status(200).json({
      success: true,
      data: {
        ...doc,
        originalFileUrl: freshOriginalUrl,
        updatedResumeUrl: freshUpdatedUrl,
        decisions,
        extractedText: undefined, // Don't expose raw extracted text
      },
    });
  } catch (error) {
    console.error("[ATSController.getAnalysisById] Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch analysis details.",
    });
  }
};

// ── POST /ats/feedback ────────────────────────────────────────────────────
/**
 * Submit structured feedback for an ATS analysis.
 * Stores feedback in ATSFeedback collection for product improvement analytics.
 */
const submitFeedback = async (req, res) => {
  try {
    const { analysisId, studentId, rating, selectedOptions, additionalComment } = req.body;

    // ── Validate ──────────────────────────────────────────────────────────
    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating is required and must be between 1 and 5.",
      });
    }

    const cleanStudentId = (studentId || req.user?.studentId || "").trim();
    if (!cleanStudentId) {
      return res.status(400).json({
        success: false,
        message: "Student ID is required.",
      });
    }

    // Validate comment length
    const cleanComment = (additionalComment || "").slice(0, 500).trim();

    // ── Save feedback ──────────────────────────────────────────────────────
    const feedback = await ATSFeedback.create({
      studentId: cleanStudentId,
      analysisId: analysisId || null,
      rating,
      selectedOptions: {
        accuracy: Array.isArray(selectedOptions?.accuracy) ? selectedOptions.accuracy.slice(0, 10) : [],
        helpfulness: Array.isArray(selectedOptions?.helpfulness) ? selectedOptions.helpfulness.slice(0, 10) : [],
        improvements: Array.isArray(selectedOptions?.improvements) ? selectedOptions.improvements.slice(0, 10) : [],
      },
      additionalComment: cleanComment,
    });

    return res.status(201).json({
      success: true,
      message: "Feedback submitted successfully. Thank you!",
      data: { feedbackId: feedback._id },
    });
  } catch (error) {
    console.error("[ATSController.submitFeedback] Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit feedback. Please try again.",
    });
  }
};

module.exports = {
  analyzeResume,
  analyzeExistingResume,
  generateUpdatedResume,
  getHistory,
  getAnalysisById,
  submitFeedback,
};
