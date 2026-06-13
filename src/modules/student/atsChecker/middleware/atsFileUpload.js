/**
 * atsFileUpload.js
 * Multer middleware for ATS resume file upload validation.
 * Validates file type, size, and presence before reaching the controller.
 *
 * Required npm packages:
 *   npm install multer
 *
 * Place this file in your Node.js/Express API repo under: middleware/atsFileUpload.js
 */

const multer = require("multer");

// ── Configuration ─────────────────────────────────────────────────────────
const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
];

const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".doc"];

// ── Multer storage (memory — we stream directly to Azure Blob) ─────────────
const storage = multer.memoryStorage();

// ── File filter ────────────────────────────────────────────────────────────
const fileFilter = (req, file, cb) => {
  const ext = "." + (file.originalname || "").split(".").pop().toLowerCase();
  const isAllowedMime = ALLOWED_MIME_TYPES.includes(file.mimetype);
  const isAllowedExt = ALLOWED_EXTENSIONS.includes(ext);

  if (!isAllowedMime && !isAllowedExt) {
    return cb(
      new multer.MulterError(
        "LIMIT_UNEXPECTED_FILE",
        `Unsupported file type "${file.mimetype}". Only PDF, DOCX, and DOC files are allowed.`
      ),
      false
    );
  }
  cb(null, true);
};

// ── Multer instance ────────────────────────────────────────────────────────
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1, // Only one file per request
  },
});

// ── Middleware wrapper with improved error messages ────────────────────────

/**
 * Single-file upload middleware for resume field.
 * Attaches file to req.file on success.
 * Passes structured errors to Express error handler on failure.
 */
const uploadResumeSingle = (req, res, next) => {
  upload.single("resume")(req, res, (err) => {
    if (!err) return next();

    // Handle Multer-specific errors with user-friendly messages
    if (err instanceof multer.MulterError) {
      switch (err.code) {
        case "LIMIT_FILE_SIZE":
          return res.status(400).json({
            success: false,
            message: `File too large. Maximum allowed size is ${MAX_FILE_SIZE_MB}MB. Please compress your resume and try again.`,
          });
        case "LIMIT_FILE_COUNT":
          return res.status(400).json({
            success: false,
            message: "Only one resume file can be uploaded at a time.",
          });
        case "LIMIT_UNEXPECTED_FILE":
          return res.status(400).json({
            success: false,
            message: err.message || "Invalid file type. Only PDF, DOCX, and DOC files are allowed.",
          });
        default:
          return res.status(400).json({
            success: false,
            message: `File upload error: ${err.message}`,
          });
      }
    }

    // Generic error
    console.error("[atsFileUpload] Upload error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to process file upload. Please try again.",
    });
  });
};

/**
 * Post-upload validation middleware.
 * Ensures req.file is present and not empty after upload.
 */
const validateFilePresence = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No resume file provided. Please upload a PDF or DOCX file.",
    });
  }

  if (!req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Uploaded file appears to be empty. Please check your file and try again.",
    });
  }

  next();
};

module.exports = {
  uploadResumeSingle,
  validateFilePresence,
};
