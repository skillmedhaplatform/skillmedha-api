/**
 * atsAIService.js
 * Core ATS analysis service using Cloudflare Workers AI (same provider already
 * used across the app in src/shared/utils/ai.js), instead of OpenAI.
 * Handles resume text extraction (PDF/DOCX), AI analysis, and updated resume generation.
 *
 * Required npm packages:
 *   npm install pdf-parse mammoth uuid
 *
 * Required environment variables (already configured in .env):
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_AI_MODEL        (default text model)
 *   CLOUDFLARE_AI_MODEL_LARGE  (higher-quality model, used here for analysis)
 *
 * Place this file in your Node.js/Express API repo under: services/atsAIService.js
 */

const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");
const { v4: uuidv4 } = require("uuid");

/*****************************************
 *  CLOUDFLARE WORKERS AI CLIENT
 *  (mirrors src/shared/utils/ai.js's runWorkersAI)
 *****************************************/

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_MODEL_DEFAULT =
  process.env.CLOUDFLARE_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
const CF_MODEL_LARGE =
  process.env.CLOUDFLARE_AI_MODEL_LARGE ||
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Cloudflare's free Workers AI tier is a single shared 10,000-neuron/day
// budget for the whole account, and it's shared with every other AI feature
// in the app (src/shared/utils/ai.js). The 70b model costs ~5x more neurons
// per call than the 8b model for this workload (measured: ~250 vs ~53 for
// the same analysis prompt), so it must not be the default for a
// high-volume route like resume analysis — use the cheap model as primary,
// and only escalate to the large model as a last resort on a genuine
// (non-quota) failure.
const PRIMARY_MODEL = CF_MODEL_DEFAULT;
const FALLBACK_MODEL = CF_MODEL_LARGE;

// Mirrors the OpenAI chat-completion response shape (choices[0].message.content,
// usage.{prompt,completion,total}_tokens) so the rest of this file doesn't change.
//
// max_tokens defaults to Workers AI's own default (256) when omitted, which
// silently truncates the large JSON payload this service asks for — always
// pass an explicit value here.
const runWorkersAI = async ({ model, messages, temperature, max_tokens }) => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;

  const body = { messages };
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();

  if (!resp.ok || json.success === false) {
    const msg =
      json?.errors?.[0]?.message || `Workers AI request failed (${resp.status})`;
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }

  const usage = json.result?.usage || {};

  // Cloudflare's OpenAI-compatible endpoint always puts the raw text in
  // choices[0].message.content. Its top-level `result.response` mirrors that,
  // but gets silently auto-parsed into a JS *object* whenever the content
  // looks like JSON (as ours always does) — using it directly here would
  // hand downstream code an object where a JSON string is expected. Prefer
  // the guaranteed-string field, only falling back to `response` if a model
  // build ever omits `choices`.
  const rawMessage = json.result?.choices?.[0]?.message?.content;
  const content =
    typeof rawMessage === "string" && rawMessage.length > 0
      ? rawMessage
      : typeof json.result?.response === "string"
        ? json.result.response
        : JSON.stringify(json.result?.response ?? "");

  return {
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      // The actual billing/quota unit for the free tier — capture it so
      // callers can self-track spend against the account's shared daily
      // budget instead of guessing from token counts.
      neurons: usage.neurons || 0,
    },
  };
};

// Strip ```json ... ``` / ``` ... ``` fences some models wrap JSON in, and
// drop any leading/trailing prose the model added around the object itself
// (unlike OpenAI's json_object mode, Workers AI has no forced-JSON option).
const stripCodeFences = (text) => {
  let cleaned = (text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
};

/**
 * Best-effort repair for JSON truncated mid-generation (e.g. the model got
 * cut off before closing every brace). Walks the string tracking open
 * strings/objects/arrays, closes an unterminated string, drops a trailing
 * dangling comma, then closes every still-open `{`/`[` in the correct
 * order. This can't fix genuinely malformed JSON (missing commas,
 * unescaped control characters mid-structure), only recover the tail end
 * of an otherwise well-formed object that stopped short.
 */
const attemptJsonRepair = (text) => {
  const stack = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" && stack[stack.length - 1] === "{") {
      stack.pop();
    } else if (ch === "]" && stack[stack.length - 1] === "[") {
      stack.pop();
    }
  }

  let repaired = text;
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  return repaired;
};

