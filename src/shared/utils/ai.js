/**********************************
 *  AI ROUTER
 *  Mounted at /ai in main app.js
 **********************************/

const express = require("express");
const router = express.Router();
const mongoDB = require("mongodb");

const { mandatory: authenticate } = require("../middleware/auth.middleware");
const { selectTenantDB } = require("../middleware/selectTenantDB.middleware");
const { connectTodb, getTenantDB } = require("../db/connection");
const {
  aiUsageCollection,
  organisation,
} = require("../db/connection").getGlobalCollections();

/*****************************************
 *  CLOUDFLARE WORKERS AI CLIENT
 *****************************************/

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_MODEL_DEFAULT =
  process.env.CLOUDFLARE_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
const CF_MODEL_LARGE =
  process.env.CLOUDFLARE_AI_MODEL_LARGE ||
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Mirrors the OpenAI chat-completion response shape (choices[0].message.content,
// usage.{prompt,completion,total}_tokens) so the route handlers below don't change.
//
// max_tokens defaults to Workers AI's own default (256) when omitted, which
// silently truncates any route asking for a longer or JSON-structured
// response (e.g. checkEnglishText's 6-field HTML report) — default it to a
// safer ceiling here so every call site is covered without having to touch
// each one individually. This only raises the ceiling; actual cost is
// still driven by what the model actually generates, not this cap.
const runWorkersAI = async ({
  model = CF_MODEL_DEFAULT,
  messages,
  temperature,
  max_tokens = 1500,
}) => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`;

  const body = { messages, max_tokens };
  if (temperature !== undefined) body.temperature = temperature;

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
    throw new Error(msg);
  }

  const usage = json.result?.usage || {};

  // Cloudflare's OpenAI-compatible endpoint always puts the raw text in
  // choices[0].message.content. Its top-level `result.response` mirrors
  // that, but gets silently auto-parsed into a JS *object* whenever the
  // content looks like JSON — routes here that ask for a JSON response
  // (checkEnglishText, checkAts, etc.) would otherwise hand parseIfJson an
  // object instead of a string. Prefer the guaranteed-string field.
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
      neurons: usage.neurons || 0,
    },
  };
};

/*****************************************
 *  HELPERS
 *****************************************/

// Strip ```json ... ``` / ``` ... ``` fences some models wrap JSON in.
// Safe to run on non-JSON (HTML/plain text) responses too since it only
// touches leading/trailing code-fence markers, never the body.
const stripCodeFences = (text) =>
  (text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

// Some models prefix the JSON with a sentence of prose ("Here's a
// structured JSON response:") before the fence, which stripCodeFences
// alone won't remove. Only extracted here, not in stripCodeFences itself,
// since routes that expect plain HTML/text (not JSON) also share that
// helper and must not have their content sliced on stray braces.
const extractJsonObject = (text) => {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  if (firstBrace === -1 && firstBracket === -1) return text;

  // Whichever bracket type appears first is the outer wrapper (matters for
  // routes like testCases whose schema is a top-level array of objects —
  // always preferring "{" would slice off the array brackets and leave
  // multiple top-level objects with no wrapper, which isn't valid JSON).
  const useArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);
  const start = useArray ? firstBracket : firstBrace;
  const end = text.lastIndexOf(useArray ? "]" : "}");

  return end > start ? text.slice(start, end + 1) : text;
};

// Models frequently emit multi-line HTML inside a JSON string value with
// real newlines/tabs instead of escaping them as \n/\t — valid-looking
// output that is technically invalid JSON (raw control characters aren't
// allowed inside a JSON string). Walk the text tracking whether we're
// inside a string (respecting \" escapes) and escape any control
// character found there; everything outside strings (formatting
// whitespace between tokens) is left untouched.
const escapeControlCharsInStrings = (text) => {
  let result = "";
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && ch.charCodeAt(0) < 0x20) {
      if (ch === "\n") result += "\\n";
      else if (ch === "\r") result += "\\r";
      else if (ch === "\t") result += "\\t";
      else result += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
      continue;
    }
    result += ch;
  }
  return result;
};

const parseIfJson = (txt) => {
  const cleaned = stripCodeFences(txt);
  const attempts = [
    cleaned,
    extractJsonObject(cleaned),
    escapeControlCharsInStrings(extractJsonObject(cleaned)),
  ];
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next recovery strategy
    }
  }
  return txt;
};

/************ AI USAGE HELPERS ************/

const trackAIUsage = async (type, userId, orgId, userType, extra = {}) => {
  try {
    const doc = {
      type,
      userId,
      orgId,
      userType,
      createdAt: new Date(),
      status: "processing",
      ...extra,
    };
    const r = await aiUsageCollection.insertOne(doc);
    return r.insertedId;
  } catch (e) {
    console.error("AI track err:", e);
    return null;
  }
};

const updateAIUsageOnComplete = async (
  usageId,
  promptTokens,
  completionTokens,
  totalTokens,
  neurons = 0,
  status = "success"
) => {
  try {
    await aiUsageCollection.updateOne(
      { _id: usageId },
      {
        $set: {
          completed: true,
          completedAt: new Date(),
          promptTokens,
          completionTokens,
          totalTokens,
          // The actual free-tier billing/quota unit (Cloudflare "neurons"),
          // distinct from token counts — needed to guard the account's real
          // shared daily budget rather than just this org's token quota.
          neurons,
          status,
        },
      }
    );
  } catch (e) {
    console.error("AI complete upd err:", e);
  }
};

const updateAIUsageOnFailure = async (usageId, err, status = "failed") => {
  try {
    await aiUsageCollection.updateOne(
      { _id: usageId },
      {
        $set: {
          completed: false,
          failedAt: new Date(),
          status,
          error: err.message,
        },
      }
    );
  } catch (e) {
    console.error("AI fail upd err:", e);
  }
};

/*****************************************
 *  QUOTA LIMITER MIDDLEWARE
 *****************************************/

// Cloudflare's daily neuron budget resets at 00:00 UTC — align "today" to
// that, not server-local midnight (would otherwise drift by whatever the
// server's timezone offset is and let a burst slip across the boundary).
const getStartOfTodayUTC = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

async function quotaLimiter(req, res, next) {
  try {
    const { orgId } = req;

    // KSquare has infinite quota
    if (orgId === "KSquare") {
      return next();
    }

    // Derive ObjectId
    const parts = orgId.split("_");
    if (parts.length < 2) {
      return res.status(400).json({ error: "Invalid orgId format" });
    }

    const orgObjectId = new mongoDB.ObjectId(parts[1]);

    // Load org document
    const orgDoc = await organisation.findOne({ _id: orgObjectId });

    // Suspended?
    if (orgDoc?.suspended) {
      return res.status(403).json({
        error: "Organisation suspended due to billing/compliance",
      });
    }

    // Extract daily quota (fallback to 50k tokens)
    const dailyLimit = orgDoc?.aiTokenLimit || 50000;

    // Aggregate token usage for today
    const usageAgg = await aiUsageCollection
      .aggregate([
        {
          $match: {
            orgId,
            createdAt: { $gte: getStartOfTodayUTC() },
          },
        },
        {
          $group: {
            _id: null,
            used: { $sum: "$totalTokens" },
          },
        },
      ])
      .toArray();

    const tokensUsed = usageAgg.length ? usageAgg[0].used : 0;

    // If exceeded
    if (tokensUsed >= dailyLimit) {
      return res.status(402).json({
        error: "Daily AI token quota exceeded.",
        tokensUsed,
        dailyLimit,
      });
    }

    // Attach usage info to req
    req.orgQuota = {
      tokensUsed,
      dailyLimit,
      remaining: dailyLimit - tokensUsed,
    };

    return next();
  } catch (err) {
    console.error("quotaLimiter error:", err);
    return res.status(500).json({
      error: "Quota check failed",
      detail: err.message,
    });
  }
}

/*****************************************
 *  ACCOUNT-WIDE NEURON GUARD
 *****************************************/
// quotaLimiter above only enforces a *per-org* token quota — it protects
// orgs from each other, but has no relationship to Cloudflare's real
// constraint: a single account-wide 10,000-neuron/day budget on the free
// plan, shared by every org and every AI feature (this router, plus the
// ATS resume analyzer in its own module). Many orgs could each stay under
// their own token quota while collectively exhausting that shared budget
// for everyone. This guard reserves a slice of it specifically for the
// routes in this file, tracked in the real unit (neurons, from
// ATSAnalysis.neuronsUsed).
//
// The ATS checker reserves its own separate slice independently
// (ATS_DAILY_NEURON_BUDGET, see atsController.js) — the two are sized to
// comfortably sum to under the account's real 10,000/day, each guarding
// its own usage without needing to query the other's data.
const AI_DAILY_NEURON_BUDGET = parseInt(process.env.AI_DAILY_NEURON_BUDGET || "5000", 10);

async function accountWideNeuronGuard(req, res, next) {
  try {
    const usageAgg = await aiUsageCollection
      .aggregate([
        { $match: { createdAt: { $gte: getStartOfTodayUTC() } } },
        { $group: { _id: null, used: { $sum: "$neurons" } } },
      ])
      .toArray();

    const neuronsUsed = usageAgg.length ? usageAgg[0].used : 0;

    if (neuronsUsed >= AI_DAILY_NEURON_BUDGET) {
      return res.status(429).json({
        error: "Our AI features have reached their usage limit for now. Please try again later.",
      });
    }

    return next();
  } catch (err) {
    console.error("accountWideNeuronGuard error:", err);
    // Fail open — a bug in this check shouldn't take down every AI
    // feature; quotaLimiter and Cloudflare's own quota enforcement still
    // apply as backstops.
    return next();
  }
}

// NOTE: the public, unauthenticated /chatWidget/consume rate-limit route lives
// in app.js (registered directly on `app`, before the module routers) — see
// the comment there for why it can't safely live inside this router.

// Apply usage guards to all AI routes registered below this point
router.use(accountWideNeuronGuard);
router.use(quotaLimiter);

/*****************************************
 *  ROUTES
 *****************************************/

router.post("/checkCode", authenticate, async (req, res) => {
  const { question, code, userType } = req.body;
  const { userID: userId, orgId } = req;

  if (!question || !code || !userType) {
    return res.status(400).json({ error: "Missing fields" });
  }

  let usageId;
  try {
    usageId = await trackAIUsage("checkCode", userId, orgId, userType, {
      len: code.length,
    });

    const prompt = `
    You are an expert software code reviewer...
    Question: ${question}
    Code: ${code}
    `;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;
    const output = completion.choices[0].message.content;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send(parseIfJson(output));
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.status(500).send({ err: e.message });
  }
});

router.post("/checkEnglishText", authenticate, async (req, res) => {
  const { text, question, userType } = req.body;
  const { userID: userId, orgId } = req;

  let usageId;
  try {
    usageId = await trackAIUsage("checkEnglishText", userId, orgId, userType);

    const prompt = `
      You are an expert English language editor and interview coach.
      
      Your task is to evaluate the following answer given by a student to an interview question.
      
      Question: "${question}"
      Answer: "${text}"
      
      Provide a strict JSON response with the following structure:
      {
        "grammarAndSpellingCheck": "HTML string highlighting grammar and spelling mistakes with corrections.",
        "clarityAndStyleSuggestions": "HTML string providing suggestions to improve clarity, tone, and professional style.",
        "positiveFeedback": "HTML string highlighting the strengths of the answer.",
        "reviewedText": "The corrected and polished version of the answer as a string.",
        "report": "A comprehensive HTML report summarizing the overall quality of the answer.",
        "relevance": "HTML string analyzing how relevant the answer is to the question asked."
      }

      Ensure all HTML strings are safe and formatted for direct rendering.
    `;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2500, // 6 separate HTML fields — more headroom than the shared default
    });

    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;
    const output = completion.choices[0].message.content;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send(parseIfJson(output));
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.json({ err: e.message });
  }
});

router.post("/getExplanationFOrQuestion", authenticate, async (req, res) => {
  const { question, answer, userType } = req.body;
  const { userID: userId, orgId } = req;

  let usageId;
  try {
    usageId = await trackAIUsage(
      "getExplanationForQuestion",
      userId,
      orgId,
      userType
    );

    const prompt = `
    Explain step-by-step why the answer is correct.
    Question: ${question}
    Answer: ${answer}
    `;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;
    const output = completion.choices[0].message.content;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send(parseIfJson(output));
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.send({ err: e.message });
  }
});

router.post("/repharseSummary", authenticate, async (req, res) => {
  const { summary, userType } = req.body;
  const { userID: userId, orgId } = req;

  let usageId;
  try {
    usageId = await trackAIUsage("repharseSummary", userId, orgId, userType);

    const prompt = `Rephrase this: ${summary}`;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;
    const output = completion.choices[0].message.content.trim();

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send(parseIfJson(output));
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.send({ err: e.message });
  }
});

router.post("/generateTestDescription", authenticate, async (req, res) => {
  const { title, userType } = req.body;
  const { userID: userId, orgId } = req;

  let usageId;
  try {
    usageId = await trackAIUsage(
      "generateTestDescription",
      userId,
      orgId,
      userType
    );

    const prompt = `Generate a neutral 3–5 sentence test description for: "${title}"`;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;
    const output = completion.choices[0].message.content.trim();

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send({ msg: output });
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.status(500).send({ err: e.message });
  }
});

router.post("/testCases", async (req, res) => {
  try {
    const { question, code } = req.body;

    const prompt = `
You are a code evaluator.

Your task is to evaluate the following Python code against a series of test cases.

Each test case includes:
- An input variable definition
- An expected output
- Your job is to check whether the user code, when executed after the input, produces the expected result (by printing to stdout).

Rules:
- Evaluate each test case separately.
- Only compare the final printed output (from print statements).
- Do not include explanations or comments.
- Just return a raw JSON array of results.

Strict output format (only this!):
[
  { "testCase1": "Pass" },
  { "testCase2": "Pass" }
]

Now evaluate this code:

User Code:
\`\`\`js
${code}
\`\`\`

Test Cases:
${JSON.stringify(question, null, 2)}
`;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });

    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw
      .replace(/^```json/, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    let finalResp;
    try {
      finalResp = JSON.parse(cleaned);
    } catch {
      finalResp = cleaned;
    }

    return res.send(finalResp);
  } catch (error) {
    return res.send({ err: error.message });
  }
});

router.post("/generateExp", authenticate, async (req, res) => {
  const { question, explanation, answer, userType } = req.body;
  const { userID: userId, orgId } = req;

  let usageId;
  try {
    usageId = await trackAIUsage("generateExp", userId, orgId, userType);

    const prompt = `
      You are an expert educator. Provide a detailed explanation for the following question, context, and answer.
      
      Structure your response using ONLY the following HTML tags:
      - <h3> for section headers (e.g., "Detailed Explanation", "Shortcut/Tip")
      - <p> for paragraphs
      - <ul> and <li> for lists
      - <strong> for emphasis
      - <code> for technical terms or code snippets 

      Question: ${question}
      Context: ${explanation}
      Answer: ${answer}

      Respond with raw HTML only. Do NOT include markdown code blocks (e.g., \`\`\`html).
    `;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that provides educational explanations in clean, structured HTML.",
        },
        { role: "user", content: prompt },
      ],
    });

    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;
    let output = completion.choices[0].message.content.trim();
    output = output.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send(output);
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.send({ err: e.message });
  }
});

