/**
 * ATSAnalysis.js
 * MongoDB model for storing ATS resume analysis results.
 * Each document represents one complete analysis of a student's resume.
 *
 * Place this file in your Node.js/Express API repo under: models/ATSAnalysis.js
 */

const mongoose = require("mongoose");

// ── Sub-schema: Category Score ─────────────────────────────────────────────
const CategoryScoreSchema = new mongoose.Schema(
  {
    score: { type: Number, required: true, min: 0, max: 100 },
    maxScore: { type: Number, default: 100 },
    label: { type: String, required: true },
    description: { type: String },
  },
  { _id: false }
);

// ── Sub-schema: Individual Suggestion ─────────────────────────────────────
const SuggestionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },            // Unique ID within this analysis (e.g., "sug_001")
    category: {
      type: String,
      required: true,
      enum: [
        "keywords", "formatting", "sections", "readability",
        "actionVerbs", "quantification", "contact", "summary",
        "experience", "education", "skills",
      ],
    },
    priority: {
      type: String,
      required: true,
      enum: ["high", "medium", "low"],
    },
    title: { type: String, required: true, maxlength: 200 },
    original: { type: String, maxlength: 1000 },      // Original text from resume
    suggested: { type: String, maxlength: 1000 },     // AI-suggested replacement text
    reason: { type: String, maxlength: 500 },          // Why the change is needed
    impactPoints: { type: Number, default: 0 },        // Estimated score improvement
    section: { type: String, maxlength: 100 },         // Resume section (e.g., "Work Experience")
  },
  { _id: false }
);

// ── Main Schema ────────────────────────────────────────────────────────────
const ATSAnalysisSchema = new mongoose.Schema(
  {
    analysisId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    studentId: {
      type: String,         // References the student in the students collection
      required: true,
      index: true,
    },

    // ── Scores ──────────────────────────────────────────────────────────
    overallScore: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    grade: {
      type: String,
      enum: ["A+", "A", "B", "C", "D", "F"],
      required: true,
    },
    categoryScores: {
      keywords:       { type: CategoryScoreSchema },
      formatting:     { type: CategoryScoreSchema },
      sections:       { type: CategoryScoreSchema },
      readability:    { type: CategoryScoreSchema },
      actionVerbs:    { type: CategoryScoreSchema },
      quantification: { type: CategoryScoreSchema },
    },

    // ── AI Analysis Results ──────────────────────────────────────────────
    suggestions: [SuggestionSchema],
    strengths: [{ type: String, maxlength: 300 }],
    criticalIssues: [{ type: String, maxlength: 300 }],

    // ── User Decisions ───────────────────────────────────────────────────
    // Stored after user reviews suggestions: { suggestionId: "keep" | "abort" }
    decisions: {
      type: Map,
      of: { type: String, enum: ["keep", "abort"] },
      default: {},
    },
    keptCount: { type: Number, default: 0 },
    abortedCount: { type: Number, default: 0 },

    // ── File Storage (Azure Blob Storage URLs) ───────────────────────────
    originalFileName: { type: String, maxlength: 255 },
    originalFileUrl: { type: String },    // Azure Blob URL for original uploaded resume
    originalBlobName: { type: String },   // Azure Blob name for internal reference
    updatedResumeUrl: { type: String },   // Azure Blob URL for AI-generated updated resume
    updatedBlobName: { type: String },

    // ── Input ────────────────────────────────────────────────────────────
    jobDescription: { type: String, maxlength: 5000 }, // Optional job description for targeted analysis
    extractedText: { type: String },                    // Raw extracted resume text (for re-analysis)

    // ── AI Metadata ──────────────────────────────────────────────────────
    aiModel: { type: String, default: "gpt-4o" },       // AI model used
    tokensUsed: { type: Number },                        // OpenAI tokens consumed
    processingTimeMs: { type: Number },                  // Total processing time

    // ── Status ───────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["processing", "complete", "error"],
      default: "processing",
    },
    errorMessage: { type: String },

    // ── Soft delete / expiry ──────────────────────────────────────────────
    isDeleted: { type: Boolean, default: false },
    expiresAt: {
      type: Date,
      // CONFIGURE: Files are retained for 90 days. Adjust as needed.
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      index: { expireAfterSeconds: 0 }, // MongoDB TTL index
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
    collection: "ats_analyses",
  }
);

// ── Compound index for history queries ────────────────────────────────────
ATSAnalysisSchema.index({ studentId: 1, createdAt: -1 });
ATSAnalysisSchema.index({ studentId: 1, isDeleted: 1, createdAt: -1 });

// ── Virtual: suggestionsCount ─────────────────────────────────────────────
ATSAnalysisSchema.virtual("suggestionsCount").get(function () {
  return this.suggestions?.length || 0;
});

ATSAnalysisSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("ATSAnalysis", ATSAnalysisSchema);
