const { ObjectId } = require("mongodb");
const nodemailer = require("nodemailer");
const { connectTodb } = require("../../../shared/db/connection");
const { getTenantDB } = require("../../../shared/db/connection");
const mongoDB = require("mongodb");
// === Utility: Safe ObjectId conversion ===
function convertToMId(id) {
  try {
    return new ObjectId(id);
  } catch (error) {
    return id;
  }
}

// === Success Response ===
function successRes(res, obj) {
  return res.status(200).json(obj);
}

// === Error Response ===
function errorRes(res, obj) {
  return res.status(500).json(obj);
}

// === Get All Questions With Pagination ===
async function getAllQuestionsData(props, orgDb) {
  try {
    const { questions, questionTranslations, answers, answerTranslations } =
      connectTodb(orgDb);
    const { cursor, limit } = props;

    let realCursor = cursor;
    if (
      realCursor === null ||
      realCursor === undefined ||
      realCursor === "undefined" ||
      realCursor === "null" ||
      realCursor === ""
    ) {
      realCursor = null;
    }

    const covLimit = Number(limit ?? 10);
    const pipeline = [
      ...(realCursor
        ? [
          {
            $match: {
              _id: { $gt: new ObjectId(realCursor) },
            },
          },
        ]
        : []),
      { $limit: covLimit + 1 }, // Fetch one extra to check hasNext
    ];

    const questionsData = await questions.aggregate(pipeline).toArray();

    let hasNext = false;
    if (questionsData.length > covLimit) {
      hasNext = true;
      questionsData.pop();
    }

    const modifiedData = await Promise.all(
      questionsData.map(async (eachQuestion) => {
        // Load question translation if exists
        const translationId = eachQuestion.questionTranslations?.[0]?.id;
        const translationsData = translationId
          ? await questionTranslations.findOne({
            _id: new ObjectId(translationId),
          })
          : null;

        // Load answers
        const answerData = await answers
          .find({ questionId: eachQuestion._id.toString() })
          .toArray();

        // Load answer translations
        const resolvedAnswers = await Promise.all(
          answerData.map(async (eachAns) => {
            const answerTransData = await answerTranslations.findOne({
              solutionId: eachAns.id,
            });

            return {
              ...eachAns,
              answerTranslations: answerTransData ? [answerTransData] : [],
            };
          })
        );

        return {
          ...eachQuestion,
          questionTranslations: translationsData ? [translationsData] : [],
          answers: resolvedAnswers,
        };
      })
    );

    // Find last cursor
    const nextCursor =
      modifiedData.length > 0
        ? modifiedData[modifiedData.length - 1]._id.toString()
        : null;

    return {
      cursor: nextCursor,
      hasNext,
      data: modifiedData,
    };
  } catch (error) {
    console.error(error);
    return { error: error.message };
  }
}

// === Batch Delete Question and Related Entities ===
async function deleteQuestionsByIds(props, orgDb) {
  try {
    const { questions, questionTranslations, answers, answerTranslations, test } =
      connectTodb(orgDb);
    const { questionIds } = props; // array of string IDs

    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      throw new Error("No questionIds provided for deletion");
    }

    // Convert IDs
    const objectIds = questionIds.map((id) => new ObjectId(id));

    // Fetch related answers first
    const relatedAnswers = await answers
      .find({
        questionId: { $in: questionIds },
      })
      .toArray();

    const answerIds = relatedAnswers.map((ans) => ans.id);

    // Delete: questions, questionTranslations, answers, answerTranslations, and pull from tests
    const [
      questionsResult,
      questionTranslationsResult,
      answersResult,
      answerTranslationsResult,
      testUpdateResult,
    ] = await Promise.all([
      questions.deleteMany({ _id: { $in: objectIds } }),
      questionTranslations.deleteMany({
        questionId: { $in: questionIds },
      }),
      answers.deleteMany({ questionId: { $in: questionIds } }),
      answerTranslations.deleteMany({
        solutionId: { $in: answerIds },
      }),
      test.updateMany(
        { questions: { $in: [...questionIds, ...objectIds] } },
        { $pull: { questions: { $in: [...questionIds, ...objectIds] } } }
      ),
    ]);

    return {
      success: true,
      message: "Deletion completed",
      deletedCounts: {
        questions: questionsResult.deletedCount,
        questionTranslations: questionTranslationsResult.deletedCount,
        answers: answersResult.deletedCount,
        answerTranslations: answerTranslationsResult.deletedCount,
        testsUpdated: testUpdateResult.modifiedCount,
      },
    };
  } catch (error) {
    console.error(error);
    return { success: false, error: error.message };
  }
}

// === Nodemailer Transporter ===
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.support_mail,
    pass: process.env.support_pass,
  },
});

// === EXPORT ALL FUNCTIONS AND UTILITIES CORRECTLY! ===
module.exports = {
  convertToMId,
  successRes,
  errorRes,
  getAllQuestionsData,
  deleteQuestionsByIds,
  transporter,
};
