/**
 * fileUploadController.js
 * Express controller handling file upload and delete operations for Azure Blob Storage.
 *
 * Place this file in your Node.js/Express API repo under: controllers/fileUploadController.js
 */

const Resume = require("../models/Resume");
const azureBlobService = require("../services/azureBlobService");

// ── Input Validators ──────────────────────────────────────────────────────

const validateStudentId = (studentId) => {
  if (!studentId || typeof studentId !== "string" || studentId.trim().length < 3) {
    return "Invalid or missing student ID.";
  }
  return null;
};

const validateFileKey = (fileKey) => {
  if (!fileKey || typeof fileKey !== "string" || fileKey.trim().length === 0) {
    return "Invalid or missing file key.";
  }
  return null;
};

// ── POST /upload-resume ──────────────────────────────────────────────────
/**
 * Upload resume file to Azure Blob Storage.
 * A student keeps exactly one resume on file — uploading a new one replaces
 * (deletes) whatever blob/record they had before, rather than accumulating.
 *
 * Multipart form-data with fields:
 *   - resume (file): PDF, DOCX, or DOC resume file
 *   - studentId (string): Student identifier
 *
 * Returns: { success: true, blobName, blobUrl, sasUrl, container }
 */
const uploadResume = async (req, res) => {
  try {
    // ── 1. Validate inputs ──────────────────────────────────────────────
    const studentId = (req.body.studentId || "").trim();
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

    // ── 2. Remove any previous resume this student had on file ──────────
    const existing = await Resume.findOne({ studentId });
    if (existing?.blobName) {
      await azureBlobService.deleteBlob(existing.blobName);
    }

    // ── 3. Upload new file to Azure Blob Storage ─────────────────────────
    const { buffer, originalname } = req.file;

    const uploadResult = await azureBlobService.uploadResumeFile(
      buffer,
      originalname,
      studentId,
      "original"
    );

    // ── 4. Upsert the student's single Resume record ─────────────────────
    const resume = await Resume.findOneAndUpdate(
      { studentId },
      {
        studentId,
        fileName: originalname,
        fileUrl: uploadResult.sasUrl,
        blobName: uploadResult.blobName,
        atsScore: null,
        extractedText: "",
        updatedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // ── 5. Return success response ──────────────────────────────────────
    res.status(200).json({
      success: true,
      message: "File uploaded successfully",
      data: {
        resumeId: resume._id,
        blobName: uploadResult.blobName,
        blobUrl: uploadResult.blobUrl,
        sasUrl: uploadResult.sasUrl,
        container: process.env.AZURE_STORAGE_CONTAINER_NAME || "ats-resumes",
      },
    });

  } catch (error) {
    console.error("Error in uploadResume:", error);
    res.status(500).json({
      success: false,
      message: "Failed to upload file",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ── GET /resume/:studentId ────────────────────────────────────────────────
/**
 * Fetch the student's current resume on file, if any.
 * Returns { success: true, data: null } when the student has no resume yet.
 */
const getCurrentResume = async (req, res) => {
  try {
    const { studentId } = req.params;
    const studentIdError = validateStudentId(studentId);
    if (studentIdError) {
      return res.status(400).json({ success: false, message: studentIdError });
    }

    const resume = await Resume.findOne({ studentId }).lean();
    if (!resume) {
      return res.status(200).json({ success: true, data: null });
    }

    // SAS URLs are time-limited — refresh before returning.
    const freshUrl = await azureBlobService.refreshSasUrl(resume.blobName);

    return res.status(200).json({
      success: true,
      data: {
        resumeId: resume._id,
        fileName: resume.fileName,
        blobName: resume.blobName,
        fileUrl: freshUrl || resume.fileUrl,
        atsScore: resume.atsScore,
        createdAt: resume.createdAt,
        updatedAt: resume.updatedAt,
      },
    });
  } catch (error) {
    console.error("Error in getCurrentResume:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch current resume.",
    });
  }
};

// ── DELETE /delete-resume ────────────────────────────────────────────────
/**
 * Delete resume file from Azure Blob Storage and its Resume record.
 * Body: { blobName: string, fileKey?: string, studentId?: string }
 *
 * Returns: { success: true, message, blobName }
 */
const deleteResume = async (req, res) => {
  try {
    // ── 1. Validate inputs ──────────────────────────────────────────────
    const fileKey = req.body.blobName || req.body.fileKey;
    const { studentId } = req.body;

    const fileKeyError = validateFileKey(fileKey);
    if (fileKeyError) {
      return res.status(400).json({ success: false, message: fileKeyError });
    }

    // Optional: Validate studentId if provided
    if (studentId) {
      const studentIdError = validateStudentId(studentId);
      if (studentIdError) {
        return res.status(400).json({ success: false, message: studentIdError });
      }
    }

    // ── 2. Delete file from Azure Blob Storage ──────────────────────────
    await azureBlobService.deleteBlob(fileKey);

    // ── 3. Remove the matching Resume record, if any ─────────────────────
    await Resume.deleteOne({ blobName: fileKey });

    // ── 4. Return success response ──────────────────────────────────────
    res.status(200).json({
      success: true,
      message: "File deleted successfully",
      data: {
        blobName: fileKey,
      },
    });

  } catch (error) {
    console.error("Error in deleteResume:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete file",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  uploadResume,
  getCurrentResume,
  deleteResume,
};