// Max characters of resume text to send to AI (prevent token limit issues)
const MAX_RESUME_TEXT_CHARS = 8000;
// Max characters of job description to include
const MAX_JD_CHARS = 3000;
// Below this many characters, a PDF's embedded text layer is considered
// absent/unusable (e.g. an image-only or scanned PDF).
const MIN_USABLE_TEXT_LENGTH = 50;

// ── Text extraction helpers ────────────────────────────────────────────────

/**
 * Extract plain text from a PDF buffer.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
const extractTextFromPDF = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
};

/**
 * Extract plain text from a DOCX buffer.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
const extractTextFromDOCX = async (buffer) => {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || "";
};

/**
 * Extract text from file buffer based on MIME type or file extension.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} fileName
 * @returns {Promise<string>}
 */
const extractResumeText = async (buffer, mimeType, fileName) => {
  const ext = (fileName || "").split(".").pop().toLowerCase();

  if (mimeType === "application/pdf" || ext === "pdf") {
    return extractTextFromPDF(buffer);
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return extractTextFromDOCX(buffer);
  }

  if (mimeType === "application/msword" || ext === "doc") {
    // Legacy .doc format — try mammoth (partial support)
    try {
      return await extractTextFromDOCX(buffer);
    } catch {
      throw new Error("Legacy .doc files are not fully supported. Please convert to .docx or .pdf.");
    }
  }

  throw new Error(`Unsupported file type: ${mimeType || ext}. Please upload PDF or DOCX.`);
};

// ── ATS Analysis Prompt ────────────────────────────────────────────────────

/**
 * Build the GPT system prompt for ATS analysis.
 * Instructs the model to return a strict JSON response.
 */
