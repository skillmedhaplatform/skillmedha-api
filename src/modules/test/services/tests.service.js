const { connectTodb } = require("../../../shared/db/connection");
const XLSX = require("xlsx");
const mongodb = require("mongodb");
const mongoDB = require("mongodb");
const nodemailer = require("nodemailer");
const {
  notifyTestAssignment,
  NOTIFICATION_TYPES,
} = require("../../../shared/utils/eventBus");
const { ObjectId } = mongodb;
const fs = require("fs").promises;

// 1. SEARCH QUESTIONS
async function searchQuestions(req, res) {
  const { questions } = connectTodb(req.tenantDB);
  const searchString = req.query.text;
  try {
    const results = await questions
      .find({
        "questionContent.question": { $regex: searchString, $options: "i" },
      })
      .toArray();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// 2. SEARCH TEST
async function searchTest(req, res) {
  const { test } = connectTodb(req.tenantDB);
  const searchString = req.query.text;
  try {
    const results = await test
      .find({
        title: { $regex: searchString, $options: "i" },
      })
      .toArray();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// 3. SEARCH STUDENT
async function searchStudent(req, res) {
  const { student } = connectTodb(req.tenantDB);
  const searchString = req.query.text;
  try {
    const results = await student
      .find({
        email: { $regex: searchString, $options: "i" },
      })
      .toArray();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// 4. ADD TEST
async function addTest(req, res) {
  const { test, categories } = connectTodb(req.tenantDB);
  try {
    const { title, category } = req.body;
    const checkTest = await test.findOne({ title });
    if (checkTest)
      throw new Error("Test with the same title is already present");
    const getOrInsertItems = async (items, collection) => {
      const ids = [];
      for (const item of items) {
        let record = await collection.findOne({ name: item.name });
        if (!record) {
          let rec = await collection.insertOne({
            name: item.name,
            type: item.type,
          });
          record = { _id: rec.insertedId };
        }
        ids.push(record._id.toString());
      }
      return ids;
    };
    const categoryIds = await getOrInsertItems(category, categories);
    const testData = { ...req.body, category: categoryIds };
    const data = await test.insertOne(testData);
    res.json({
      msg: "Test Added successfully",
      id: data.insertedId.toString(),
    });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 5. UPDATE TEST
// async function updateTest(req, res) {
//   const { test, categories, languages } = connectTodb(req.tenantDB);
//   try {
//     const { id } = req.params;
//     const covId = new mongoDB.ObjectId(id);
//     const findTest = await test.findOne({ _id: covId });
//     if (!findTest) throw new Error("No Test to update");
//     const updateData = { ...req.body };
//     const getOrInsertItems = async (items, collection) => {
//       const ids = [];
//       for (const item of items) {
//         let record = await collection.findOne({ name: item.name });
//         if (!record) {
//           const ins = await collection.insertOne({
//             name: item.name,
//             type: item.type,
//           });
//           record = { _id: ins.insertedId };
//         }
//         ids.push(record._id.toString());
//       }
//       return ids;
//     };
//     if (req.body.category) {
//       const categoryItems = req.body.category.map((item) => ({
//         name: item.name,
//         type: item.type,
//       }));
//       updateData.category = await getOrInsertItems(categoryItems, categories);
//     }
//     if (req.body.language) {
//       const languageItems = req.body.language.map((item) => ({
//         name: item.name,
//         type: item.type,
//       }));
//       updateData.language = await getOrInsertItems(languageItems, languages);
//     }
//     const data = await test.updateOne(
//       { _id: findTest._id },
//       { $set: updateData }
//     );
//     res.send({ msg: "Test updated successfully", updatedTest: data });
//   } catch (error) {
//     res.send({ err: error.message });
//   }
// }

async function updateTest(req, res) {
  const { test, categories, languages } = connectTodb(req.tenantDB);

  try {
    const { id } = req.params;
    const covId = new mongoDB.ObjectId(id);
    const findTest = await test.findOne({ _id: covId });

    if (!findTest) throw new Error("No Test to update");

    const updateData = { ...req.body };

    const getOrInsertItems = async (items, collection) => {
      const ids = [];
      for (const item of items) {
        let record = await collection.findOne({ name: item.name });
        if (!record) {
          const ins = await collection.insertOne({
            name: item.name,
            type: item.type,
          });
          record = { _id: ins.insertedId };
        }
        ids.push(record._id.toString());
      }
      return ids;
    };

    if (req.body.category) {
      const categoryItems = req.body.category.map((item) => ({
        name: item.name,
        type: item.type,
      }));
      updateData.category = await getOrInsertItems(categoryItems, categories);
    }

    if (req.body.language) {
      const languageItems = req.body.language.map((item) => ({
        name: item.name,
        type: item.type,
      }));
      updateData.language = await getOrInsertItems(languageItems, languages);
    }

    const data = await test.updateOne(
      { _id: findTest._id },
      { $set: updateData }
    );

    // ✅ SEND NOTIFICATIONS IF ACCESS CRITERIA CHANGED
    // Only notify if access criteria actually changed
    const accessChanged =
      req.body.access &&
      JSON.stringify(req.body.access) !== JSON.stringify(findTest.access);

    if (accessChanged) {
      const updatedTestData = {
        ...findTest,
        ...updateData,
        _id: findTest._id,
      };
      // console.log(req.tenantId, req.tenantDB, updatedTestData, req.body.access);

      notifyTestAssignment(
        req.orgId,
        req.tenantDB,
        updatedTestData,
        req.body.access
      )
        .then((result) => {
          console.log("✅ Test update notification result:", result);
        })
        .catch((err) => {
          console.error("❌ Test update notification failed:", err);
        });
    }

    res.send({ msg: "Test updated successfully", updatedTest: data });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 6. BLOCK STUDENT FROM TEST
async function blockStudentFromTest(req, res) {
  const { test } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const { studentId } = req.body;
    const covId = new mongoDB.ObjectId(id);
    const findTest = await test.findOne({ _id: covId });
    if (!findTest) throw new Error("No Test to update");
    const data = await test.updateOne(
      { _id: findTest._id },
      { $push: { blockedStudents: studentId } }
    );
    res.json({
      msg: "Student Blocked Successfully from this test",
      modifiedData: data,
    });
  } catch (error) {
    res.json({ err: error.message });
  }
}

// 7. UNBLOCK STUDENT FROM TEST
async function unblockStudentFromTest(req, res) {
  const { test } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const { studentId } = req.body;
    const covId = new mongoDB.ObjectId(id);
    const findTest = await test.findOne({ _id: covId });
    if (!findTest) throw new Error("No Test to update");
    const data = await test.updateOne(
      { _id: findTest._id },
      { $pull: { blockedStudents: studentId } }
    );
    res.json({
      msg: "Student unBlocked successfully from this test",
      modifiedData: data,
    });
  } catch (error) {
    res.json({ err: error.message });
  }
}

// 8. DELETE TEST
async function deleteTest(req, res) {
  const { test } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const covId = new mongoDB.ObjectId(id);
    const findTest = await test.findOne({ _id: covId });
    if (!findTest) throw new Error("No Test to delete");
    const data = await test.deleteOne({ _id: findTest._id });
    res.send({ msg: "Test deleted successfully", deletedTest: data });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 9. CHANGE QUESTIONS ORDER IN TEST
async function changeQuestionsOrder(req, res) {
  const { test } = connectTodb(req.tenantDB);
  try {
    const { testId } = req.params;
    const mongoTestId = new mongoDB.ObjectId(testId);
    const findTest = await test.findOne({ _id: mongoTestId });
    if (!findTest?._id)
      throw new Error("No Tests with that title to update questions order");
    const data = await test.updateOne(
      { _id: findTest?._id },
      { $set: { questions: req.body.questions } }
    );
    res.send({
      msg: "question order updated successfully",
      changedQuestionsOrder: data,
    });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 10. ADD QUESTION
async function addQuestion(req, res) {
  const { questions, categories, test } = connectTodb(req.tenantDB);
  const { testId } = req.query;
  const { questionCategory, ...restOfBody } = req.body;
  const getOrInsertCategories = async (categoriess) => {
    const ids = [];
    for (const categoryName of categoriess) {
      let record = await categories.findOne({ name: categoryName?.name });
      if (!record) {
        const insertResult = await categories.insertOne(categoryName);
        record = { _id: insertResult.insertedId };
      }
      ids.push(record._id.toString());
    }
    return ids;
  };
  try {
    let questionData = { ...restOfBody };
    if (questionCategory && questionCategory.length > 0) {
      questionData.questionCategory = await getOrInsertCategories(
        questionCategory
      );
    }
    const data = await questions.insertOne(questionData);
    const questionId = data.insertedId.toString();
    if (testId) {
      const mongoTestId = new mongoDB.ObjectId(testId);
      const findTest = await test.findOne({ _id: mongoTestId });
      if (!findTest) throw new Error("Test not found");
      await test.updateOne(
        { _id: mongoTestId },
        { $push: { questions: questionId } }
      );
    }
    res.json({ msg: "Question Added Successfully", id: questionId });
  } catch (error) {
    res.status(500).json({ msg: "An error occurred", error: error.message });
  }
}

// 11. GET QUESTION COUNT
async function getQuestionLength(req, res) {
  const { questions } = connectTodb(req.tenantDB);
  try {
    const data = await questions.find({}).toArray();
    res.send({ msg: data?.length });
  } catch (error) {
    res.send({ err: error.message });
  }
}

async function bulkUploadQuestions(req, res) {
  const { questions, test, categories } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    if (!req.file) {
      return res.status(400).json({ err: "Please upload a file" });
    }

    const { testId } = req.params;

    // Read Excel file from disk path
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawQuestions = XLSX.utils.sheet_to_json(sheet);

    // Function to normalize column names
    const normalizeKey = (key) => {
      return key
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .trim();
    };

    const fieldMapping = {
      question: "question",
      questiontext: "question",
      question_text: "question",

      option1: "option1",
      option_1: "option1",
      "option 1": "option1",
      optiona: "option1",

      option2: "option2",
      option_2: "option2",
      "option 2": "option2",
      optionb: "option2",

      option3: "option3",
      option_3: "option3",
      "option 3": "option3",
      optionc: "option3",

      option4: "option4",
      option_4: "option4",
      "option 4": "option4",
      optiond: "option4",

      correctoption: "correctOption",
      correct_option: "correctOption",
      "correct option": "correctOption",
      answer: "correctOption",
      correctanswer: "correctOption",
      correct_answer: "correctOption",

      questionscore: "questionScore",
      question_score: "questionScore",
      "question score": "questionScore",
      score: "questionScore",
      marks: "questionScore",

      pointsforcorrectans: "pointsForCorrectAns",
      points_for_correct_ans: "pointsForCorrectAns",
      "points for correct ans": "pointsForCorrectAns",
      correctpoints: "pointsForCorrectAns",
      correct_points: "pointsForCorrectAns",

      pointsforincorrectans: "pointsForIncorrectAns",
      points_for_incorrect_ans: "pointsForIncorrectAns",
      "points for incorrect ans": "pointsForIncorrectAns",
      negativemarks: "pointsForIncorrectAns",
      negative_marks: "pointsForIncorrectAns",

      explanation: "explanation",
      explaination: "explanation",
      solution: "explanation",

      questiontype: "questionType",
      question_type: "questionType",
      "question type": "questionType",
      type: "questionType",

      scoretype: "scoreType",
      score_type: "scoreType",
      "score type": "scoreType",

      category: "questionCategory",
      categories: "questionCategory",
      questioncategory: "questionCategory",
    };

    // Function to map question data to schema
    const mapQuestionData = (rawQuestion) => {
      const mappedQuestion = {};

      Object.keys(rawQuestion).forEach((key) => {
        const normalizedKey = normalizeKey(key);
        const schemaField = fieldMapping[normalizedKey];

        if (schemaField) {
          mappedQuestion[schemaField] = rawQuestion[key];
        }
      });

      return mappedQuestion;
    };

    // Validation functions
    const validQuestionTypes = ["Single Choice", "Multiple Choice"];
    const validScoreTypes = ["fullScore", "partialScore"];

    const validateQuestionData = (questionData, rowIndex) => {
      const errors = [];

      // 1. Validate question text is not empty
      if (
        !questionData.question ||
        String(questionData.question).trim() === ""
      ) {
        errors.push(
          `Row ${rowIndex + 2}: Question text is required and cannot be empty`
        );
      }

      // 2. Validate question type
      const questionType = questionData.questionType || "Single Choice";
      if (!validQuestionTypes.includes(questionType)) {
        errors.push(
          `Row ${rowIndex + 2
          }: Invalid question type "${questionType}". Must be one of: ${validQuestionTypes.join(
            ", "
          )}`
        );
      }

      // 3. Validate options for choice-based questions
      if (
        questionType === "Single Choice" ||
        questionType === "Multiple Choice"
      ) {
        const options = [
          questionData.option1,
          questionData.option2,
          questionData.option3,
          questionData.option4,
        ];

        // Check if all options are present and not empty
        options.forEach((option, index) => {
          if (!option || String(option).trim() === "") {
            errors.push(
              `Row ${rowIndex + 2}: Option ${index + 1
              } is required and cannot be empty for ${questionType}`
            );
          }
        });

        // Check for duplicate options
        const nonEmptyOptions = options.filter(
          (opt) => opt && String(opt).trim() !== ""
        );
        const uniqueOptions = [
          ...new Set(
            nonEmptyOptions.map((opt) => String(opt).trim().toLowerCase())
          ),
        ];
        if (nonEmptyOptions.length !== uniqueOptions.length) {
          errors.push(
            `Row ${rowIndex + 2
            }: Duplicate options found. All options must be unique`
          );
        }
      }

      // 4. Validate correct answer
      if (
        !questionData.correctOption ||
        String(questionData.correctOption).trim() === ""
      ) {
        errors.push(
          `Row ${rowIndex + 2}: Correct answer is required and cannot be empty`
        );
      } else {
        const correctOpt = String(questionData.correctOption)
          .trim()
          .toLowerCase();

        if (questionType === "Multiple Choice") {
          // For multiple choice, accept comma-separated values like "1,3" or "option1,option3"
          const correctOptions = correctOpt.split(",").map((opt) => opt.trim());
          const validAnswers = [
            "1",
            "2",
            "3",
            "4",
            "option 1",
            "option 2",
            "option 3",
            "option 4",
            "option1",
            "option2",
            "option3",
            "option4",
          ];

          const invalidOptions = correctOptions.filter(
            (opt) => !validAnswers.includes(opt)
          );
          if (invalidOptions.length > 0) {
            errors.push(
              `Row ${rowIndex + 2
              }: Invalid correct answer format for Multiple Choice. Use comma-separated values like "1,3" or "option1,option3"`
            );
          }
        } else {
          // For single choice, only one answer is allowed
          const validAnswers = [
            "1",
            "2",
            "3",
            "4",
            "option 1",
            "option 2",
            "option 3",
            "option 4",
            "option1",
            "option2",
            "option3",
            "option4",
          ];
          if (!validAnswers.includes(correctOpt)) {
            errors.push(
              `Row ${rowIndex + 2}: Invalid correct answer format "${questionData.correctOption
              }". Must be 1-4 or "option 1" to "option 4"`
            );
          }
        }
      }

      // 5. Validate question score
      if (
        questionData.questionScore !== undefined &&
        questionData.questionScore !== null
      ) {
        const score = Number(questionData.questionScore);
        if (isNaN(score) || score <= 0) {
          errors.push(
            `Row ${rowIndex + 2
            }: Question score must be a positive number, got "${questionData.questionScore
            }"`
          );
        }
      }

      // 6. Validate score type
      const scoreType = questionData.scoreType || "fullScore";
      if (!validScoreTypes.includes(scoreType)) {
        errors.push(
          `Row ${rowIndex + 2
          }: Invalid score type "${scoreType}". Must be one of: ${validScoreTypes.join(
            ", "
          )}`
        );
      }

      // 7. Validate points
      if (
        questionData.pointsForCorrectAns !== undefined &&
        questionData.pointsForCorrectAns !== null
      ) {
        const correctPoints = Number(questionData.pointsForCorrectAns);
        if (isNaN(correctPoints)) {
          errors.push(
            `Row ${rowIndex + 2
            }: Points for correct answer must be a number, got "${questionData.pointsForCorrectAns
            }"`
          );
        }
      }

      if (
        questionData.pointsForIncorrectAns !== undefined &&
        questionData.pointsForIncorrectAns !== null
      ) {
        const incorrectPoints = Number(questionData.pointsForIncorrectAns);
        if (isNaN(incorrectPoints)) {
          errors.push(
            `Row ${rowIndex + 2
            }: Points for incorrect answer must be a number, got "${questionData.pointsForIncorrectAns
            }"`
          );
        }
      }

      return errors;
    };

    // Function to build answer object with correct property name based on question type
    const buildAnswerObject = (questionData) => {
      const questionType = questionData.questionType || "Single Choice";
      const correctOptString = String(questionData.correctOption)
        .trim()
        .toLowerCase();

      // Map correctOption values to standard option keys
      const optionMap = {
        1: "option 1",
        2: "option 2",
        3: "option 3",
        4: "option 4",
        option1: "option 1",
        option2: "option 2",
        option3: "option 3",
        option4: "option 4",
        "option 1": "option 1",
        "option 2": "option 2",
        "option 3": "option 3",
        "option 4": "option 4",
      };

      const correctAnswers = {};

      if (questionType === "Multiple Choice") {
        // For multiple choice, split by comma and add all correct options
        const correctOptions = correctOptString
          .split(",")
          .map((opt) => opt.trim());
        correctOptions.forEach((opt) => {
          const standardKey = optionMap[opt];
          if (standardKey) {
            correctAnswers[standardKey] = true;
          }
        });
      } else {
        // For single choice, add only the one correct option
        const standardKey = optionMap[correctOptString];
        if (standardKey) {
          correctAnswers[standardKey] = true;
        }
      }

      return correctAnswers;
    };

    // Process and handle categories - MATCHES addQuestion pattern
    const getOrInsertCategories = async (categoryNames) => {
      if (!categoryNames) return [];

      const categoryArray =
        typeof categoryNames === "string"
          ? categoryNames.split(",").map((c) => c.trim())
          : categoryNames;

      const ids = [];

      for (const categoryName of categoryArray) {
        let record = await categories.findOne({
          name: categoryName,
          type: "question",
        });

        if (!record) {
          const insertResult = await categories.insertOne({
            name: categoryName,
            type: "question",
          });
          record = { _id: insertResult.insertedId };
        }

        ids.push(record._id.toString());
      }

      return ids;
    };

    // Process questions with normalized data
    const questionsData = rawQuestions.map(mapQuestionData);

    const insertedQuestions = [];
    const skippedQuestions = [];
    const allValidationErrors = [];

    for (let i = 0; i < questionsData.length; i++) {
      const questionData = questionsData[i];

      // Validate question data
      const validationErrors = validateQuestionData(questionData, i);

      if (validationErrors.length > 0) {
        skippedQuestions.push({
          row: i + 2,
          errors: validationErrors,
          data: questionData,
        });
        allValidationErrors.push(...validationErrors);
        continue;
      }

      const questionType = questionData.questionType || "Single Choice";
      const correctAnswers = buildAnswerObject(questionData);

      // Handle categories if provided - returns array of string IDs
      let categoryIds = [];
      if (questionData.questionCategory) {
        categoryIds = await getOrInsertCategories(
          questionData.questionCategory
        );
      }

      // Build question object with correct answer structure based on question type
      const questionObj = {
        resources: {},
        questionType: questionType,
        questionContent: {
          question: String(questionData.question).trim(),
          "option 1": questionData.option1
            ? String(questionData.option1).trim()
            : "",
          "option 2": questionData.option2
            ? String(questionData.option2).trim()
            : "",
          "option 3": questionData.option3
            ? String(questionData.option3).trim()
            : "",
          "option 4": questionData.option4
            ? String(questionData.option4).trim()
            : "",
        },
        questionScore: questionData.questionScore
          ? String(questionData.questionScore)
          : "2",
        scoreSettings: {
          scoreType: questionData.scoreType || "fullScore",
          pointsForCorrectAns: questionData.pointsForCorrectAns || 2,
          pointsForIncorrectAns: questionData.pointsForIncorrectAns || -1,
        },
        answer: {
          // Use conditional spread to add the correct property based on question type
          ...(questionType === "Multiple Choice" && {
            multipleChoice: correctAnswers,
          }),
          ...(questionType !== "Multiple Choice" && {
            singleChoice: correctAnswers,
          }),
          explanation: questionData.explanation
            ? String(questionData.explanation).trim()
            : "",
        },
        status: "fulfilled",
        type: "test",
      };

      // Add categories if present - now with array of string IDs
      if (categoryIds.length > 0) {
        questionObj.questionCategory = categoryIds;
      }

      insertedQuestions.push(questionObj);
    }

    // If there are validation errors, return them without inserting
    if (skippedQuestions.length > 0 && insertedQuestions.length === 0) {
      return res.status(400).json({
        error: "All questions failed validation",
        totalRows: questionsData.length,
        skippedCount: skippedQuestions.length,
        validationErrors: allValidationErrors,
        skippedQuestions: skippedQuestions,
      });
    }

    // Bulk insert only valid questions
    let insertResult = null;
    if (insertedQuestions.length > 0) {
      insertResult = await questions.insertMany(insertedQuestions, {
        ordered: false,
      });
    }

    // Update test if testId is provided
    if (testId && insertResult) {
      const mongoTestId = new ObjectId(testId);
      const findTest = await test.findOne({ _id: mongoTestId });

      if (findTest) {
        const questionIds = Object.values(insertResult.insertedIds).map((id) =>
          id.toString()
        );
        await test.updateOne(
          { _id: findTest._id },
          { $push: { questions: { $each: questionIds } } }
        );
      }
    }

    res.status(200).json({
      message: "Questions upload completed",
      totalRows: questionsData.length,
      insertedCount: insertedQuestions.length,
      skippedCount: skippedQuestions.length,
      validationErrors:
        allValidationErrors.length > 0 ? allValidationErrors : undefined,
      skippedQuestions:
        skippedQuestions.length > 0 ? skippedQuestions : undefined,
      insertedIds: insertResult
        ? Object.values(insertResult.insertedIds).map((id) => id.toString())
        : [],
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  } finally {
    // Delete the uploaded file after processing (success or failure)
    if (req.file && req.file.path) {
      try {
        await fs.unlink(req.file.path);
        console.log(`✅ Deleted temporary file: ${req.file.path}`);
      } catch (unlinkError) {
        console.error(`❌ Error deleting file: ${unlinkError.message}`);
        // Don't throw error, just log it
      }
    }
  }
}

async function bulkUploadQuestionsToBank(req, res) {
  const { questions, categories } = connectTodb(req.tenantDB);

  if (!req.tenantDB) {
    return res.status(500).json({ error: "No tenant DB available" });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ err: "Please upload a file" });
    }

    // Read Excel file
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawQuestions = XLSX.utils.sheet_to_json(sheet);

    // Function to normalize column names
    const normalizeKey = (key) => {
      return key
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .trim();
    };

    const fieldMapping = {
      question: "question",
      questiontext: "question",
      question_text: "question",
      option1: "option1",
      option_1: "option1",
      "option 1": "option1",
      optiona: "option1",
      option2: "option2",
      option_2: "option2",
      "option 2": "option2",
      optionb: "option2",
      option3: "option3",
      option_3: "option3",
      "option 3": "option3",
      optionc: "option3",
      option4: "option4",
      option_4: "option4",
      "option 4": "option4",
      optiond: "option4",
      correctoption: "correctOption",
      correct_option: "correctOption",
      "correct option": "correctOption",
      answer: "correctOption",
      correctanswer: "correctOption",
      correct_answer: "correctOption",
      questionscore: "questionScore",
      question_score: "questionScore",
      "question score": "questionScore",
      score: "questionScore",
      marks: "questionScore",
      pointsforcorrectans: "pointsForCorrectAns",
      points_for_correct_ans: "pointsForCorrectAns",
      "points for correct ans": "pointsForCorrectAns",
      correctpoints: "pointsForCorrectAns",
      correct_points: "pointsForCorrectAns",
      pointsforincorrectans: "pointsForIncorrectAns",
      points_for_incorrect_ans: "pointsForIncorrectAns",
      "points for incorrect ans": "pointsForIncorrectAns",
      negativemarks: "pointsForIncorrectAns",
      negative_marks: "pointsForIncorrectAns",
      explanation: "explanation",
      explaination: "explanation",
      solution: "explanation",
      questiontype: "questionType",
      question_type: "questionType",
      "question type": "questionType",
      type: "questionType",
      scoretype: "scoreType",
      score_type: "scoreType",
      "score type": "scoreType",
      category: "questionCategory",
      categories: "questionCategory",
      questioncategory: "questionCategory",
    };

    // Map question data
    const mapQuestionData = (rawQuestion) => {
      const mappedQuestion = {};
      Object.keys(rawQuestion).forEach((key) => {
        const normalizedKey = normalizeKey(key);
        const schemaField = fieldMapping[normalizedKey];
        if (schemaField) {
          mappedQuestion[schemaField] = rawQuestion[key];
        }
      });
      return mappedQuestion;
    };

    // Validation functions
    const validQuestionTypes = ["Single Choice", "Multiple Choice"];
    const validScoreTypes = ["fullScore", "partialScore"];

    const validateQuestionData = (questionData, rowIndex) => {
      const errors = [];

      if (
        !questionData.question ||
        String(questionData.question).trim() === ""
      ) {
        errors.push(`Row ${rowIndex + 2}: Question text is required`);
      }

      const questionType = questionData.questionType || "Single Choice";
      if (!validQuestionTypes.includes(questionType)) {
        errors.push(
          `Row ${rowIndex + 2}: Invalid question type "${questionType}"`
        );
      }

      if (
        questionType === "Single Choice" ||
        questionType === "Multiple Choice"
      ) {
        const options = [
          questionData.option1,
          questionData.option2,
          questionData.option3,
          questionData.option4,
        ];

        options.forEach((option, index) => {
          if (!option || String(option).trim() === "") {
            errors.push(`Row ${rowIndex + 2}: Option ${index + 1} is required`);
          }
        });
      }

      if (
        !questionData.correctOption ||
        String(questionData.correctOption).trim() === ""
      ) {
        errors.push(`Row ${rowIndex + 2}: Correct answer is required`);
      }

      return errors;
    };

    // Build answer object
    const buildAnswerObject = (questionData) => {
      const questionType = questionData.questionType || "Single Choice";
      const correctOptString = String(questionData.correctOption)
        .trim()
        .toLowerCase();

      const optionMap = {
        1: "option 1",
        2: "option 2",
        3: "option 3",
        4: "option 4",
        option1: "option 1",
        option2: "option 2",
        option3: "option 3",
        option4: "option 4",
        "option 1": "option 1",
        "option 2": "option 2",
        "option 3": "option 3",
        "option 4": "option 4",
      };

      const correctAnswers = {};

      if (questionType === "Multiple Choice") {
        const correctOptions = correctOptString
          .split(",")
          .map((opt) => opt.trim());
        correctOptions.forEach((opt) => {
          const standardKey = optionMap[opt];
          if (standardKey) {
            correctAnswers[standardKey] = true;
          }
        });
      } else {
        const standardKey = optionMap[correctOptString];
        if (standardKey) {
          correctAnswers[standardKey] = true;
        }
      }

      return correctAnswers;
    };

    // Process and handle categories - MATCHES addQuestion pattern
    const getOrInsertCategories = async (categoryNames) => {
      if (!categoryNames) return [];

      const categoryArray =
        typeof categoryNames === "string"
          ? categoryNames.split(",").map((c) => c.trim())
          : categoryNames;

      const ids = [];

      for (const categoryName of categoryArray) {
        let record = await categories.findOne({
          name: categoryName,
          type: "question",
        });

        if (!record) {
          const insertResult = await categories.insertOne({
            name: categoryName,
            type: "question",
          });
          record = { _id: insertResult.insertedId };
        }

        ids.push(record._id.toString());
      }

      return ids;
    };

    const questionsData = rawQuestions.map(mapQuestionData);
    const insertedQuestions = [];
    const skippedQuestions = [];
    const allValidationErrors = [];

    for (let i = 0; i < questionsData.length; i++) {
      const questionData = questionsData[i];

      const validationErrors = validateQuestionData(questionData, i);
      if (validationErrors.length > 0) {
        skippedQuestions.push({
          row: i + 2,
          errors: validationErrors,
          data: questionData,
        });
        allValidationErrors.push(...validationErrors);
        continue;
      }

      const questionType = questionData.questionType || "Single Choice";
      const correctAnswers = buildAnswerObject(questionData);

      // Handle categories if provided - returns array of string IDs
      let categoryIds = [];
      if (questionData.questionCategory) {
        categoryIds = await getOrInsertCategories(
          questionData.questionCategory
        );
      }

      const questionObj = {
        resources: {},
        questionType: questionType,
        questionContent: {
          question: String(questionData.question).trim(),
          "option 1": questionData.option1
            ? String(questionData.option1).trim()
            : "",
          "option 2": questionData.option2
            ? String(questionData.option2).trim()
            : "",
          "option 3": questionData.option3
            ? String(questionData.option3).trim()
            : "",
          "option 4": questionData.option4
            ? String(questionData.option4).trim()
            : "",
        },
        questionScore: questionData.questionScore
          ? String(questionData.questionScore)
          : "2",
        scoreSettings: {
          scoreType: questionData.scoreType || "fullScore",
          pointsForCorrectAns: questionData.pointsForCorrectAns || 2,
          pointsForIncorrectAns: questionData.pointsForIncorrectAns || -1,
        },
        answer: {
          ...(questionType === "Multiple Choice" && {
            multipleChoice: correctAnswers,
          }),
          ...(questionType !== "Multiple Choice" && {
            singleChoice: correctAnswers,
          }),
          explanation: questionData.explanation
            ? String(questionData.explanation).trim()
            : "",
        },
        status: "fulfilled",
        type: "bank",
      };

      // Add categories if present - now with array of string IDs
      if (categoryIds.length > 0) {
        questionObj.questionCategory = categoryIds;
      }

      insertedQuestions.push(questionObj);
    }

    if (skippedQuestions.length > 0 && insertedQuestions.length === 0) {
      return res.status(400).json({
        error: "All questions failed validation",
        totalRows: questionsData.length,
        skippedCount: skippedQuestions.length,
        validationErrors: allValidationErrors,
        skippedQuestions: skippedQuestions,
      });
    }

    let insertResult = null;
    if (insertedQuestions.length > 0) {
      insertResult = await questions.insertMany(insertedQuestions, {
        ordered: false,
      });
    }

    res.status(200).json({
      message: "Questions uploaded to question bank successfully",
      totalRows: questionsData.length,
      insertedCount: insertedQuestions.length,
      skippedCount: skippedQuestions.length,
      validationErrors:
        allValidationErrors.length > 0 ? allValidationErrors : undefined,
      skippedQuestions:
        skippedQuestions.length > 0 ? skippedQuestions : undefined,
      insertedIds: insertResult
        ? Object.values(insertResult.insertedIds).map((id) => id.toString())
        : [],
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  } finally {
    if (req.file && req.file.path) {
      try {
        await fs.unlink(req.file.path);
        console.log(`✅ Deleted temporary file: ${req.file.path}`);
      } catch (unlinkError) {
        console.error(`❌ Error deleting file: ${unlinkError.message}`);
      }
    }
  }
}

async function addQuestionToBank(req, res) {
  const { questions, categories } = connectTodb(req.tenantDB);
  const { questionCategory, ...restOfBody } = req.body;

  const getOrInsertCategories = async (categoriess) => {
    const ids = [];
    for (const categoryName of categoriess) {
      let record = await categories.findOne({ name: categoryName?.name });
      if (!record) {
        const insertResult = await categories.insertOne(categoryName);
        record = { _id: insertResult.insertedId };
      }
      ids.push(record._id.toString());
    }
    return ids;
  };

  try {
    let questionData = { ...restOfBody };

    if (questionCategory && questionCategory.length > 0) {
      questionData.questionCategory = await getOrInsertCategories(
        questionCategory
      );
    }

    const data = await questions.insertOne(questionData);
    const questionId = data.insertedId.toString();

    res.json({
      msg: "Question Added to Question Bank Successfully",
      id: questionId,
    });
  } catch (error) {
    res.status(500).json({
      msg: "An error occurred",
      error: error.message,
    });
  }
}

async function updateQuestion(req, res) {
  const { questions, categories } = connectTodb(req.tenantDB);
  const { questionId } = req.params;
  const { questionCategory, ...restOfBody } = req.body;
  const getOrInsertCategories = async (categoriess) => {
    const ids = [];
    for (const categoryName of categoriess) {
      let record = await categories.findOne({ name: categoryName?.name });
      if (!record) {
        try {
          const insertResult = await categories.insertOne({
            ...categoryName,
            type: "question",
          });
          record = { _id: insertResult.insertedId };
        } catch (error) {
          if (error.code === 11000) {
            record = await categories.findOne({ name: categoryName?.name });
          } else {
            throw error;
          }
        }
      }
      if (record) {
        ids.push(record._id.toString());
      }
    }
    if (ids?.length) return ids;
  };
  try {
    const covId = new mongoDB.ObjectId(questionId);
    const findQuestion = await questions.findOne({ _id: covId });
    if (!findQuestion)
      throw new Error("No Questions to update with that Question");
    const updateData = { ...restOfBody };
    if (questionCategory && questionCategory.length > 0) {
      updateData.questionCategory = await getOrInsertCategories(
        questionCategory
      );
    }
    await questions.updateOne({ _id: covId }, { $set: updateData });
    res.send({ msg: "Question updated successfully" });
  } catch (error) {
    res.status(500).json({ msg: "An error occurred", error: error.message });
  }
}

// 14. ADD QUESTION TO TEST
async function addQuestionToTest(req, res) {
  const { test } = connectTodb(req.tenantDB);
  try {
    const { testId } = req.params;
    const { questionId } = req.body;
    const checkTestID = testId.match(/^[a-f\d]{24}$/i);
    if (!checkTestID) throw new Error("Invalid test selected");
    const checkquestionId = questionId.match(/^[a-f\d]{24}$/i);
    if (!checkquestionId) throw new Error("Invalid question selected");
    const mongoTestId = new mongoDB.ObjectId(testId);
    const findTest = await test.findOne({ _id: mongoTestId });
    if (!findTest?._id) throw new Error("No Test with that title to update");
    if (findTest?.questions?.includes(questionId))
      return res.send({ msg: `question already added to this test` });
    const addToTest = await test.updateOne(
      { _id: findTest?._id },
      { $push: { questions: questionId } }
    );
    res.send({ msg: "Question Added to test", data: addToTest });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 15. REMOVE QUESTION FROM TEST
async function removeQuestionFromTest(req, res) {
  const { test } = connectTodb(req.tenantDB);
  try {
    const { testId } = req.params;
    const { questionId } = req.body;
    const checkTestID = testId.match(/^[a-f\d]{24}$/i);
    if (!checkTestID) throw new Error("Invalid test selected");
    const checkquestionId = questionId.match(/^[a-f\d]{24}$/i);
    if (!checkquestionId) throw new Error("Invalid question selected");
    const mongoTestId = new mongoDB.ObjectId(testId);
    const findTest = await test.findOne({ _id: mongoTestId });
    if (!findTest?._id) throw new Error("No Test with that title to update");
    const deletedFromTest = await test.updateOne(
      { _id: findTest?._id },
      { $pull: { questions: { $in: [questionId, new mongoDB.ObjectId(questionId)] } } }
    );
    res.send({ msg: "Question removed from test", data: deletedFromTest });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 16. DELETE QUESTION
async function deleteQuestion(req, res) {
  console.log("DeleteQuestion API called with:", req.body);
  const { questions, test } = connectTodb(req.tenantDB);
  try {
    const { questionId } = req.body;
    const newQuestionId = new mongoDB.ObjectId(questionId);
    const findQuestion = await questions.findOne({ _id: newQuestionId });
    console.log("Found question:", findQuestion ? findQuestion._id : "Not found");
    if (!findQuestion?._id)
      throw new Error("No Questions to delete with that QuestionId");
    const data = await questions.deleteOne({ _id: findQuestion._id });
    console.log("Delete result:", data);
    await test.updateMany(
      { questions: { $in: [questionId, new mongoDB.ObjectId(questionId)] } },
      { $pull: { questions: { $in: [questionId, new mongoDB.ObjectId(questionId)] } } }
    );
    res.send({
      msg: "question deleted successfully",
      deletedFromQuestionCollection: data,
    });
  } catch (error) {
    console.log("Error in deleteQuestion:", error.message);
    res.send({ err: error.message });
  }
}

// 17. ADD CATEGORY
async function addCategory(req, res) {
  const { categories } = connectTodb(req.tenantDB);
  try {
    const { name, type } = req.body;
    const checkCategory = await categories.findOne({
      $and: [{ name }, { type }],
    });
    if (checkCategory) {
      return res.json({ msg: "Category already present", id: checkCategory });
    }
    const data = await categories.insertOne({ name, type });
    const newData = await categories.findOne({
      _id: new mongoDB.ObjectId(data.insertedId.toHexString()),
    });
    res.json({ msg: "Category Added successfully", id: newData });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 18. DELETE CATEGORY
async function deleteCategory(req, res) {
  const { categories } = connectTodb(req.tenantDB);
  try {
    const { categoryId } = req.body;
    const catId = new mongoDB.ObjectId(categoryId);
    const data = await categories.findOneAndDelete({ _id: catId });
    res.json({ msg: "Category Deleted successfully", data });
  } catch (error) {
    res.send({ err: error.message });
  }
}

async function addLanguage(req, res) {
  const { languages } = connectTodb(req.tenantDB);
  try {
    const { name, type } = req.body;
    const checkLanguage = await languages.findOne({
      $and: [{ name }, { type }],
    });
    if (checkLanguage) {
      return res.json({ msg: "Language already present", id: checkLanguage });
    }
    const data = await languages.insertOne({ name, type });
    const newData = await languages.findOne({
      _id: new mongoDB.ObjectId(data.insertedId.toHexString()),
    });
    res.json({ msg: "Language Added successfully", id: newData });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 20. DELETE LANGUAGE
async function deleteLanguage(req, res) {
  const { languages } = connectTodb(req.tenantDB);
  try {
    const { LangId } = req.body;
    const catId = new mongoDB.ObjectId(LangId);
    const data = await languages.findOneAndDelete({ _id: catId });
    res.json({ msg: "Language Deleted successfully", data });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 21. SEND TEST ACCESS MAIL
async function sendTestAccessMail(req, res) {
  try {
    const { mailOptions } = req.body;
    const transporter = nodemailer.createTransport({
      service: "Gmail",
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.support_mail,
        pass: process.env.support_pass,
      },
      maxConnections: 5,
      maxMessages: 50,
      rateLimit: 10,
    });
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) throw new Error(err.message);
      res.send({ data: info });
    });
  } catch (error) {
    res.send({ err: error.message });
  }
}

async function sendBulkTestAccessMailBatched(req, res) {
  try {
    const { studentIds, mailTemplate, batchSize = 10 } = req.body;

    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).send({ err: "studentIds array is required" });
    }

    const { student } = connectTodb(req.tenantDB);

    // Fetch all students
    const students = await student
      .find({
        _id: { $in: studentIds.map((id) => new ObjectId(id)) },
      })
      .toArray();

    if (students.length === 0) {
      return res.status(404).send({ err: "No students found" });
    }

    const transporter = nodemailer.createTransport({
      service: "Gmail",
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.support_mail,
        pass: process.env.support_pass,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 50,
      rateLimit: 10,
    });

    // Split into batches
    const batches = [];
    for (let i = 0; i < students.length; i += batchSize) {
      batches.push(students.slice(i, i + batchSize));
    }

    const successful = [];
    const failed = [];

    // Process each batch sequentially
    for (const batch of batches) {
      const batchPromises = batch.map((studentData) => {
        const mailOptions = {
          from: process.env.support_mail,
          to: studentData.email,
          subject: mailTemplate.subject || "KYC Link",
          text: mailTemplate.text?.replace("{{email}}", studentData.email),
          html: mailTemplate.html
            ?.replace(/{{email}}/g, studentData.email)
            .replace(/{{name}}/g, studentData.name || studentData.email),
        };

        return transporter
          .sendMail(mailOptions)
          .then((info) => ({ success: true, email: studentData.email, info }))
          .catch((error) => ({
            success: false,
            email: studentData.email,
            error: error.message,
          }));
      });

      const batchResults = await Promise.all(batchPromises);

      batchResults.forEach((result, index) => {
        const studentId = batch[index]._id.toString();
        if (result.success) {
          successful.push({
            email: result.email,
            messageId: result.info.messageId,
            studentId,
          });
        } else {
          failed.push({
            email: result.email,
            error: result.error,
            studentId,
          });
        }
      });

      // Small delay between batches (1 second)
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    res.send({
      msg: "Bulk email sending completed",
      summary: {
        total: students.length,
        successful: successful.length,
        failed: failed.length,
        batches: batches.length,
      },
      successful,
      failed,
    });
  } catch (error) {
    res.status(500).send({ err: error.message });
  }
}

// 22. SAVE TEST PROGRESS
async function saveTestProgress(req, res) {
  const { test, student, randomStudent, progress } = connectTodb(req.tenantDB);
  try {
    const { studentId, testId } = req.body;

    let newStudentId = null;
    let newTestId = null;

    try {
      newStudentId = new mongoDB.ObjectId(studentId);
    } catch (_) {}

    try {
      newTestId = new mongoDB.ObjectId(testId);
    } catch (_) {}

    const findStudent = newStudentId
      ? await student.findOne({ _id: newStudentId })
      : await student.findOne({ _id: studentId })
        ? await student.findOne({ _id: studentId })
        : null;

    let findTest = null;
    if (newTestId) {
      findTest = await test.findOne({ _id: newTestId });
    } else {
      findTest = await test.findOne({ _id: testId }) || await test.findOne({ _id: new mongoDB.ObjectId(testId) }) || null;
    }

    if (!findStudent) {
      console.warn("saveTestProgress: student not found", { studentId });
    }

    if (!findTest) {
      console.warn("saveTestProgress: test not found", { testId });
    }

    const payload = {
      ...req.body,
      studentId: studentId?.toString(),
      testId: testId?.toString(),
      createdAt: req.body?.createdAt || new Date().toISOString(),
    };

    const data = await progress.insertOne(payload);

    if (findStudent?._id) {
      await student.updateOne(
        { _id: findStudent._id },
        { $push: { progress: data.insertedId.toString() } }
      );
    }

    res.json({
      msg: findTest?.title ? `${findTest.title} test results updated successfully` : "Test results updated successfully",
      progressId: data.insertedId.toString(),
    });
  } catch (error) {
    res.status(500).send({ err: error.message });
  }
}

// 23. UPDATE PROGRESS
async function updateProgress(req, res) {
  const { progress } = connectTodb(req.tenantDB);
  try {
    const { progressId } = req.params;
    const covId = new mongoDB.ObjectId(progressId);
    const findProgress = await progress.findOne({ _id: covId });
    if (!findProgress?._id)
      throw new Error("No progress with that id to update");
    const updatedData = await progress.updateOne(
      { _id: findProgress?._id },
      { $set: req.body }
    );
    res.json({ msg: "progress updated successfully", data: updatedData });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 24. ADD ATTEMPTS TO STUDENT
async function addAttempts(req, res) {
  const { student } = connectTodb(req.tenantDB);
  try {
    const { studentId } = req.params;
    const sCovId = new mongoDB.ObjectId(studentId);
    const sData = await student.findOne({ _id: sCovId });
    if (!sData?._id) throw new Error("No Student With that is to update");
    const updatedData = await student.updateOne(
      { _id: sData?._id },
      { $set: { attemptedProgress: req.body.attemptedProgress } }
    );
    res.json({
      msg: "attemptedProgress updated successfully",
      data: updatedData,
    });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 25. CREATE COMPREHENSION QUESTION
async function createCompQuestion(req, res) {
  const { test, comprehensionQuestions } = connectTodb(req.tenantDB);
  try {
    const { testId } = req.params;
    const findTest = await test.findOne({
      _id: new mongoDB.ObjectId(testId),
    });
    if (!findTest)
      throw new Error(
        "No test with that id to create comprehension qwuestrion"
      );
    const data = await comprehensionQuestions.insertOne({
      questionType: req.body.questionType,
      comprehensionText: req.body.comprehensionText,
      resources: req.body.resources,
    });
    await test.updateOne(
      { _id: findTest?._id },
      { $push: { questions: data.insertedId.toString() } }
    );
    res.json({
      msg: "Comprehension Added Successfully",
      id: data.insertedId.toString(),
    });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 26. UPDATE COMPREHENSION QUESTION
async function updateCompQuestion(req, res) {
  const { comprehensionQuestions } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const covId = new mongoDB.ObjectId(id);
    const findCompquestion = await comprehensionQuestions.findOne({
      _id: covId,
    });
    if (!findCompquestion)
      throw new Error("No Comprehension Question To update");
    const data = await comprehensionQuestions.updateOne(
      { _id: findCompquestion?._id },
      { $set: req.body }
    );
    res.send({
      msg: "Comprehension updated successfully",
      updatedQuestionData: data,
    });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 27. ADD QUESTION TO COMPREHENSION
async function addQuestionToComprehension(req, res) {
  const { comprehensionQuestions, questions } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const covId = new mongoDB.ObjectId(id);
    const findCompquestion = await comprehensionQuestions.findOne({
      _id: covId,
    });
    if (!findCompquestion)
      throw new Error("No Comprehension Question To Add Questions");
    const questionAddedData = await questions.insertOne(req.body);
    await comprehensionQuestions.updateOne(
      { _id: findCompquestion._id },
      { $push: { questionContentArr: questionAddedData.insertedId.toString() } }
    );
    res.json({ msg: "Question Added Successfully", ...questionAddedData });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 28. DELETE COMPREHENSION QUESTION
async function deleteCompQuestion(req, res) {
  const { test, comprehensionQuestions } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const { testId } = req.body;
    const covidTest = new mongoDB.ObjectId(testId);
    const findTest = await test.findOne({ _id: covidTest });
    if (!findTest)
      throw new Error(
        "No test with that id to create comprehension qwuestrion"
      );
    const covId = new mongoDB.ObjectId(id);
    const findCompquestion = await comprehensionQuestions.findOne({
      _id: covId,
    });
    if (!findCompquestion)
      throw new Error("No Comprehension Question To delete");
    const data = await comprehensionQuestions.deleteOne({
      _id: findCompquestion?._id,
    });
    await test.updateOne({ _id: findTest?._id }, { $pull: { questions: id } });
    res.json({ msg: "Comprehension deleted successfully", ...data });
  } catch (error) {
    res.send({ err: error.message });
  }
}

// 29. DELETE QUESTION FROM COMPREHENSION
async function deleteQuestionFromComp(req, res) {
  const { comprehensionQuestions, questions } = connectTodb(req.tenantDB);
  try {
    const { questionId } = req.body;
    const { id } = req.params;
    const covId = new mongoDB.ObjectId(id);
    const covIdQ = new mongoDB.ObjectId(questionId);
    const findCompquestion = await comprehensionQuestions.findOne({
      _id: covId,
    });
    const findquestion = await questions.findOne({ _id: covIdQ });
    if (!findCompquestion)
      throw new Error("No Comprehension Question To Add Questions");
    if (!findquestion) throw new Error("No Questions To Delete");
    const deleteingQuestion = await questions.deleteOne({
      _id: findquestion?._id,
    });
    await comprehensionQuestions.updateOne(
      { _id: covId },
      { $pull: { questionContentArr: questionId } }
    );
    res.json({ msg: "Question deleted successfully", ...deleteingQuestion });
  } catch (error) {
    res.send({ err: error.message });
  }
}

const getResultsData = async (req, res) => {
  const { progress } = connectTodb(req.tenantDB);
  try {
    const { id } = req.params;
    const data = await progress.findOne({ _id: new ObjectId(id) });

    if (!data) throw new Error("Progress Not Found");

    res.status(200).json({ msg: "successful", data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

const getRecentTestResults = async (req, res) => {
  const { progress, test } = connectTodb(req.tenantDB);
  try {
    const { studentId } = req.params;
    const progressData = await progress
      .find({ studentId })
      .sort({ _id: -1 })
      .limit(3)
      .toArray();

    // Attach basic test details like title to each progress record
    const populatedData = await Promise.all(
      progressData.map(async (p) => {
        let testInfo = null;
        if (p.testId) {
          try {
            const { ObjectId } = require("mongodb");
            testInfo = await test.findOne(
              { _id: new ObjectId(p.testId) },
              { projection: { title: 1, category: 1, access: 1 } }
            );
          } catch (e) {
            console.error("Error populating test for progress", e.message);
          }
        }
        return { ...p, testDetails: testInfo };
      })
    );

    res.status(200).json({ msg: "successful", data: populatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports = {
  searchQuestions,
  searchTest,
  searchStudent,
  addTest,
  updateTest,
  blockStudentFromTest,
  unblockStudentFromTest,
  deleteTest,
  changeQuestionsOrder,
  addQuestion,
  getQuestionLength,
  bulkUploadQuestions,
  updateQuestion,
  addQuestionToTest,
  removeQuestionFromTest,
  deleteQuestion,
  addCategory,
  deleteCategory,
  addLanguage,
  deleteLanguage,
  sendTestAccessMail,
  saveTestProgress,
  updateProgress,
  addAttempts,
  createCompQuestion,
  updateCompQuestion,
  addQuestionToComprehension,
  deleteCompQuestion,
  deleteQuestionFromComp,
  getResultsData,
  bulkUploadQuestionsToBank,
  addQuestionToBank,
  sendBulkTestAccessMailBatched,
  getRecentTestResults,
};
