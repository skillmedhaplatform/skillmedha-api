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

    const jobDescription = (req.body.jobDescription || "").slice(0, 5000).trim();

    // ── 2. Run AI analysis ──────────────────────────────────────────────
    const { analysis, extractedText, tokensUsed, processingTimeMs, model } =
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

    return res.status(isClientError ? 400 : 500).json({
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
    const { analysis, extractedText, tokensUsed, processingTimeMs, model } =
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

    return res.status(isClientError ? 400 : 500).json({
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
