/**
 * fileUpload.js (Express Router)
 * All file upload and delete API routes for Azure Blob Storage.
 *
 * Mount this router in your main Express app:
 *   const fileUploadRouter = require("./routes/fileUpload");
 *   app.use("/api", fileUploadRouter);
 *
 * Full endpoint URLs (assuming mounted at /api):
 *   POST   /api/upload-resume    - Upload resume to Azure Blob Storage
 *   DELETE /api/delete-resume    - Delete resume from Azure Blob Storage
 *
 * Place this file in your Node.js/Express API repo under: routes/fileUpload.js
 */

const express = require("express");
const router = express.Router();
const { uploadResume, deleteResume } = require("../controllers/fileUploadController");
const {
  uploadResumeSingle,
  validateFilePresence,
  validateFileSize,
} = require("../middleware/s3FileUpload");

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * POST /api/upload-resume
 * Upload a resume file to Azure Blob Storage.
 * Multipart form-data with fields:
 *   - resume (file): PDF, DOCX, or DOC resume file (max 5MB)
 *   - studentId (string): Student identifier
 *
 * Response: { success: true, data: { blobName, blobUrl, sasUrl, container } }
 */
router.post(
  "/upload-resume",
  uploadResumeSingle,      // Multer middleware: parses multipart, validates file
  validateFilePresence,    // Ensure req.file is present
  validateFileSize,        // Additional file size validation
  uploadResume             // Controller: uploads to S3
);

/**
 * DELETE /api/delete-resume
 * Delete a resume file from AWS S3.
 * Body: { fileKey: string, studentId?: string }
 *
 * Response: { success: true, message: "File deleted successfully", data: { fileKey } }
 */
router.delete("/delete-resume", deleteResume);

module.exports = router;