const buildSystemPrompt = () => `
You are an expert ATS (Applicant Tracking System) resume analyzer with deep knowledge of:
- How enterprise ATS platforms (Taleo, Workday, Greenhouse, Lever, iCIMS) parse and score resumes
- Industry-standard keyword optimization strategies
- Resume formatting best practices for machine readability
- HR and recruiter expectations for modern resumes

Your task is to analyze the provided resume and return a comprehensive, actionable analysis as a strict JSON object.

SCORING CRITERIA (each out of 100):
1. keywords (25%): Technical skills, industry terms, software, certifications matching current job market
2. formatting (20%): Clean structure, consistent formatting, ATS-parseable layout, no tables/columns/images
3. sections (20%): Presence and completeness of: Contact Info, Summary/Objective, Work Experience, Education, Skills
4. readability (15%): Clarity, appropriate length, professional language, no typos or grammar issues
5. actionVerbs (10%): Strong action verbs at start of bullet points (Led, Developed, Increased, etc.)
6. quantification (10%): Numbers, percentages, metrics, and measurable achievements

SCORING GUIDELINES:
- 90-100: Exceptional, minimal changes needed
- 75-89: Good, minor improvements will help
- 60-74: Average, several improvements needed
- 45-59: Below average, significant improvements required
- Below 45: Critical issues, major restructuring needed

SUGGESTION PRIORITIES:
- high: Missing critical sections, no keywords, poor formatting — directly causing ATS rejection
- medium: Weak language, partial keywords, inconsistent formatting — reducing match score
- low: Minor improvements, style enhancements — would improve quality but not critical

Return ONLY a valid JSON object matching this exact schema (no markdown, no extra text):
{
  "overallScore": <integer 0-100>,
  "grade": "<A+|A|B|C|D|F>",
  "categoryScores": {
    "keywords": { "score": <integer>, "maxScore": 100, "label": "Keywords & Skills", "description": "<1 sentence finding>" },
    "formatting": { "score": <integer>, "maxScore": 100, "label": "Formatting & Structure", "description": "<1 sentence finding>" },
    "sections": { "score": <integer>, "maxScore": 100, "label": "Required Sections", "description": "<1 sentence finding>" },
    "readability": { "score": <integer>, "maxScore": 100, "label": "Readability", "description": "<1 sentence finding>" },
    "actionVerbs": { "score": <integer>, "maxScore": 100, "label": "Action Verbs", "description": "<1 sentence finding>" },
    "quantification": { "score": <integer>, "maxScore": 100, "label": "Quantified Achievements", "description": "<1 sentence finding>" }
  },
  "suggestions": [
    {
      "id": "sug_001",
      "category": "<keywords|formatting|sections|readability|actionVerbs|quantification|contact|summary|experience|education|skills>",
      "priority": "<high|medium|low>",
      "title": "<concise suggestion title, max 60 chars>",
      "original": "<exact text from resume, or empty string if adding new content>",
      "suggested": "<improved version of the text>",
      "reason": "<specific explanation of why ATS systems care about this change and the impact>",
      "impactPoints": <integer 1-15, estimated score improvement from this change>,
      "section": "<Resume section this applies to>"
    }
  ],
  "strengths": ["<strength 1>", "<strength 2>"],
  "criticalIssues": ["<critical issue 1>", "<critical issue 2>"]
}

IMPORTANT RULES:
- Generate 5-15 suggestions (more for lower-scoring resumes)
- Sort suggestions by priority (high first) then by impact (highest first)
- The "original" field must contain exact text from the resume (for diff display)
- The "suggested" field must be clearly better and ATS-optimized
- Be specific and actionable — avoid vague advice like "improve your skills section"
- Focus on changes that will meaningfully improve ATS parsing and keyword matching
- Do not include any field other than the ones in the schema above — in
  particular, do not generate a full rewritten resume
`;

/**
 * Build the user message for the ATS analysis request.
 */
const buildUserMessage = (resumeText, jobDescription) => {
  let message = `Please analyze this resume:\n\n<RESUME>\n${resumeText.slice(0, MAX_RESUME_TEXT_CHARS)}\n</RESUME>`;

  if (jobDescription && jobDescription.trim()) {
    message += `\n\n<JOB_DESCRIPTION>\n${jobDescription.slice(0, MAX_JD_CHARS)}\n</JOB_DESCRIPTION>\n\nFocus keyword analysis on the job description requirements. Identify gaps between the resume's current keywords and the job requirements.`;
  } else {
    message += `\n\nNo specific job description provided. Analyze against general industry ATS best practices and common in-demand keywords for the apparent role.`;
  }

  return message;
};

/**
 * Compute overall score as weighted average of category scores.
 * Weights: keywords 25%, formatting 20%, sections 20%, readability 15%, actionVerbs 10%, quantification 10%
 */
const computeOverallScore = (categoryScores) => {
  const weights = {
    keywords: 0.25,
    formatting: 0.20,
    sections: 0.20,
    readability: 0.15,
    actionVerbs: 0.10,
    quantification: 0.10,
  };
  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (categoryScores[key]?.score !== undefined) {
      weighted += categoryScores[key].score * weight;
      totalWeight += weight;
    }
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight) : 0;
};

/**
 * Derive letter grade from numeric score.
 */
const getGrade = (score) => {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
};

// Must match the SuggestionSchema enums in models/ATSAnalysis.js — a
// suggestion outside these (whether from JSON-repair truncating it mid-way,
// or the model just not following the schema) would otherwise fail
// Mongoose validation when the analysis is saved.
const VALID_SUGGESTION_CATEGORIES = new Set([
  "keywords", "formatting", "sections", "readability",
  "actionVerbs", "quantification", "contact", "summary",
  "experience", "education", "skills",
]);
const VALID_SUGGESTION_PRIORITIES = new Set(["high", "medium", "low"]);

