'use strict';

const { Router } = require('express');
const aiRouter = require('../../../shared/utils/ai');

const router = Router();

// ─── AI Assistants & Tools ──────────────────────────────────────────────────

// Mount central AI router under /ai
// Endpoints:
//   POST /mobileapp/ai/generateExp       - Course assistant Q&A
//   POST /mobileapp/ai/checkEnglishText  - Grammar & English assessment
//   POST /mobileapp/ai/repharseSummary   - Resume professional summary rephraser
//   POST /mobileapp/ai/checkCode         - Coding review and hints
//   POST /mobileapp/ai/testCases         - Problem test case generation
router.use('/ai', aiRouter);

module.exports = router;

