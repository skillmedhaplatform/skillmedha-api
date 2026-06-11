/**
 * atsAIService.js
 * Core ATS analysis service using OpenAI GPT-4o.
 * Handles resume text extraction (PDF/DOCX), AI analysis, and updated resume generation.
 *
 * Required npm packages:
 *   npm install openai pdf-parse mammoth uuid
 *
 * Required environment variables:
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4o            (recommended — best quality for structured JSON)
 *   OPENAI_FALLBACK_MODEL=gpt-4o-mini  (fallback if primary hits rate limit)
 *
 * Place this file in your Node.js/Express API repo under: services/atsAIService.js
 */

const OpenAI = require("openai");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { v4: uuidv4 } = require("uuid");

// CONFIGURE: Set OPENAI_API_KEY in your .env file
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// CONFIGURE: Set preferred model. gpt-4o gives best structured JSON quality.
const PRIMARY_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || "gpt-4o-mini";

// Max characters of resume text to send to AI (prevent token limit issues)
const MAX_RESUME_TEXT_CHARS = 8000;
// Max characters of job description to include
const MAX_JD_CHARS = 3000;

// ── Text extraction helpers ────────────────────────────────────────────────

/**
 * Extract plain text from a PDF buffer.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
const extractTextFromPDF = async (buffer) => {
  const data = await pdfParse(buffer);
  return data.text || "";
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
  "criticalIssues": ["<critical issue 1>", "<critical issue 2>"],
  "updatedResumeContent": "<full improved resume text with ALL suggestions applied>"
}

IMPORTANT RULES:
- Generate 5-15 suggestions (more for lower-scoring resumes)
- Sort suggestions by priority (high first) then by impact (highest first)
- The "original" field must contain exact text from the resume (for diff display)
- The "suggested" field must be clearly better and ATS-optimized
- "updatedResumeContent" must be a complete, formatted resume with all suggestions integrated
- Be specific and actionable — avoid vague advice like "improve your skills section"
- Focus on changes that will meaningfully improve ATS parsing and keyword matching
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

/**
 * Assign unique IDs to suggestions if missing.
 */
const normalizeSuggestions = (suggestions) => {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.map((s, i) => ({
    ...s,
    id: s.id || `sug_${String(i + 1).padStart(3, "0")}`,
  }));
};

// ── Main Analysis Function ─────────────────────────────────────────────────

/**
 * Run full ATS analysis on a resume using GPT-4o.
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

  if (!extractedText || extractedText.trim().length < 50) {
    throw new Error(
      "Could not extract sufficient text from the resume. " +
      "Please ensure the file is not a scanned image and contains selectable text."
    );
  }

  // Step 2: Call OpenAI GPT-4o for analysis
  let response;
  let usedModel = PRIMARY_MODEL;

  try {
    response = await openai.chat.completions.create({
      model: PRIMARY_MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserMessage(extractedText, jobDescription) },
      ],
      temperature: 0.3,         // Lower temperature for more consistent, structured output
      max_tokens: 4096,
      response_format: { type: "json_object" }, // Force JSON output (GPT-4o supports this)
    });
  } catch (primaryError) {
    // Fallback to cheaper model if primary fails (rate limit, quota, etc.)
    if (primaryError.status === 429 || primaryError.code === "insufficient_quota") {
      console.warn(`[ATSAIService] Primary model ${PRIMARY_MODEL} failed, falling back to ${FALLBACK_MODEL}`);
      usedModel = FALLBACK_MODEL;
      response = await openai.chat.completions.create({
        model: FALLBACK_MODEL,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserMessage(extractedText, jobDescription) },
        ],
        temperature: 0.3,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      });
    } else {
      throw primaryError;
    }
  }

  // Step 3: Parse and validate the JSON response
  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error("AI returned an empty response. Please try again.");
  }

  let parsedAnalysis;
  try {
    parsedAnalysis = JSON.parse(rawContent);
  } catch (parseError) {
    console.error("[ATSAIService] Failed to parse AI response:", rawContent.slice(0, 200));
    throw new Error("AI returned an invalid response format. Please try again.");
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
    updatedResumeContent: parsedAnalysis.updatedResumeContent || "",
  };

  const processingTimeMs = Date.now() - startTime;

  return {
    analysis,
    extractedText,
    tokensUsed: response.usage?.total_tokens || 0,
    processingTimeMs,
    model: usedModel,
  };
};

// ── Updated Resume Generation ─────────────────────────────────────────────

/**
 * Generate updated resume content with only the "kept" suggestions applied.
 * Re-calls GPT to apply selective changes rather than using the bulk updatedResumeContent.
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

  const response = await openai.chat.completions.create({
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
