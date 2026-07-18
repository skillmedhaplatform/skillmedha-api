const mongoose = require('mongoose');

const ResumeSchema = new mongoose.Schema({
  // A student has exactly one Resume record — new uploads replace it
  // rather than accumulating (see fileUploadController.uploadResume).
  studentId: {
    type: String,
    required: true,
    index: true,
  },
  fileName: {
    type: String,
    required: true,
  },
  fileUrl: {
    type: String,
    required: true,
  },
  blobName: {
    type: String,
    required: true,
  },
  atsScore: {
    type: Number,
    default: null,
  },
  extractedText: {
    type: String,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Resume', ResumeSchema);