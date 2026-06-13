const mongoose = require('mongoose');

const ResumeSchema = new mongoose.Schema({
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
});

module.exports = mongoose.model('Resume', ResumeSchema);