router.post(
  "/generateQuestionsfromText",
  authenticate,
  async (req, res) => {
    const { noOfQuestion, questionType, textPara, userType } = req.body;
    const { userID: userId, orgId } = req;

    let usageId;
    try {
      usageId = await trackAIUsage(
        "generateQuestionsfromText",
        userId,
        orgId,
        userType
      );

      const prompt = `
Generate ${noOfQuestion} ${questionType} questions from text:
${textPara}
Strict JSON output.
`;

      const completion = await runWorkersAI({
        model: CF_MODEL_DEFAULT,
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content;
      const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        neurons
      );

      res.send({ data: parseIfJson(output) });
    } catch (e) {
      await updateAIUsageOnFailure(usageId, e);
      res.status(500).send("Error generating questions");
    }
  }
);

router.post("/checkIfCodeIsAiGenerated", authenticate, async (req, res) => {
  const { code, userType } = req.body;
  const { userID: userId, orgId } = req;

  let usageId;
  try {
    usageId = await trackAIUsage(
      "checkIfCodeIsAiGenerated",
      userId,
      orgId,
      userType
    );

    const prompt = `
Analyze if this code is AI-generated:
${code}
Return JSON with fields.
`;

    const completion = await runWorkersAI({
      model: CF_MODEL_LARGE,
      messages: [{ role: "user", content: prompt }],
    });

    const output = completion.choices[0].message.content;
    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = { raw: output, error: "parse failed" };
    }

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send(parsed);
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.status(500).json({ err: e.message });
  }
});

