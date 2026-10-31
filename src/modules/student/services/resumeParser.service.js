'use strict';

const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const OpenAI = require('openai');

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_MODEL_DEFAULT = process.env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
const CF_MODEL_LARGE = process.env.CLOUDFLARE_AI_MODEL_LARGE || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const MAX_RESUME_TEXT_CHARS = 10000;
const MIN_USABLE_TEXT_LENGTH = 40;

/**
 * Extract plain text from PDF buffer
 */
const extractTextFromPDF = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy();
  }
};

/**
 * Extract plain text from DOCX buffer
 */
const extractTextFromDOCX = async (buffer) => {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
};

/**
 * Extract resume text by file type
 */
const extractResumeText = async (buffer, mimeType, fileName) => {
  const ext = (fileName || '').split('.').pop().toLowerCase();

  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return extractTextFromPDF(buffer);
  }

  if (mimeType === 'text/plain' || ext === 'txt') {
    return buffer.toString('utf-8');
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return extractTextFromDOCX(buffer);
  }

  if (mimeType === 'application/msword' || ext === 'doc') {
    try {
      return await extractTextFromDOCX(buffer);
    } catch {
      throw new Error('Legacy .doc format is not fully supported. Please upload a PDF or .docx file.');
    }
  }

  throw new Error(`Unsupported file type: ${mimeType || ext}. Please upload a PDF or DOCX resume.`);
};

/**
 * Remove markdown code fences and whitespace
 */
const stripCodeFences = (text) => {
  let cleaned = (text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
};

/**
 * JSON repair fallback for truncated or loosely terminated objects
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
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' && stack.length > 0 && stack[stack.length - 1] === '{') {
      stack.pop();
    } else if (ch === ']' && stack.length > 0 && stack[stack.length - 1] === '[') {
      stack.pop();
    }
  }

  let repaired = text.trim();
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');

  while (stack.length > 0) {
    const open = stack.pop();
    repaired += open === '{' ? '}' : ']';
  }

  return repaired;
};

/**
 * Execute Cloudflare Workers AI call
 */
const runWorkersAI = async ({ model, messages, temperature = 0.1, max_tokens = 3000 }) => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages, temperature, max_tokens }),
  });

  const json = await resp.json();
  if (!resp.ok || json.success === false) {
    const msg = json?.errors?.[0]?.message || `Workers AI request failed (${resp.status})`;
    throw new Error(msg);
  }

  const raw = json.result?.choices?.[0]?.message?.content;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof json.result?.response === 'string') return json.result.response;
  return JSON.stringify(json.result?.response || '');
};

/**
 * Fallback to OpenAI if available
 */
const runOpenAIFallback = async ({ messages }) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured for fallback.');
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.1,
    max_tokens: 3000,
    response_format: { type: 'json_object' },
  });
  return resp.choices[0]?.message?.content || '{}';
};

