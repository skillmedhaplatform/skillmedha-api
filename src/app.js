'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const multer = require('multer');
const { execSync } = require('child_process');
const { initializeApolloServer } = require('./modules/test/gql');
// ─── Shared infrastructure ────────────────────────────────────────────────────
const config = require('./config');
const logger = require('./shared/utils/logger');
const { connectSharedDB, getGlobalCollections } = require('./shared/db/connection');
const { optional, mandatory } = require('./shared/middleware/auth.middleware');
const { selectTenantDB } = require('./shared/middleware/selectTenantDB.middleware');
const { errorMiddleware } = require('./shared/middleware/error.middleware');
const { compressionMiddleware } = require('./shared/middleware/compression');

// ─── Module routers ───────────────────────────────────────────────────────────
const studentRouter = require('./modules/student/index');
const adminRouter = require('./modules/admin/index');
const tpoRouter = require('./modules/tpo/index');
const testRouter = require('./modules/test/index');
const proctoringRouter = require('./modules/proctoring/index');

// Shared service utilities (no re-export changes)
// Note: AI service runs as separate microservice on port 7172 - see src/shared/utils/ai.js
const azureBlobService = require('./shared/utils/azureBlobService');
const zoomRouter = require('./shared/utils/zoom');

// ─── Dashboard (admin analytics) ──────────────────────────────────────────────
const dashboardRoutes = require('./modules/admin/services/dashboard/dashboardRoutes');
const { connectDB: connectDashboardDB, closeDB: closeDashboardDB } =
  require('./modules/admin/services/dashboard/dashboardDatabase');

// ─── Zoom & AI utils ──────────────────────────────────────────────────────────
const {
  createMeeting,
  signature,
  getMeetingDetails,
  getAllMeetings,
  updateMeeting,
  getRecordedMeeting,
} = require('./shared/utils/zoom');

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const OpenAI = require('openai');
const openai = new OpenAI({ organization: config.openai.orgId, project: config.openai.projId });

// ─── ffmpeg ───────────────────────────────────────────────────────────────────
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(compressionMiddleware);
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// ─── Uploads directory ────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, true) });

// ─── Optional auth on all requests (populates req.isAuth, req.userId etc) ────
app.use(optional);

// ─── Marquee public route (must be before mandatory auth) ────────────────────
const { getMarqueeNotices } = require('./modules/admin/services/marquee.service');
app.get('/marquee', getMarqueeNotices);