router.post(
  "/generateSummaryForPsychometricTest",
  authenticate,
  async (req, res) => {
    const { attemptedDataString, userType } = req.body;
    const { userID: userId, orgId } = req;

    let usageId;
    try {
      const attemptedData = JSON.parse(attemptedDataString);
      usageId = await trackAIUsage(
        "generateSummaryForPsychometricTest",
        userId,
        orgId,
        userType
      );

      const prompt = `
Psychometric analysis summary:
${JSON.stringify(attemptedData, null, 2)}
Return JSON { summary: "" }
`;

      const completion = await runWorkersAI({
        model: CF_MODEL_DEFAULT,
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content;
      const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        neurons
      );

      res.json(parseIfJson(output));
    } catch (e) {
      await updateAIUsageOnFailure(usageId, e);
      res.json({ err: e.message });
    }
  }
);

router.post("/generateNumericalQuestion", authenticate, async (req, res) => {
  const { question, answer, explanation, userType } = req.body;
  const { userID: userId, orgId } = req;

  let usageId;
  try {
    usageId = await trackAIUsage(
      "generateNumericalQuestion",
      userId,
      orgId,
      userType
    );

    const prompt = `
Provide step-by-step and shortcut for:
Q: ${question}
A: ${answer}
Explanation: ${explanation}
Return JSON only.
    `;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
    });

    const output = completion.choices[0].message.content;
    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.send(parseIfJson(output));
  } catch (e) {
    await updateAIUsageOnFailure(usageId, e);
    res.json({ err: e.message });
  }
});