const RESUME_PARSER_SYSTEM_PROMPT = `You are an expert resume parsing engine.
Your task is to analyze the raw text of a candidate's resume and extract structured information into an exact, valid JSON schema.

RULES:
1. Output ONLY a valid JSON object. No explanation, no markdown backticks, no extra text.
2. If any field or section is not mentioned in the resume, leave it as an empty string, empty array, or default structure.
3. Clean and normalize all names, dates, phone numbers, and URLs.
4. Format dates as "YYYY-MM" or "YYYY" if known, or "Present" for current positions.
5. In descriptions, provide clean HTML string format (such as "<p>Description</p>" or "<ul><li>Bullet 1</li><li>Bullet 2</li></ul>") highlighting key impact and technologies.
6. Clearly distinguish between full-time/regular work experience ("work") and internships ("internship").
7. Skills should be clean, concise strings (e.g., "React", "Node.js", "Python", "SQL").

REQUIRED JSON SCHEMA:
{
  "basicDetails": {
    "firstName": "string",
    "lastName": "string",
    "middleName": "string",
    "email": "string",
    "phone": "string",
    "dob": "string (YYYY-MM-DD or empty)",
    "city": "string (city/state/location)",
    "professionalSummary": "string (compelling 2-4 sentence summary)"
  },
  "educationDetails": [
    {
      "type": "string (e.g. B.Tech, M.Tech, Degree, High School)",
      "school": "string (College/University/School name)",
      "board": "string (University or Board name)",
      "stream": "string (Branch/Major, e.g. Computer Science)",
      "startDate": "string (YYYY-MM or YYYY)",
      "endDate": "string (YYYY-MM or YYYY)",
      "yearofPass": "string (YYYY)",
      "gradingSystem": "string (CGPA or Percentage)",
      "grade": "string (e.g. 8.5 or 85%)",
      "city": "string",
      "description": "string"
    }
  ],
  "experienceDetails": [
    {
      "company": "string",
      "role": "string",
      "startDate": "string",
      "endDate": "string",
      "city": "string",
      "description": "string (HTML with <ul><li>...</li></ul>)",
      "type": "work"
    }
  ],
  "internships": [
    {
      "company": "string",
      "role": "string",
      "startDate": "string",
      "endDate": "string",
      "city": "string",
      "description": "string (HTML with <ul><li>...</li></ul>)",
      "type": "internship"
    }
  ],
  "projectDetails": [
    {
      "project": "string (Project Title)",
      "company": "string (Organization or Academic)",
      "startDate": "string",
      "endDate": "string",
      "city": "string",
      "description": "string (HTML description of project, tech stack, and achievements)"
    }
  ],
  "skills": ["string"],
  "languages": ["string"],
  "links": [
    {
      "title": "string (e.g. LinkedIn, GitHub, Portfolio)",
      "link": "string (full URL)"
    }
  ],
  "certificates": [
    {
      "name": "string (Certificate Name)",
      "organization": "string (Issuing Body)",
      "issueDate": "string",
      "credentialUrl": "string"
    }
  ],
  "accomplishments": [
    {
      "accomplishment": "string (Award or Honor title)",
      "company": "string (Organization/Event)",
      "description": "string"
    }
  ],
  "volunteerings": [
    {
      "organization": "string",
      "volunteering": "string (Role)",
      "start": "string",
      "end": "string",
      "city": "string",
      "description": "string"
    }
  ]
}`;

/**
 * Parse resume buffer and map to template schema
 */