/**
 * Assign unique IDs to suggestions if missing, and drop any that don't
 * satisfy the required schema fields (e.g. the last entry in a
 * JSON-repaired, truncated response).
 */
const normalizeSuggestions = (suggestions) => {
  if (!Array.isArray(suggestions)) return [];
  return suggestions
    .filter(
      (s) =>
        s &&
        typeof s.title === "string" && s.title.trim() &&
        VALID_SUGGESTION_CATEGORIES.has(s.category) &&
        VALID_SUGGESTION_PRIORITIES.has(s.priority)
    )
    .map((s, i) => ({
      ...s,
      id: s.id || `sug_${String(i + 1).padStart(3, "0")}`,
    }));
};

// ── Main Analysis Function ─────────────────────────────────────────────────

/**
 * Run full ATS analysis on a resume using Cloudflare Workers AI.
 *
 * @param {Buffer} fileBuffer - Resume file buffer
 * @param {string} mimeType - MIME type of the file
 * @param {string} fileName - Original file name
 * @param {string} jobDescription - Optional job description for targeted analysis
 * @returns {Promise<{analysis: object, extractedText: string, tokensUsed: number, processingTimeMs: number, model: string}>}
 */
const analyzeResume = async (fileBuffer, mimeType, fileName, jobDescription = "") => {
  const startTime = Date.now();

  // Step 1: Extract text from file
  const extractedText = await extractResumeText(fileBuffer, mimeType, fileName);
  const hasUsableText = !!extractedText && extractedText.trim().length >= MIN_USABLE_TEXT_LENGTH;

  if (!hasUsableText) {
    console.error(
      "[ATSAIService] Insufficient text extracted.",
      {
        fileName,
        mimeType,
        bufferSize: fileBuffer?.length,
        extractedLength: extractedText?.trim().length || 0,
        extractedPreview: extractedText?.slice(0, 200) || "",
      }
    );
    throw new Error(
      "Could not extract sufficient text from the resume. " +
      "Please ensure the file is not a scanned image and contains selectable text."
    );
  }

  const userContent = buildUserMessage(extractedText, jobDescription);

  // Step 2: Call Cloudflare Workers AI for analysis
  let response;
  let usedModel = PRIMARY_MODEL;

  // Quota exhaustion is account-wide (shared across every model and every AI
  // feature in the app), so retrying on a different model won't help and
  // just burns another chunk of the same exhausted budget — fail fast
  // instead. Only escalate to the (expensive) fallback model on a genuine,
  // non-quota failure of the primary model.
  const isQuotaError = (err) =>
    err?.status === 429 || /quota|rate.?limit/i.test(err?.message || "");

  try {
    try {
      response = await runWorkersAI({
        model: PRIMARY_MODEL,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userContent },
        ],
        temperature: 0.3, // Lower temperature for more consistent, structured output
        max_tokens: 4096, // Schema + suggestions + full updated resume needs the full budget
      });
    } catch (primaryError) {
      if (!isQuotaError(primaryError) && FALLBACK_MODEL !== PRIMARY_MODEL) {
        console.warn(`[ATSAIService] Primary model ${PRIMARY_MODEL} failed (${primaryError.message}), falling back to ${FALLBACK_MODEL}`);
        usedModel = FALLBACK_MODEL;
        response = await runWorkersAI({
          model: FALLBACK_MODEL,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: userContent },
          ],
          temperature: 0.3,
          max_tokens: 4096,
        });
      } else {
        throw primaryError;
      }
    }
  } catch (err) {
    if (isQuotaError(err)) {
      console.error("[ATSAIService] Workers AI quota exhausted:", err.message);
      throw new Error(
        "Our AI resume analyzer has reached its usage limit for now. Please try again later."
      );
    }
    throw err;
  }

  // Step 3: Parse and validate the JSON response
  const rawContent = stripCodeFences(response.choices[0]?.message?.content);
  if (!rawContent) {
    throw new Error("AI returned an empty response. Please try again.");
  }

  let parsedAnalysis;
  try {
    parsedAnalysis = JSON.parse(rawContent);
  } catch (parseError) {
    // Likely truncated mid-generation (e.g. hit max_tokens on a long
    // resume/JD) rather than genuinely malformed — try to recover it
    // before giving up.
    try {
      parsedAnalysis = JSON.parse(attemptJsonRepair(rawContent));
      console.warn("[ATSAIService] AI response required JSON repair (likely truncated).");
    } catch (repairError) {
      console.error(
        "[ATSAIService] Failed to parse AI response.",
        {
          length: rawContent.length,
          head: rawContent.slice(0, 200),
          tail: rawContent.slice(-200),
        }
      );
      throw new Error("AI returned an invalid response format. Please try again.");
    }
  }

  // Step 4: Normalize and validate response structure
  const categoryScores = parsedAnalysis.categoryScores || {};
  const computedScore = computeOverallScore(categoryScores);

  // Use AI's score but validate it's within computed range (allow ±10 variance)
  const aiScore = parsedAnalysis.overallScore;
  const overallScore =
    typeof aiScore === "number" && Math.abs(aiScore - computedScore) <= 15
      ? aiScore
      : computedScore;

  const analysis = {
    overallScore: Math.max(0, Math.min(100, overallScore)),
    grade: getGrade(overallScore),
    categoryScores,
    suggestions: normalizeSuggestions(parsedAnalysis.suggestions),
    strengths: Array.isArray(parsedAnalysis.strengths) ? parsedAnalysis.strengths.slice(0, 8) : [],
    criticalIssues: Array.isArray(parsedAnalysis.criticalIssues)
      ? parsedAnalysis.criticalIssues.slice(0, 6)
      : [],
  };

  const processingTimeMs = Date.now() - startTime;

  return {
    analysis,
    extractedText,
    tokensUsed: response.usage?.total_tokens || 0,
    neuronsUsed: response.usage?.neurons || 0,
    processingTimeMs,
    model: usedModel,
  };
};

