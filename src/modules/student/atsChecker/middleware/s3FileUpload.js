/**
 * s3FileUpload.js
 * Multer middleware for AWS S3 resume file upload validation.
 * Validates file type, size, and presence before reaching the controller.
 *
 * Required npm packages:
 *   npm install multer
 *
 * Place this file in your Node.js/Express API repo under: middleware/s3FileUpload.js
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

// ── Multer storage (memory — we stream directly to AWS S3) ─────────────
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
const uploadResumeToS3 = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1, // Only one file per request
  },
});

// ── Middleware functions ───────────────────────────────────────────────────

/**
 * Middleware to handle single resume file upload for S3.
 * Use: router.post('/upload-resume', uploadResumeSingle, controller)
 */
const uploadResumeSingle = uploadResumeToS3.single("resume");

/**
 * Middleware to validate that a file was uploaded.
 * Should be used after uploadResumeSingle.
 */
const validateFilePresence = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No file uploaded. Please provide a resume file.",
    });
  }
  next();
};

/**
 * Middleware to validate file size (additional check beyond multer limits).
 */
const validateFileSize = (req, res, next) => {
  if (req.file && req.file.size > MAX_FILE_SIZE_BYTES) {
    return res.status(400).json({
      success: false,
      message: `File size exceeds ${MAX_FILE_SIZE_MB}MB limit.`,
    });
  }
  next();
};

module.exports = {
  uploadResumeSingle,
  validateFilePresence,
  validateFileSize,
};