const parseAndMapResume = async (buffer, mimeType, fileName) => {
  // 1. Text extraction
  const rawText = await extractResumeText(buffer, mimeType, fileName);
  const trimmed = (rawText || '').trim();

  if (trimmed.length < MIN_USABLE_TEXT_LENGTH) {
    throw new Error(
      'Could not extract readable text from this file. It may be an image-only scan or password-protected. Please upload a standard PDF or DOCX file with selectable text.'
    );
  }

  const truncatedText = trimmed.slice(0, MAX_RESUME_TEXT_CHARS);

  const messages = [
    { role: 'system', content: RESUME_PARSER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Extract and map this candidate's resume text into the required JSON schema:\n\n---\n${truncatedText}\n---`,
    },
  ];

  let rawOutput = '';
  // Try default Cloudflare AI
  try {
    rawOutput = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages,
      temperature: 0.1,
      max_tokens: 3500,
    });
  } catch (err) {
    console.warn('[resumeParser] Cloudflare default model failed, trying fallback...', err.message);
    try {
      rawOutput = await runWorkersAI({
        model: CF_MODEL_LARGE,
        messages,
        temperature: 0.1,
        max_tokens: 3500,
      });
    } catch (errLarge) {
      console.warn('[resumeParser] Cloudflare large model failed, trying OpenAI...', errLarge.message);
      rawOutput = await runOpenAIFallback({ messages });
    }
  }

  // Clean JSON
  const cleanedJsonStr = stripCodeFences(rawOutput);
  let parsedData = null;

  try {
    parsedData = JSON.parse(cleanedJsonStr);
  } catch (parseErr) {
    console.warn('[resumeParser] Initial JSON parse failed, attempting repair...');
    const repaired = attemptJsonRepair(cleanedJsonStr);
    parsedData = JSON.parse(repaired);
  }

  // Normalize structure and attach unique IDs for React keys
  const now = Date.now();

  const normalizeArrayWithId = (arr, prefix) => {
    if (!Array.isArray(arr)) return [];
    return arr.map((item, idx) => ({
      ...item,
      id: item.id || now + idx + (prefix ? 100 : 0),
    }));
  };

  const experienceDetails = normalizeArrayWithId(parsedData.experienceDetails || [], 'exp');
  const internships = normalizeArrayWithId(parsedData.internships || [], 'int');
  const projectDetails = normalizeArrayWithId(parsedData.projectDetails || [], 'proj');
  const certificates = normalizeArrayWithId(parsedData.certificates || [], 'cert');
  const accomplishments = normalizeArrayWithId(parsedData.accomplishments || [], 'acc');
  const volunteerings = normalizeArrayWithId(parsedData.volunteerings || [], 'vol');

  // Detect which optional sections should be open by default
  const visibleOptionalSections = [];
  if (certificates.length > 0) visibleOptionalSections.push('Certifications');
  if (volunteerings.length > 0) visibleOptionalSections.push('Volunteering');
  if (Array.isArray(parsedData.languages) && parsedData.languages.filter(Boolean).length > 0) {
    visibleOptionalSections.push('Languages');
  }

  return {
    basicDetails: {
      firstName: parsedData.basicDetails?.firstName || '',
      lastName: parsedData.basicDetails?.lastName || '',
      middleName: parsedData.basicDetails?.middleName || '',
      email: parsedData.basicDetails?.email || '',
      phone: parsedData.basicDetails?.phone || '',
      dob: parsedData.basicDetails?.dob || '',
      city: parsedData.basicDetails?.city || '',
      professionalSummary: parsedData.basicDetails?.professionalSummary || '',
      profile: '',
    },
    educationDetails: Array.isArray(parsedData.educationDetails) && parsedData.educationDetails.length > 0
      ? parsedData.educationDetails
      : [
          {
            type: '',
            board: '',
            school: '',
            hallticket: '',
            startDate: '',
            endDate: '',
            yearofPass: '',
            gradingSystem: '',
            grade: '',
            city: '',
            description: '',
            stream: '',
          },
        ],
    experienceDetails: experienceDetails.length > 0 ? experienceDetails : [
      {
        id: now,
        company: '',
        role: '',
        startDate: '',
        endDate: '',
        city: '',
        description: '',
        type: 'work',
      },
    ],
    internships: internships.length > 0 ? internships : [
      {
        id: now + 50,
        company: '',
        role: '',
        startDate: '',
        endDate: '',
        city: '',
        description: '',
        type: 'internship',
      },
    ],
    projectDetails: projectDetails.length > 0 ? projectDetails : [
      {
        id: now + 100,
        company: '',
        project: '',
        startDate: '',
        endDate: '',
        city: '',
        description: '',
      },
    ],
    skills: Array.isArray(parsedData.skills) && parsedData.skills.length > 0 ? parsedData.skills : [''],
    languages: Array.isArray(parsedData.languages) && parsedData.languages.length > 0 ? parsedData.languages : [''],
    links: Array.isArray(parsedData.links) && parsedData.links.length > 0 ? parsedData.links : [{ title: '', link: '' }],
    certificates: certificates.length > 0 ? certificates : [
      {
        id: now + 150,
        name: '',
        organization: '',
        issueDate: '',
        expiryDate: '',
        credentialId: '',
        credentialUrl: '',
      },
    ],
    accomplishments: accomplishments.length > 0 ? accomplishments : [
      {
        id: now + 200,
        company: '',
        accomplishment: '',
        startDate: '',
        endDate: '',
        city: '',
        description: '',
      },
    ],
    volunteerings: volunteerings.length > 0 ? volunteerings : [
      {
        id: now + 250,
        organization: '',
        volunteering: '',
        start: '',
        end: '',
        city: '',
        description: '',
      },
    ],
    visibleOptionalSections,
  };
};

module.exports = {
  extractResumeText,
  parseAndMapResume,
};
