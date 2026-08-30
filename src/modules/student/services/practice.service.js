 const express = require("express");
const { json, urlencoded } = require("express");
const { ObjectId } = require("mongodb");
const { connectTodb, getGlobalCollections } = require("../../../shared/db/connection");
const { getTenantDB } = require("../../../shared/db/connection");
const { archiveAndDeleteOne } = require("../../../shared/utils/archive.service");
const XLSX = require("xlsx");
const fs = require("fs").promises;

const findInAllTenants = async (
  collectionName,
  query,
  method = "find",
  options = {}
) => {
  try {
    const tenant1_ID = "skill_688b1cce42c5e979f72d97d4";
    const tenant2_ID = "KSquare";
    const tenant3_ID = "skillmedha_resources";

    // Get connections to all databases
    const db1 = await getTenantDB(tenant1_ID);
    const db2 = await getTenantDB(tenant2_ID);
    const db3 = await getTenantDB(tenant3_ID);

    const { [collectionName]: collection1 } = connectTodb(db1);
    const { [collectionName]: collection2 } = connectTodb(db2);
    const { [collectionName]: collection3 } = connectTodb(db3);

    if (method === "findOne") {
      let result = await collection1.findOne(query);
      if (result) return result;
      result = await collection2.findOne(query);
      if (result) return result;
      return await collection3.findOne(query);
    }

    if (method === "find") {
      // If limit is provided, use $sample aggregation for random sampling at DB level
      if (options.limit && options.limit > 0) {
        const pipeline = [
          { $match: query },
          { $sample: { size: options.limit } }
        ];

        const [results1, results2, results3] = await Promise.all([
          collection1.aggregate(pipeline).toArray(),
          collection2.aggregate(pipeline).toArray(),
          collection3.aggregate(pipeline).toArray(),
        ]);

        // Combine results from all databases
        const combinedResults = [...results1, ...results2, ...results3];

        // De-duplicate based on _id to ensure uniqueness
        const uniqueResultsMap = new Map();
        combinedResults.forEach((item) => {
          uniqueResultsMap.set(item._id.toString(), item);
        });

        const uniqueResults = Array.from(uniqueResultsMap.values());

        // If we have more results than limit due to combining multiple DBs, shuffle and limit again
        if (uniqueResults.length > options.limit) {
          const shuffled = [...uniqueResults];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          return shuffled.slice(0, options.limit);
        }

        return uniqueResults;
      }

      // Fetch from all databases concurrently (for non-limit queries)
      const [results1, results2, results3] = await Promise.all([
        collection1.find(query).toArray(),
        collection2.find(query).toArray(),
        collection3.find(query).toArray(),
      ]);

      // Combine and de-duplicate results based on _id to ensure uniqueness
      const combinedResults = [...results1, ...results2, ...results3];
      const uniqueResultsMap = new Map();
      combinedResults.forEach((item) => {
        uniqueResultsMap.set(item._id.toString(), item);
      });

      const uniqueResults = Array.from(uniqueResultsMap.values());

      // Handle pagination if page and pageSize are provided
      if (options.page && options.pageSize) {
        const page = parseInt(options.page);
        const pageSize = parseInt(options.pageSize);
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;

        const paginatedData = uniqueResults.slice(startIndex, endIndex);
        const hasNext = endIndex < uniqueResults.length;

        return {
          data: paginatedData,
          pagination: {
            currentPage: page,
            pageSize: pageSize,
            totalItems: uniqueResults.length,
            totalPages: Math.ceil(uniqueResults.length / pageSize),
            hasNext: hasNext,
            hasPrev: page > 1,
          },
        };
      }

      return uniqueResults;
    }

    if (method === "countDocuments") {
      const [count1, count2, count3] = await Promise.all([
        collection1.countDocuments(query),
        collection2.countDocuments(query),
        collection3.countDocuments(query),
      ]);
      return count1 + count2 + count3;
    }

    // Return a default value for unsupported methods
    return method === "find" ? [] : null;
  } catch (error) {
    console.log("Error in findInAllTenants:", error);
    throw error;
  }
};