// ── Updated Resume Generation ─────────────────────────────────────────────

/**
 * Generate updated resume content with only the "kept" suggestions applied.
 * Re-calls the AI to apply selective changes rather than using the bulk updatedResumeContent.
 *
 * @param {string} originalResumeText - Extracted text of original resume
 * @param {Array} suggestions - All suggestions from original analysis
 * @param {Object} decisions - { suggestionId: "keep" | "abort" }
 * @returns {Promise<string>} Updated resume content as plain text
 */
const generateUpdatedResume = async (originalResumeText, suggestions, decisions) => {
  const keptSuggestions = suggestions.filter(
    (s) => decisions[s.id] === "keep"
  );

  if (keptSuggestions.length === 0) {
    return originalResumeText; // No changes needed
  }

  const changesDescription = keptSuggestions
    .map(
      (s, i) =>
        `${i + 1}. [${s.section || s.category}] ${s.title}:\n` +
        (s.original ? `   Original: "${s.original}"\n` : "") +
        `   Apply: "${s.suggested}"\n` +
        `   Reason: ${s.reason}`
    )
    .join("\n\n");

  const prompt = `You are a professional resume editor. Apply the following specific changes to the resume below.

IMPORTANT: Only apply the listed changes. Keep all other content exactly as-is. Return the complete updated resume text.

CHANGES TO APPLY:
${changesDescription}

ORIGINAL RESUME:
${originalResumeText.slice(0, MAX_RESUME_TEXT_CHARS)}

Return only the complete updated resume text, properly formatted.`;

  const response = await runWorkersAI({
    model: PRIMARY_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 3000,
  });

  return response.choices[0]?.message?.content || originalResumeText;
};

module.exports = {
  analyzeResume,
  generateUpdatedResume,
  extractResumeText,
};