router.post(
  "/generate-resume-summary",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { resumeData, userType } = req.body;
    const { userID: userId, orgId } = req;

    let usageId;
    try {
      usageId = await trackAIUsage(
        "generateResumeSummary",
        userId,
        orgId,
        userType
      );

      const prompt = `
Generate resume summary for:
${JSON.stringify(resumeData)}
`;

      const completion = await runWorkersAI({
        model: CF_MODEL_DEFAULT,
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content.trim();
      const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        neurons
      );

      res.json({ summary: output });
    } catch (e) {
      await updateAIUsageOnFailure(usageId, e);
      res.status(500).json({ err: e.message });
    }
  }
);

router.post(
  "/improveResumeWriting",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { text, userType } = req.body;
    const { userID: userId, orgId } = req;

    let usageId;
    try {
      usageId = await trackAIUsage(
        "improveResumeWriting",
        userId,
        orgId,
        userType
      );

      const prompt = `
Improve resume bullet:
${text}
      `;

      const completion = await runWorkersAI({
        model: CF_MODEL_DEFAULT,
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content.trim();
      const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        neurons
      );

      res.json({ improvedText: output });
    } catch (e) {
      await updateAIUsageOnFailure(usageId, e);
      res.json({ err: e.message });
    }
  }
);

