'use strict';

const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const azureBlobService = require('../../../shared/utils/azureBlobService');
const logger = require('../../../shared/utils/logger');
const { mandatory, optional } = require('../../../shared/middleware/auth.middleware');

const router = Router();

// Configure disk storage for incoming uploads
const uploadsDir = path.join(__dirname, '../../../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, true) });

const getFileURI = (containerName, key) => azureBlobService.getBlobUrl(containerName, key);

async function transcribeAudio(audioPath) {
  try {
    const model = '@cf/openai/whisper-large-v3-turbo';
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !token) {
      throw new Error('Cloudflare AI credentials are not configured');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const audioBase64 = fs.readFileSync(audioPath).toString('base64');

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ audio: audioBase64 }),
    });

    const json = await resp.json();
    if (!resp.ok || json.success === false) {
      throw new Error(json?.errors?.[0]?.message || `Transcription request failed (${resp.status})`);
    }

    const language = json.result?.transcription_info?.language || '';
    if (language && language !== 'en') {
      throw new Error(`Unsupported language: ${language}. Please record in English.`);
    }

    return { text: json.result?.text || '', language };
  } catch (error) {
    logger.error('transcribeAudio error:', error.message);
    return { err: error.message, text: '' };
  }
}

// ─── File & Audio Uploads ───────────────────────────────────────────────────

// POST /mobileapp/uploadToS3 (Upload documents, avatars, certificates, or audio for transcription)
router.post('/uploadToS3', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const bucketName = req.query.bucketName || 'skillmedha-utils';
    const task = req.query.task || '';
    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath);
    const data = await azureBlobService.uploadBlob(bucketName, path.basename(filePath), fileContent, req.file.mimetype);
    if (!data.success) throw new Error('Upload error');

    if (task === 'transcribe') {
      const transcription = await transcribeAudio(filePath);
      try { fs.rmSync(filePath); } catch (_) {}
      return res.json({ ...data, transcription, file: getFileURI(bucketName, path.basename(filePath)) });
    }

    try { fs.rmSync(filePath); } catch (_) {}
    res.json({ ...data, file: getFileURI(bucketName, path.basename(filePath)), key: path.basename(filePath) });
  } catch (error) {
    logger.error('mobile uploadToS3 error:', error.message);
    if (req.file?.path) { try { fs.rmSync(req.file.path); } catch (_) {} }
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /mobileapp/upload-resume (Authenticated resume upload to Azure Blob)
router.post('/upload-resume', mandatory, upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No resume file uploaded.' });
  const { orgId } = req;
  const { uniqueName, bucketName = 'skillmedha-resumes' } = req.body;
  if (!uniqueName) {
    return res.status(400).json({ success: false, message: "Missing 'uniqueName'." });
  }
  const filePath = req.file.path;
  try {
    const fileExtension = path.extname(req.file.originalname);
    const fileKey = `resumes/${orgId}/${uniqueName}${fileExtension}`;
    const fileContent = fs.readFileSync(filePath);
    const data = await azureBlobService.uploadBlob(bucketName, fileKey, fileContent, req.file.mimetype);
    if (!data.success) throw new Error('Failed to upload file to Azure Blob.');
    try { fs.rmSync(filePath); } catch (_) {}
    res.status(200).json({ success: true, message: 'Resume uploaded successfully.', fileUrl: getFileURI(bucketName, fileKey), key: fileKey });
  } catch (error) {
    logger.error('mobile upload-resume error:', error.message);
    try { fs.rmSync(filePath); } catch (_) {}
    res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

module.exports = router;

