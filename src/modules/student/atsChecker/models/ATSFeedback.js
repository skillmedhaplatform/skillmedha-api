/**
 * ATSFeedback.js
 * MongoDB model for storing user feedback on ATS analyses.
 * Structured feedback (options-based) enables systematic aggregation and improvement tracking.
 *
 * Place this file in your Node.js/Express API repo under: models/ATSFeedback.js
 */

const mongoose = require("mongoose");

const ATSFeedbackSchema = new mongoose.Schema(
  {
    // ── Links ────────────────────────────────────────────────────────────
    studentId: {
      type: String,
      required: true,
      index: true,
    },
    analysisId: {
      type: String,           // The analysis this feedback is for (nullable if general)
      index: true,
      default: null,
    },

    // ── Rating (1–5 emoji scale) ──────────────────────────────────────────
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },

    // ── Structured option selections ──────────────────────────────────────
    // selectedOptions.accuracy — feedback on suggestion accuracy
    // selectedOptions.helpfulness — what was most helpful
    // selectedOptions.improvements — what should be improved
    selectedOptions: {
      accuracy: [{ type: String }],
      helpfulness: [{ type: String }],
      improvements: [{ type: String }],
    },

    // ── Optional freeform comment ─────────────────────────────────────────
    additionalComment: {
      type: String,
      maxlength: 500,
      default: "",
    },

    // ── Metadata ──────────────────────────────────────────────────────────
    appVersion: { type: String },             // Track which version of the feature was used
    platform: { type: String, default: "web" },
  },
  {
    timestamps: true,
    collection: "ats_feedback",
  }
);

// Index for analytics queries
ATSFeedbackSchema.index({ rating: 1, createdAt: -1 });
ATSFeedbackSchema.index({ "selectedOptions.improvements": 1 });

module.exports = mongoose.model("ATSFeedback", ATSFeedbackSchema);