router.post("/checkAts", authenticate, selectTenantDB, async (req, res) => {
  const { studentId, jobId, userType } = req.body;
  const { userID: userId, orgId } = req;
  let usageId;

  try {
    usageId = await trackAIUsage("checkAts", userId, orgId, userType, {
      studentId,
      jobId,
    });

    if (!req.tenantDB) {
      return res.status(500).json({ error: "No tenant DB available" });
    }

    const localDB = req.tenantDB;
    const { student, job, assignedJob, aiRespAts } = connectTodb(localDB);
    let findStudent = null;
    let findJob = null;
    let studentSourceOrg = null;
    let jobSourceOrg = null;
    let atsCollection = aiRespAts;

    const orgSet = new Set([orgId]);

    // Local student
    findStudent = await student.findOne({
      _id: new mongoDB.ObjectId(studentId),
    });
    if (findStudent) studentSourceOrg = orgId;

    // Local job
    findJob = await job.findOne({ _id: new mongoDB.ObjectId(jobId) });
    if (findJob) jobSourceOrg = orgId;

    if (!findStudent || !findJob) {
      const assigned = await assignedJob.find({}).toArray();
      assigned.forEach((a) => orgSet.add(a.companyOrgId));

      for (const extOrg of orgSet) {
        if (extOrg === orgId) continue;
        const extDB = await getTenantDB(extOrg);
        const { student: sCol, job: jCol } = connectTodb(extDB);

        if (!findStudent) {
          const s = await sCol.findOne({
            _id: new mongoDB.ObjectId(studentId),
          });
          if (s) {
            findStudent = s;
            studentSourceOrg = extOrg;
          }
        }

        if (!findJob) {
          const j = await jCol.findOne({ _id: new mongoDB.ObjectId(jobId) });
          if (j) {
            findJob = j;
            jobSourceOrg = extOrg;
          }
        }
      }
    }

    if (!findStudent || !findJob) {
      await updateAIUsageOnFailure(usageId, new Error("Student/job not found"));
      return res.status(404).json({
        error: "Student/Job missing",
        studentFound: !!findStudent,
        jobFound: !!findJob,
      });
    }

    if (jobSourceOrg !== orgId) {
      const jobDB = await getTenantDB(jobSourceOrg);
      const { aiRespAts: ats } = connectTodb(jobDB);
      atsCollection = ats;
    }

    const prompt = `
ATS evaluation...
Job:
${JSON.stringify(findJob, null, 2)}
Candidate:
${JSON.stringify(findStudent, null, 2)}

JSON response strict format.
    `;

    const completion = await runWorkersAI({
      model: CF_MODEL_DEFAULT,
      messages: [{ role: "user", content: prompt }],
    });

    const outputRaw = completion.choices[0].message.content;
    const { prompt_tokens, completion_tokens, total_tokens, neurons } = completion.usage;

    let parsed;
    try {
      parsed = JSON.parse(outputRaw);
    } catch {
      parsed = {
        eligible: false,
        matchScore: 0,
        missingCriteria: ["parseFailed"],
        rawOutput: outputRaw,
      };
    }

    const atsDoc = {
      studentId: new mongoDB.ObjectId(studentId),
      jobId: new mongoDB.ObjectId(jobId),
      atsResult: parsed,
      createdAt: new Date(),
      studentSourceOrg,
      jobSourceOrg,
    };
    const insert = await atsCollection.insertOne(atsDoc);

    const stuDB =
      studentSourceOrg === orgId
        ? localDB
        : await getTenantDB(studentSourceOrg);
    const { student: stuCol } = connectTodb(stuDB);
    await stuCol.updateOne(
      { _id: new mongoDB.ObjectId(studentId), "appliedJobs.id": jobId },
      { $set: { "appliedJobs.$.atsResponseId": insert.insertedId.toString() } }
    );

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      neurons
    );

    res.json({
      data: parsed,
      atsId: insert.insertedId,
      metadata: {
        studentFoundIn: studentSourceOrg,
        jobFoundIn: jobSourceOrg,
        atsStoredIn: jobSourceOrg,
      },
    });
  } catch (error) {
    await updateAIUsageOnFailure(usageId, error);
    res.status(500).json({ err: error.message });
  }
});

/*****************************************
 *  EXPORT
 *****************************************/

module.exports = router;