// ─── Public Dashboard Stats (For Login Page Promo) ───────────────────────────
app.get('/api/public/stats', async (req, res) => {
  try {
    const dashboardService = require('./modules/admin/services/dashboard/dashboardService');
    const stats = await dashboardService.getDashboardStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error("Public stats error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Azure Blob upload endpoints ─────────────────────────────────────────────
function getAudioDurationInSeconds(filePath) {
  try {
    const cmd = `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    const output = execSync(cmd, { encoding: 'utf8' }).trim();
    const secs = parseFloat(output);
    return isNaN(secs) ? 0 : secs;
  } catch (err) {
    logger.error('Failed to get audio duration:', err.message);
    return 0;
  }
}

function getMaxVolumeInDb(filePath) {
  try {
    const cmd = `"${ffmpegPath}" -hide_banner -i "${filePath}" -af volumedetect -f null - 2>&1`;
    const output = execSync(cmd, { encoding: 'utf8' });
    const match = output.match(/max_volume:\s*(-?\d+(\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
  } catch (err) {
    logger.error('Failed to get audio volume:', err.message);
    return null;
  }
}

const isAudioSilentOrEmpty = (filePath, { minDuration = 1.0, maxVolumeThreshold = -40 } = {}) => {
  const duration = getAudioDurationInSeconds(filePath);
  const maxVolume = getMaxVolumeInDb(filePath);
  if (duration < minDuration) return false;
  if (maxVolume === null || maxVolume < maxVolumeThreshold) return false;
  return false;
};

async function transcribeAudio(audio) {
  try {
    if (isAudioSilentOrEmpty(audio)) {
      throw new Error("Oops! We couldn't hear you. Please try speaking a bit louder.");
    }
    const langDetect = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audio),
      model: 'whisper-1',
      response_format: 'verbose_json',
    });
    if (langDetect.language !== 'english') {
      throw new Error(`Unsupported language: ${langDetect.language}. Please record in English.`);
    }
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audio),
      model: 'whisper-1',
      language: 'en',
      response_format: 'verbose_json',
    });
    return transcription;
  } catch (error) {
    logger.error('transcribeAudio error:', error.message);
    return { err: error.message, text: '' };
  }
}

const getFileURI = (containerName, key) => azureBlobService.getBlobUrl(containerName, key);

app.post('/uploadToS3', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const bucketName = req.query.bucketName;
    const task = req.query.task || '';
    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath);
    const data = await azureBlobService.uploadBlob(bucketName, path.basename(filePath), fileContent, req.file.mimetype);
    if (!data.success) throw new Error('Upload error');

    if (task === 'transcribe') {
      const transcription = await transcribeAudio(filePath);
      fs.rmSync(filePath);
      return res.json({ ...data, transcription, file: getFileURI(bucketName, path.basename(filePath)) });
    }

    fs.rmSync(filePath);
    res.json({ ...data, file: getFileURI(bucketName, path.basename(filePath)), key: path.basename(filePath) });
  } catch (error) {
    logger.error('uploadToS3 error:', error.message);
    if (req.file?.path) { try { fs.rmSync(req.file.path); } catch (_) { } }
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/upload-resume', upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No resume file uploaded.' });
  const { orgId } = req;
  const { uniqueName, bucketName } = req.body;
  if (!uniqueName || !bucketName) {
    return res.status(400).json({ success: false, message: "Missing 'uniqueName' or 'bucketName'." });
  }
  const filePath = req.file.path;
  try {
    const fileExtension = path.extname(req.file.originalname);
    const fileKey = `resumes/${orgId}/${uniqueName}${fileExtension}`;
    const fileContent = fs.readFileSync(filePath);
    const data = await azureBlobService.uploadBlob(bucketName, fileKey, fileContent, req.file.mimetype);
    if (!data.success) throw new Error('Failed to upload file to Azure Blob.');
    fs.rmSync(filePath);
    res.status(200).json({ success: true, message: 'Resume uploaded successfully.', fileUrl: getFileURI(bucketName, fileKey), key: fileKey });
  } catch (error) {
    logger.error('upload-resume error:', error.message);
    try { fs.rmSync(filePath); } catch (_) { }
    res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

// ─── Mandatory auth for all downstream routes ─────────────────────────────────

// app.use(mandatory);

// ─── Universities / Colleges ──────────────────────────────────────────────────
app.get('/getAllUniversities', async (req, res) => {
  const { colleges } = getGlobalCollections();
  try {
    const data = await colleges.distinct('universityName');
    res.status(200).json({ data });
  } catch (e) { res.status(500).json({ err: e.message }); }
});

app.get('/getColleges/:code', async (req, res) => {
  const { colleges } = getGlobalCollections();
  try {
    const data = await colleges.find({ universityCode: req.params.code }).toArray();
    res.status(200).json({ data });
  } catch (e) { res.status(500).json({ err: e.message }); }
});

app.get('/getAllTenants', async (req, res) => {
  const { organisation } = getGlobalCollections();
  try {
    const data = await organisation.find({}).toArray();
    res.status(200).json({ data });
  } catch (e) { res.status(500).json({ err: e.message }); }
});

// ─── Zoom meeting routes ───────────────────────────────────────────────────────
app.post('/createMeeting', async (req, res) => createMeeting(req, res));
app.post('/signature', async (req, res) => signature(req, res));
app.post('/getMeetingDetails', async (req, res) => getMeetingDetails(req, res));
app.get('/getAllMeetings', async (req, res) => getAllMeetings(req, res));
app.post('/updateMeeting/:id', async (req, res) => updateMeeting(req, res));
app.post('/getRecordedMeeting', async (req, res) => getRecordedMeeting(req, res));

// ─── Role-based module routers ────────────────────────────────────────────────
//
// Student module  → handles: auth, profile, resume, internships (student view),
//                            assessments (student view), notice board, departments,
//                            practice (student view), company, tpo, jobs (student view)
app.use('/', studentRouter);

// Admin module    → handles: CMS (skills/questions/practices), admin auth,
//                            payments (Razorpay), platform assessments, job management
app.use('/', adminRouter);

// TPO module      → handles: departments, notice board, placements/job management,
//                            psychometric test results
app.use('/', tpoRouter);

// Test module     → handles: TPO local test creation/management, question bank,
//                            bulk uploads, comprehension questions, results
app.use('/', testRouter);

// Proctoring module → handles: Agora (live sessions), AWS Rekognition (face detection)
app.use('/', proctoringRouter);

// ─── Dashboard (admin analytics) ─────────────────────────────────────────────
app.use('/api/dashboard', dashboardRoutes);


// ─── Questions route (questions/:id) from placements ─────────────────────────
const { getQuestionById, updateQuestion } = require('./modules/student/services/placements.service');
app.get('/questions/:id', mandatory, selectTenantDB, getQuestionById);
app.put('/questions/:id', mandatory, selectTenantDB, updateQuestion);

// ─── AI routes ────────────────────────────────────────────────────────────────
// AI service is a separate microservice running on port 7172 - not included here
// If needed, proxy requests via nginx or call it directly from client
// app.use('/ai', aiRouter);

// ─── Centralised error handler (must be last) ─────────────────────────────────
app.use(errorMiddleware);

// ─── Socket.IO (test sessions) ────────────────────────────────────────────────
const { Server: SocketServer } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { redisClient, redisSubscriber } = require('./shared/cache/redis');

const io = new SocketServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Attach Redis adapter for horizontal scaling
if (redisClient && redisSubscriber) {
  try {
    io.adapter(createAdapter(redisClient, redisSubscriber));
    logger.info('[Socket.IO] Redis adapter attached');
  } catch (e) {
    logger.warn('[Socket.IO] Redis adapter failed, running without it:', e.message);
  }
} else {
  logger.info('[Socket.IO] Redis adapter disabled, running without it');
}

// Attach socket handler (original socket.js logic, re-imported)
const attachSocketHandlers = require('./modules/tpo/services/socket.service');
attachSocketHandlers(io, app);

// ─── Server start ─────────────────────────────────────────────────────────────
async function startServer() {
  try {
    // 1. Connect shared MongoDB
    await connectSharedDB();
    logger.info('[DB] Shared MongoDB connected');

    // 2. Connect dashboard DB
    try { await connectDashboardDB(); logger.info('[DB] Dashboard DB connected'); }
    catch (e) { logger.warn('[DB] Dashboard DB connect warning:', e.message); }

    // 2.5 Initialize GraphQL router mounted at /gql
    try {
      await initializeApolloServer(app, '/gql');
      logger.info('[GQL] Apollo GraphQL mounted at /gql');
    } catch (e) {
      logger.warn('[GQL] Failed to initialize ApolloServer:', e.message);
    }

    // 3. Start HTTP server
    const port = config.port;
    httpServer.listen(port, () => {
      logger.info(`🚀 Skillmedha API running on port ${port} [${config.env}]`);
      logger.info(`   REST  → http://localhost:${port}`);
      logger.info(`   Socket→ ws://localhost:${port}`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}



// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

async function gracefulShutdown(signal) {
  logger.info(`\n[${signal}] Shutting down gracefully...`);
  try { await closeDashboardDB(); } catch (_) { }
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
}

startServer();

module.exports = { app, httpServer, io };
