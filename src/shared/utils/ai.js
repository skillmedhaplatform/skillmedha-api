/**********************************
 *  AI ROUTER
 *  Mounted at /ai in main app.js
 **********************************/

const express = require("express");
const router = express.Router();
const OpenAI = require("openai");
const mongoDB = require("mongodb");

const { mandatory: authenticate } = require("../middleware/auth.middleware");
const { selectTenantDB } = require("../middleware/selectTenantDB.middleware");
const { connectTodb, getTenantDB } = require("../db/connection");
const {
  aiUsageCollection,
  organisation,
} = require("../db/connection").getGlobalCollections();

const openai = new OpenAI({
  organization: process.env.OPENAI_ORGID,
  project: process.env.OPENAI_PROJID,
});

/*****************************************
 *  HELPERS
 *****************************************/

const parseIfJson = (txt) => {
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
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

    // Today window
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    // Aggregate token usage for today
    const usageAgg = await aiUsageCollection
      .aggregate([
        {
          $match: {
            orgId,
            createdAt: { $gte: start },
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

// Apply quota limiter to all AI routes
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    const output = completion.choices[0].message.content;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    const output = completion.choices[0].message.content;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    const output = completion.choices[0].message.content;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    const output = completion.choices[0].message.content.trim();

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    const output = completion.choices[0].message.content.trim();

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that provides educational explanations in clean, structured HTML.",
        },
        { role: "user", content: prompt },
      ],
    });

    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;
    let output = completion.choices[0].message.content.trim();
    output = output.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens
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

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content;
      const { prompt_tokens, completion_tokens, total_tokens } =
        completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
    });

    const output = completion.choices[0].message.content;
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;

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
      total_tokens
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

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content;
      const { prompt_tokens, completion_tokens, total_tokens } =
        completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const output = completion.choices[0].message.content;
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;

    await updateAIUsageOnComplete(
      usageId,
      prompt_tokens,
      completion_tokens,
      total_tokens
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

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content.trim();
      const { prompt_tokens, completion_tokens, total_tokens } =
        completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens
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

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });

      const output = completion.choices[0].message.content.trim();
      const { prompt_tokens, completion_tokens, total_tokens } =
        completion.usage;

      await updateAIUsageOnComplete(
        usageId,
        prompt_tokens,
        completion_tokens,
        total_tokens
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const outputRaw = completion.choices[0].message.content;
    const { prompt_tokens, completion_tokens, total_tokens } = completion.usage;

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
      total_tokens
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