module.exports.createSubject = async (req, res) => {
  const { subjects } = connectTodb(req.tenantDB);
  try {
    const { type, title } = req.body;
    if (!type || !title) {
      return res.status(400).json({ err: "Type and title are required." });
    }

    const findSubject = await subjects.findOne({ $and: [{ type }, { title }] });
    if (findSubject)
      throw new Error("Subject with this title and type already exists");

    const result = await subjects.insertOne({
      ...req.body,
      createdAt: new Date().getTime(),
    });
    res.status(201).json({ msg: "Subject created successfully", data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateSubject = async (req, res) => {
  const { subjects } = connectTodb(req.tenantDB);
  try {
    const { subjectId } = req.params;
    const updateData = req.body;

    const result = await subjects.updateOne(
      { _id: new ObjectId(subjectId) },
      { $set: { ...updateData, updatedAt: new Date().getTime() } }
    );

    if (result.matchedCount === 0) throw new Error("Subject not found");
    res.status(200).json({ msg: "Subject updated successfully", result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deleteSubject = async (req, res) => {
  const { subjects } = connectTodb(req.tenantDB);
  try {
    const { subjectId } = req.params;
    const archiveResult = await archiveAndDeleteOne(subjects, { _id: new ObjectId(subjectId) }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
    });

    if (archiveResult.deletedCount === 0) throw new Error("Subject not found");
    res.status(200).json({ msg: "Subject deleted successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAllSubjects = async (req, res) => {
  try {
    const data = await findInAllTenants("subjects", {}, "find");
    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getSubjectsByType = async (req, res) => {
  try {
    const { type } = req.params;
    if (!type) {
      return res.status(400).json({ err: "Type parameter is required." });
    }
    const data = await findInAllTenants("subjects", { type }, "find");

    // Get number of questions for each subject
    const subjectsWithQuestionCount = await Promise.all(
      data.map(async (subject) => {
        const questionCount = await findInAllTenants(
          "questions",
          { subjectId: subject._id },
          "countDocuments"
        );
        return {
          ...subject,
          totalQuestions: questionCount,
        };
      })
    );

    res.status(200).json({ data: subjectsWithQuestionCount });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};


module.exports.createTopic = async (req, res) => {
  const { topics } = connectTodb(req.tenantDB);
  try {
    const { subjectId, title } = req.body;
    if (!subjectId || !title)
      throw new Error("subjectId and title are required");

    const findTopic = await topics.findOne({
      $and: [{ subjectId: new ObjectId(subjectId) }, { title }],
    });
    if (findTopic)
      throw new Error("Topic with this title already exists for this subject");

    const result = await topics.insertOne({
      ...req.body,
      subjectId: new ObjectId(subjectId),
      createdAt: new Date().getTime(),
    });
    res.status(201).json({ msg: "Topic created successfully", data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateTopic = async (req, res) => {
  const { topics } = connectTodb(req.tenantDB);
  try {
    const { topicId } = req.params;
    const updateData = req.body;

    const result = await topics.updateOne(
      { _id: new ObjectId(topicId) },
      { $set: { ...updateData, updatedAt: new Date().getTime() } }
    );

    if (result.matchedCount === 0) throw new Error("Topic not found");
    res.status(200).json({ msg: "Topic updated successfully", result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deleteTopic = async (req, res) => {
  const { topics } = connectTodb(req.tenantDB);
  try {
    const { topicId } = req.params;
    const archiveResult = await archiveAndDeleteOne(topics, { _id: new ObjectId(topicId) }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
    });

    if (archiveResult.deletedCount === 0) throw new Error("Topic not found");
    res.status(200).json({ msg: "Topic deleted successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getTopicsBySubject = async (req, res) => {
  try {
    const { subjectId } = req.params;
    const query = { subjectId: new ObjectId(subjectId) };
    const data = await findInAllTenants("topics", query, "find");
    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.createSubtopic = async (req, res) => {
  const { subtopics } = connectTodb(req.tenantDB);
  try {
    const { subjectId, topicId, title } = req.body;
    if (!subjectId || !topicId || !title)
      throw new Error("subjectId, topicId, and title are required");

    const findSubtopic = await subtopics.findOne({
      $and: [{ topicId: new ObjectId(topicId) }, { title }],
    });
    if (findSubtopic)
      throw new Error("Subtopic with this title already exists for this topic");

    const result = await subtopics.insertOne({
      ...req.body,
      subjectId: new ObjectId(subjectId),
      topicId: new ObjectId(topicId),
      createdAt: new Date().getTime(),
    });
    res
      .status(201)
      .json({ msg: "Subtopic created successfully", data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateSubtopic = async (req, res) => {
  const { subtopics } = connectTodb(req.tenantDB);
  try {
    const { subtopicId } = req.params;
    const updateData = req.body;

    const result = await subtopics.updateOne(
      { _id: new ObjectId(subtopicId) },
      { $set: { ...updateData, updatedAt: new Date().getTime() } }
    );

    if (result.matchedCount === 0) throw new Error("Subtopic not found");
    res.status(200).json({ msg: "Subtopic updated successfully", result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deleteSubtopic = async (req, res) => {
  const { subtopics } = connectTodb(req.tenantDB);
  try {
    const { subtopicId } = req.params;
    const archiveResult = await archiveAndDeleteOne(subtopics, { _id: new ObjectId(subtopicId) }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
    });

    if (archiveResult.deletedCount === 0) throw new Error("Subtopic not found");
    res.status(200).json({ msg: "Subtopic deleted successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getSubtopicsByTopic = async (req, res) => {
  try {
    const { topicId } = req.params;
    const query = { topicId: new ObjectId(topicId) };
    const data = await findInAllTenants("subtopics", query, "find");

    // Get number of questions for each subtopic
    const subtopicsWithQuestionCount = await Promise.all(
      data.map(async (subtopic) => {
        const questionCount = await findInAllTenants(
          "questions",
          { subTopicId: subtopic._id },
          "countDocuments"
        );
        return {
          ...subtopic,
          totalQuestions: questionCount,
        };
      })
    );

    res.status(200).json({ data: subtopicsWithQuestionCount });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
module.exports.createQuestion = async (req, res) => {
  const { questions } = connectTodb(req.tenantDB);
  try {
    const { subjectId, questionType } = req.body;
    if (!subjectId || !questionType) {
      throw new Error("subjectId and questionType are required");
    }

    // Build the question object conditionally
    const questionData = {
      ...req.body,
      subjectId: new ObjectId(subjectId),
      createdAt: new Date().getTime(),
    };

    // Only add topicId if it exists
    if (req.body.topicId) {
      questionData.topicId = new ObjectId(req.body.topicId);
    }

    // Only add subTopicId if it exists
    if (req.body.subTopicId) {
      questionData.subTopicId = new ObjectId(req.body.subTopicId);
    }

    const result = await questions.insertOne(questionData);
    res
      .status(201)
      .json({ msg: "Question created successfully", data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.bulkUploadPracQuestions = async (req, res) => {
  const { questions: tenantQuestions } = connectTodb(req.tenantDB);
  const { questions: globalQuestions } = getGlobalCollections();

  if (!req.tenantDB && !req.query.skillId) {
    return res.status(500).json({ error: "No tenant DB available" });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ err: "Please upload a file" });
    }

    const { subjectId, skillId, topicId, subTopicId, isTest, uploadType } = req.query;

    if (!subjectId && !skillId) {
      return res.status(400).json({ err: "subjectId or skillId is required as query parameter" });
    }

    // Read Excel/CSV file
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawQuestions = XLSX.utils.sheet_to_json(sheet);

    // Function to normalize column names
    const normalizeKey = (key) => {
      return key.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    };

    // Field mapping for flexible column names
    const fieldMapping = {
      questiontype: "questionType",
      question_type: "questionType",
      type: "questionType",
      questiontext: "questionText",
      question_text: "questionText",
      question: "questionText",
      explanation: "explanation",
      explaination: "explanation",
      solution: "explanation",
      difficulty: "difficulty",
      level: "difficulty",
      concept: "concept",
      companyname: "companyName",
      examname: "examName",
      examyear: "examYear",
      sectionname: "sectionName",
      scorepoints: "scorePoints",
      score_points: "scorePoints",
      score: "scorePoints",
      marks: "scorePoints",
      points: "scorePoints",
      option1: "option1",
      option_1: "option1",
      optiona: "option1",
      option2: "option2",
      option_2: "option2",
      optionb: "option2",
      option3: "option3",
      option_3: "option3",
      optionc: "option3",
      option4: "option4",
      option_4: "option4",
      optiond: "option4",
      correctanswer: "correctAnswer",
      correct_answer: "correctAnswer",
      answer: "correctAnswer",
      answers: "correctAnswer",
      correctanswers: "correctAnswer",
      testcasesjson: "testCasesJSON",
      test_cases_json: "testCasesJSON",
      testcases: "testCasesJSON",
    };

    // Map question data to schema
    const mapQuestionData = (rawQuestion) => {
      const mappedQuestion = {};
      Object.keys(rawQuestion).forEach((key) => {
        const normalizedKey = normalizeKey(key);
        const schemaField = fieldMapping[normalizedKey];
        if (schemaField) {
          mappedQuestion[schemaField] = rawQuestion[key];
        } else if (
          normalizedKey.startsWith("sample") || 
          normalizedKey.startsWith("hidden") || 
          normalizedKey === "constraints" || 
          normalizedKey === "problemstatement" || 
          normalizedKey === "timelimit"
        ) {
          // Auto map without explicitly adding them to fieldMapping
          const camelKey = normalizedKey
            .replace('sampleinput', 'sampleInput')
            .replace('sampleoutput', 'sampleOutput')
            .replace('hiddeninput', 'hiddenInput')
            .replace('hiddenoutput', 'hiddenOutput')
            .replace('problemstatement', 'problemStatement')
            .replace('timelimit', 'timeLimit');
          mappedQuestion[camelKey] = rawQuestion[key];
        }
      });
      return mappedQuestion;
    };

    // Process questions without validation
    const questionsData = rawQuestions.map(mapQuestionData);
    const insertedQuestions = [];

    for (let i = 0; i < questionsData.length; i++) {
      const questionData = questionsData[i];

      let questionType = questionData.questionType;
      
      // Auto-detect Coding Question from Problem Statement column
      if (!questionType && questionData.problemStatement) {
        questionType = "Coding Question";
      } else if (!questionType) {
        questionType = "Single Choice"; // default fallback
      }

      if (uploadType === "coding") {
        questionType = "Coding Question";
      } else {
        const t = String(questionType).toLowerCase();
        if (t.includes("single")) questionType = "Single Choice";
        else if (t.includes("multiple")) questionType = "Multiple Choice";
        else if (t.includes("true") || t.includes("false")) questionType = "True/False";
        else if (t.includes("coding")) questionType = "Coding Question";
      }

      // 1. Build questionContent
      const questionContent = {
        question: questionData.questionText || questionData.problemStatement || "",
      };

      if (questionData.option1) questionContent["option 1"] = String(questionData.option1).trim();
      if (questionData.option2) questionContent["option 2"] = String(questionData.option2).trim();
      if (questionData.option3) questionContent["option 3"] = String(questionData.option3).trim();
      if (questionData.option4) questionContent["option 4"] = String(questionData.option4).trim();

      // 2. Build answer object
      const answer = {
        explanation: questionData.explanation || "",
      };

      // Correct Answer Logic
      const correctAnsRaw = String(questionData.correctAnswer || "").trim();

      if (questionType === "Single Choice" || questionType === "Multiple Choice") {
        const optionsMap = [
          { key: "option 1", val: questionContent["option 1"] },
          { key: "option 2", val: questionContent["option 2"] },
          { key: "option 3", val: questionContent["option 3"] },
          { key: "option 4", val: questionContent["option 4"] },
        ];

        const matchOption = (ansText) => {
          const raw = String(ansText || "").trim();
          return optionsMap.find(opt => {
            return (
              opt.val === raw ||
              raw.toLowerCase() === opt.key ||
              raw === opt.key.replace("option ", "") ||
              (raw.toLowerCase() === "a" && opt.key === "option 1") ||
              (raw.toLowerCase() === "b" && opt.key === "option 2") ||
              (raw.toLowerCase() === "c" && opt.key === "option 3") ||
              (raw.toLowerCase() === "d" && opt.key === "option 4")
            );
          });
        };

        if (questionType === "Single Choice") {
          const foundOption = matchOption(correctAnsRaw);
          if (foundOption) {
            answer.singleChoice = { [foundOption.key]: true };
          } else {
            answer.singleChoice = { "option 1": true };
          }
        } else if (questionType === "Multiple Choice") {
          answer.multipleChoice = {};
          const answers = correctAnsRaw.split(',').map(a => a.trim());
          let foundAny = false;
          answers.forEach(ans => {
            const foundOption = matchOption(ans);
            if (foundOption) {
              answer.multipleChoice[foundOption.key] = true;
              foundAny = true;
            }
          });
          if (!foundAny) {
            answer.multipleChoice = { "option 1": true };
          }
        }
      } else if (questionType === "True/False") {
        // Existing schema likely uses same structure or just "answer": true/false?
        // Based on requested schema, it seems universal.
        // However, if it varies, we stick to the provided example which is Single Choice.
        // For T/F, usually it's "option 1": "True", "option 2": "False" and singleChoice logic applies.
        // So verify if T/F questions in CSV provide options.
        if (!questionContent["option 1"]) {
          questionContent["option 1"] = "True";
          questionContent["option 2"] = "False";
        }
        const isTrue = correctAnsRaw.toLowerCase() === "true";
        answer.singleChoice = {
          [isTrue ? "option 1" : "option 2"]: true
        };
      }

      // 3. Score Settings
      const scoreSettings = {
        scoreType: "fullScore",
        pointsForCorrectAns: questionData.scorePoints ? Number(questionData.scorePoints) : 1
      };

      // 4. Construct Final Object
      const questionObj = {
        ...(subjectId && { subjectId: new ObjectId(subjectId) }),
        ...(skillId && { refId: skillId }),
        questionType: questionType,
        questionContent: questionContent, // Nested structure
        answer: answer,                   // Nested structure
        scoreSettings: scoreSettings,     // Nested structure
        resources: {},
        difficulty: (questionData.difficulty || "medium").toLowerCase(),
        type: skillId ? "skill" : "practice",
        createdAt: new Date().getTime(),
        createdBy: req.userID,
        isTest: isTest === "true" || isTest === true,
      };

      if (questionData.concept) {
        questionObj.concept = String(questionData.concept).trim();
      }

      if (questionData.sectionName) {
        questionObj.sectionName = String(questionData.sectionName).trim();
      }

      if (questionData.companyName) {
        const companyNames = String(questionData.companyName).split(',').map(s => s.trim());
        const examNames = questionData.examName ? String(questionData.examName).split(',').map(s => s.trim()) : [];
        const examYears = questionData.examYear ? String(questionData.examYear).split(',').map(s => s.trim()) : [];
        const sectionNames = questionData.sectionName ? String(questionData.sectionName).split(',').map(s => s.trim()) : [];

        questionObj.companyTags = companyNames.map((cName, i) => ({
          companyName: cName,
          examName: examNames[i] || undefined,
          year: examYears[i] ? Number(examYears[i]) : undefined,
          sectionName: sectionNames[i] || undefined
        }));
      }

      // Add optional topicId and subTopicId if provided
      if (topicId) {
        questionObj.topicId = new ObjectId(topicId);
      }
      if (subTopicId) {
        questionObj.subTopicId = new ObjectId(subTopicId);
      }

      // Handle Coding Question specific fields
      if (questionType === "Coding Question") {
        const testCases = [];
        
        // Extract visible Sample Test Cases (1 to 5)
        for (let j = 1; j <= 5; j++) {
          if (questionData[`sampleInput${j}`] || questionData[`sampleOutput${j}`]) {
            testCases.push({
              input: questionData[`sampleInput${j}`] || "",
              output: questionData[`sampleOutput${j}`] || "",
              isHidden: false
            });
          }
        }

        // Extract Hidden Test Cases (1 to 10)
        for (let j = 1; j <= 10; j++) {
          if (questionData[`hiddenInput${j}`] || questionData[`hiddenOutput${j}`]) {
            testCases.push({
              input: questionData[`hiddenInput${j}`] || "",
              output: questionData[`hiddenOutput${j}`] || "",
              isHidden: true
            });
          }
        }
        
        questionContent.testCases = testCases;
        questionContent.constraints = questionData.constraints || "";
        questionContent.timeLimit = questionData.timeLimit || "2.0";

        // Fallback for old JSON string format if passed directly
        if (questionData.testCasesJSON && testCases.length === 0) {
          try {
            const parsedCases = JSON.parse(questionData.testCasesJSON);
            questionContent.testCases = Array.isArray(parsedCases) ? parsedCases : [parsedCases];
          } catch(e) { }
        }
      }

      insertedQuestions.push(questionObj);
    }

    // Target correct collection (Global for skills, Tenant for practice)
    const targetCollection = skillId ? globalQuestions : tenantQuestions;

    // Bulk insert all questions
    let insertResult = null;
    if (insertedQuestions.length > 0) {
      insertResult = await targetCollection.insertMany(insertedQuestions, {
        ordered: false,
      });

      // Update Company Test Sections
      if (isTest === "true" || isTest === true) {
        if (subjectId) {
          const { companyTests } = require("../../../shared/db/connection").getGlobalCollections();
          
          // Extract unique sections/categories from uploaded questions
          const uploadedSections = new Set();
          insertedQuestions.forEach(q => {
            if (q.sectionName) uploadedSections.add(q.sectionName);
            if (q.concept) uploadedSections.add(q.concept); // Use concept as category if sectionName is not standard
          });

          const uniqueSections = Array.from(uploadedSections);
          if (uniqueSections.length > 0) {
            await companyTests.updateOne(
              { _id: new ObjectId(subjectId) },
              { $addToSet: { sections: { $each: uniqueSections } } }
            );
          }
        }
      }
    }

    res.status(200).json({
      message: "Questions uploaded successfully",
      totalRows: questionsData.length,
      insertedCount: insertedQuestions.length,
    });
  } catch (error) {
    console.error("Error in bulkUploadPracQuestions:", error);
    res.status(500).json({ err: error.message });
  } finally {
    // Delete the uploaded file after processing
    if (req.file && req.file.path) {
      try {
        await fs.unlink(req.file.path);
        console.log(`✅ Deleted temporary file: ${req.file.path}`);
      } catch (unlinkError) {
        console.error(`❌ Error deleting file: ${unlinkError.message}`);
      }
    }
  }
};

module.exports.updatePracQuestion = async (req, res) => {
  const { questions } = connectTodb(req.tenantDB);
  try {
    const { questionId } = req.params;
    const updateData = req.body;

    const result = await questions.updateOne(
      { _id: new ObjectId(questionId) },
      { $set: { ...updateData, updatedAt: new Date().getTime() } }
    );

    if (result.matchedCount === 0) throw new Error("Question not found");
    res.status(200).json({ msg: "Question updated successfully", result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deletePracQuestion = async (req, res) => {
  const { questions } = connectTodb(req.tenantDB);
  try {
    const { questionId } = req.params;
    const archiveResult = await archiveAndDeleteOne(questions, { _id: new ObjectId(questionId) }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
    });

    if (archiveResult.deletedCount === 0) throw new Error("Question not found");
    res.status(200).json({ msg: "Question deleted successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// module.exports.getQuestionsByTopicAndSubject = async (req, res) => {
//     try {
//         const { subjectId, topicId, subTopicId } = req.query;

//         // Build query conditions dynamically, only including non-null values
//         const conditions = [];

//         if (subjectId && subjectId !== 'null' && subjectId !== 'undefined') {
//             conditions.push({ subjectId: new ObjectId(subjectId) });
//         }

//         if (topicId && topicId !== 'null' && topicId !== 'undefined') {
//             conditions.push({ topicId: new ObjectId(topicId) });
//         }

//         if (subTopicId && subTopicId !== 'null' && subTopicId !== 'undefined') {
//             conditions.push({ subTopicId: new ObjectId(subTopicId) });
//         }

//         // If no valid IDs provided, return empty result or handle as needed
//         if (conditions.length === 0) {
//             return res.status(400).json({
//                 err: "At least one valid ID (subjectId, topicId, or subTopicId) is required"
//             });
//         }

//         const query = { $or: conditions };
//         const data = await findInAllTenants('questions', query, 'find');
//         res.status(200).json({ data });
//     } catch (error) {
//         res.status(500).json({ err: error.message });
//     }
// };

module.exports.getQuestionsByTopicAndSubject = async (req, res) => {
  try {
    const { subjectId, topicId, subTopicId, page } = req.query;

    // Build query conditions dynamically, only including non-null values
    const conditions = [];

    if (subjectId && subjectId !== "null" && subjectId !== "undefined") {
      conditions.push({ subjectId: new ObjectId(subjectId) });
    }

    if (topicId && topicId !== "null" && topicId !== "undefined") {
      conditions.push({ topicId: new ObjectId(topicId) });
    }

    if (subTopicId && subTopicId !== "null" && subTopicId !== "undefined") {
      conditions.push({ subTopicId: new ObjectId(subTopicId) });
    }

    // If no valid IDs provided, return empty result or handle as needed
    if (conditions.length === 0) {
      return res.status(400).json({
        err: "At least one valid ID (subjectId, topicId, or subTopicId) is required",
      });
    }

    const query = { $or: conditions };

    // If page is provided, use pagination with 40 items per page
    if (page) {
      const result = await findInAllTenants("questions", query, "find", {
        page: parseInt(page),
        pageSize: 40,
      });

      res.status(200).json({
        data: result.data,
        pagination: result.pagination,
      });
    } else {
      // Return all data without pagination
      const data = await findInAllTenants("questions", query, "find");
      res.status(200).json({ data });
    }
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getDifficultyStats = async (req, res) => {
  try {
    const { refId, type, subjectId } = req.query;
    if (!refId || !type) {
      return res.status(400).json({ err: "refId and type are required" });
    }

    const isObjId = ObjectId.isValid(refId);
    const covId = isObjId ? new ObjectId(refId) : refId;

    const baseQuery = {
      [type]: isObjId ? { $in: [covId, refId.toString()] } : refId,
    };

    let activeQuery = baseQuery;
    let totalQuestions = await findInAllTenants("questions", baseQuery, "countDocuments");

    if (totalQuestions === 0 && type === "subTopicId" && subjectId) {
      const subObjId = ObjectId.isValid(subjectId) ? new ObjectId(subjectId) : subjectId;
      activeQuery = { subjectId: subObjId };
    }

    // Since findInAllTenants doesn't support complex aggregations across multiple tenants easily in this wrapper,
    // we'll run 3 separate countDocuments queries.
    const easyQuery = { ...activeQuery, difficulty: { $regex: new RegExp("^easy$", "i") } };
    const mediumQuery = { ...activeQuery, difficulty: { $regex: new RegExp("^medium$", "i") } };
    const hardQuery = { ...activeQuery, difficulty: { $regex: new RegExp("^hard$", "i") } };

    const [easyCount, mediumCount, hardCount] = await Promise.all([
      findInAllTenants("questions", easyQuery, "countDocuments"),
      findInAllTenants("questions", mediumQuery, "countDocuments"),
      findInAllTenants("questions", hardQuery, "countDocuments"),
    ]);

    res.status(200).json({
      easy: easyCount,
      medium: mediumCount,
      hard: hardCount
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.startPractice = async (req, res) => {
  const { pracSessions, student } = connectTodb(req.tenantDB);
  try {
    let { userId, refId, type, limit = 20, difficulty } = req.body;

    // Apply difficulty limits if difficulty is provided and limit is default
    if (difficulty && req.body.limit === undefined) {
      const diffLower = difficulty.toLowerCase();
      if (diffLower === 'easy') limit = 25;
      else if (diffLower === 'medium') limit = 20;
      else if (diffLower === 'hard') limit = 15;
    }

    const isObjId = ObjectId.isValid(refId);
    const covId = isObjId ? new ObjectId(refId) : refId;

    const baseQuery = {
      [type]: isObjId ? { $in: [covId, refId.toString()] } : refId,
    };

    if (difficulty) {
      baseQuery.difficulty = { $regex: new RegExp(`^${difficulty}$`, "i") };
    }

    // 1. Get total number of questions available for this subtopic / query
    let totalQuestions = await findInAllTenants("questions", baseQuery, "countDocuments");

    // Fallback: If type is subTopicId but yields 0 questions, try matching subjectId if provided or inferred
    let activeQuery = baseQuery;
    if (totalQuestions === 0 && type === "subTopicId" && req.body.subjectId) {
      const subObjId = ObjectId.isValid(req.body.subjectId) ? new ObjectId(req.body.subjectId) : req.body.subjectId;
      activeQuery = { subjectId: subObjId };
      totalQuestions = await findInAllTenants("questions", activeQuery, "countDocuments");
    }

    // 2. Fetch past practice sessions to find seen questions
    const pastSessions = await pracSessions.find({ userId, refId }).toArray();
    
    let seenQuestionIds = new Set();
    pastSessions.forEach(session => {
      if (session.questionsData && Array.isArray(session.questionsData)) {
        session.questionsData.forEach(q => {
          if (q && q._id) seenQuestionIds.add(q._id.toString());
        });
      }
    });

    // If student has seen all available questions (or more, e.g. due to db changes), reset tracking
    if (seenQuestionIds.size >= totalQuestions && totalQuestions > 0) {
      seenQuestionIds.clear();
    }

    const seenIdsArray = Array.from(seenQuestionIds).map(id => ObjectId.isValid(id) ? new ObjectId(id) : id);

    // 3. Query unseen questions
    const unseenQuery = {
      ...activeQuery,
      _id: { $nin: seenIdsArray }
    };
    
    let finalQuestions = await findInAllTenants("questions", unseenQuery, "find", { limit });

    // 4. Pad with seen questions if unseen < limit
    if (finalQuestions.length < limit && seenIdsArray.length > 0) {
      const padCount = limit - finalQuestions.length;
      const seenQuery = {
        ...activeQuery,
        _id: { $in: seenIdsArray }
      };
      const seenQuestionsToPad = await findInAllTenants("questions", seenQuery, "find", { limit: padCount });
      finalQuestions = [...finalQuestions, ...seenQuestionsToPad];
    }

    // 5. Shuffle final questions array
    for (let i = finalQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [finalQuestions[i], finalQuestions[j]] = [finalQuestions[j], finalQuestions[i]];
    }

    const pracData = await pracSessions.insertOne({
      userId: userId,
      refId: refId,
      type: type,
      difficulty: difficulty,
      questionsData: finalQuestions,
      createdAt: new Date().getTime(),
    });

    await student.updateOne(
      { _id: new ObjectId(userId) },
      {
        $addToSet: {
          practiceSessions: pracData?.insertedId?.toString(),
        },
      }
    );

    res.status(200).json({
      msg: "Practice started successfully",
      data: pracData,
      questionsData: finalQuestions,
      count: finalQuestions.length,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.savePracResults = async (req, res) => {
  const { pracSessions } = connectTodb(req.tenantDB);
  try {
    const { pracId } = req.params;

    const covId = new ObjectId(pracId);

    const findPrac = await pracSessions.findOne({ _id: covId });

    if (!findPrac) throw new Error("Please select valid practice to update");

    const updatedData = await pracSessions.updateOne(
      { _id: findPrac._id },
      {
        $set: { ...req.body },
      }
    );

    res
      .status(200)
      .json({
        msg: "Practice results updated succcessfully",
        data: updatedData,
      });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getStudentPracResults = async (req, res) => {
  const { pracSessions, student } = connectTodb(req.tenantDB);
  try {
    const { userId } = req.params;

    const covId = new ObjectId(userId);

    const findStudent = await student.findOne({ _id: covId });

    if (!findStudent) throw new Error("Results Not Found");

    const data = await pracSessions
      .find({ userId })
      .sort({ _id: -1 })
      .toArray();

    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.saveTopMockScore = async (req, res) => {
  const { student, mockTestAttempts } = connectTodb(req.tenantDB);
  try {
    const { testId, attempt } = req.body;
    const userId = req.userID;

    if (!testId || !attempt) {
      return res.status(400).json({ err: "testId and attempt are required" });
    }

    const covId = new ObjectId(userId);
    const findStudent = await student.findOne({ _id: covId });
    if (!findStudent) throw new Error("Student Not Found");

    // Prepare attempt document
    const attemptDoc = {
      ...attempt,
      userId: covId,
      testId: testId,
      createdAt: new Date()
    };

    // Insert into new collection
    await mockTestAttempts.insertOne(attemptDoc);

    // Fetch all attempts for this user and test
    const allAttempts = await mockTestAttempts
      .find({ userId: covId, testId: testId })
      .sort({ score: -1, timestamp: -1 }) // Top score first, then most recent
      .toArray();

    res.status(200).json({ msg: "Attempt saved successfully", data: allAttempts });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getTopMockScores = async (req, res) => {
  const { student, mockTestAttempts } = connectTodb(req.tenantDB);
  try {
    const { testId } = req.params;
    const userId = req.userID;

    const covId = new ObjectId(userId);
    const findStudent = await student.findOne({ _id: covId });
    if (!findStudent) throw new Error("Student Not Found");

    // Fetch all attempts for this user and test
    const allAttempts = await mockTestAttempts
      .find({ userId: covId, testId: testId })
      .sort({ score: -1, timestamp: -1 })
      .toArray();

    res.status(200).json({ data: allAttempts });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
