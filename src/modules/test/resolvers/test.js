// const {
//   test,
//   questions,
//   student,
//   categories,
//   languages,
//   comprehensionQuestions,
// } = require("../mongoDB");

const mongoDB = require("mongodb");
const { ObjectId } = require("mongodb");
const { connectTodb } = require("../../../shared/db/connection");
// const cors = require("cors");
// const express = require("express");

// const app = express();
// app.use(cors());

function buildAccessFilterForStudent(student) {
  return {
    $or: [
      // access.type: "all"
      { "access.type": "all" },

      // access.type: "department" and student's dept in access.department
      {
        "access.type": "department",
        "access.department": { $in: [student.department.toString()] },
      },

      // access.type: "batch" and student's yearOfPassing in access.yearOfPassing
      {
        "access.type": "batch",
        "access.yearOfPassing": { $in: [student.yearOfPassing] },
      },

      // access.type: "department_batch" with student's dept and yearOfPassing
      {
        "access.type": "department_batch",
        "access.department": { $in: [student.department.toString()] },
        "access.yearOfPassing": { $in: [student.yearOfPassing] },
      },

      // access.type: "student" and student's _id in access.students
      {
        "access.type": "student",
        "access.students": { $in: [student._id.toString()] },
      },
    ],
  };
}

const date = new Date();
const resolvers = {
  Query: {
    tests: async (
      _,
      {
        cursor,
        limit,
        category: testCategory,
        status,
        language,
        origin,
        testEvaluationType,
        studentId
      },
      { tenantDB } // assuming studentId is provided in context
    ) => {
      try {
        const { test, student } = connectTodb(tenantDB);

        let newLimit = 10;
        if (limit && limit !== null) newLimit = parseInt(limit);

        // Base query for cursor pagination
        let baseQuery = cursor ? { _id: { $gt: new ObjectId(cursor) } } : {};

        // Add testEvaluationType filter if specified
        if (testEvaluationType === "Manual") {
          baseQuery = { $and: [baseQuery, { testEvaluationType: "Manual" }] };
        }

        // If origin is 'student', fetch student document and add access filter
        if (origin === "student") {
          if (!studentId) {
            throw new Error("Student ID is required for student origin");
          }

          const studentData = await student.findOne({
            _id: new ObjectId(studentId),
          });
          if (!student) {
            throw new Error("Student not found");
          }

          // Compose access filter based on student
          const accessFilter = buildAccessFilterForStudent(studentData);

          // Start query with baseQuery, include access filter and status active
          baseQuery = {
            $and: [baseQuery, { status: "active" }, accessFilter],
          };
        }

        // Handle category filtering with aggregation if category specified
        if (testCategory && testCategory !== null) {
          const pipeline = [
            { $match: baseQuery },
            {
              $addFields: {
                categoryIds: {
                  $map: { input: "$category", in: { $toObjectId: "$$this" } },
                },
              },
            },
            {
              $lookup: {
                from: "categories",
                localField: "categoryIds",
                foreignField: "_id",
                as: "categoryMatches",
              },
            },
            {
              $match: {
                "categoryMatches.name": testCategory,
              },
            },
            { $limit: newLimit + 1 },
          ];

          let aggregatedCursor = test.aggregate(pipeline);
          let arr = await aggregatedCursor.toArray();

          // Determine if more pages exist
          let data;
          if (arr.length > newLimit) {
            data = arr.slice(0, -1);
          } else {
            data = arr;
          }
          const hasMore = arr.length > newLimit;

          return { tests: data, pageInfo: { hasNextPage: hasMore } };
        }

        // Additional filters for status and language
        if (status && status !== null) {
          baseQuery = { $and: [baseQuery, { status }] };
        }

        if (language && language !== null) {
          baseQuery = {
            $and: [baseQuery, { language: { $elemMatch: { language } } }],
          };
        }

        // Fetch data with final query and limit
        const data = await test.find(baseQuery).limit(newLimit).toArray();

        let hasMore = data.length === newLimit;
        if (hasMore) {
          let nextQuery = { _id: { $gt: data[data.length - 1]._id } };
          if (origin === "student") {
            nextQuery = {
              $and: [
                { _id: { $gt: data[data.length - 1]._id } },
                { status: "active" },
                buildAccessFilterForStudent(
                  await student.findOne({ _id: new ObjectId(studentId) })
                ),
              ],
            };
          }
          const checkData = await test.find(nextQuery).limit(1).toArray();
          hasMore = checkData.length > 0;
        }

        return { tests: data, pageInfo: { hasNextPage: hasMore } };
      } catch (error) {
        return { err: error.message };
      }
    },
    test: async (_, args, { tenantDB }) => {
      try {
        const { test } = connectTodb(tenantDB);
        const id = new mongoDB.ObjectId(args.id);
        const data = await test.findOne({ _id: id });
        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
  },

  TestUnion: {
    __resolveType(obj, context, info) {
      if (obj._id) {
        return "Test";
      }
      if (obj.err) {
        return "err";
      }
      return null;
    },
  },

  Test: {
    questions: async (parent, _, { tenantDB }) => {
      if (!parent.questions) return [];
      const { questions, comprehensionQuestions } = connectTodb(tenantDB);
      const ids = parent.questions;

      let res = [];
      try {
        const questionData = await Promise.all(
          ids.map(async (questionId) => {
            const question = await questions.findOne({
              _id: new mongoDB.ObjectId(questionId),
            });
            const comprehensionQuestion = await comprehensionQuestions.findOne({
              _id: new mongoDB.ObjectId(questionId),
            });

            if (question) {
              return { __typename: "Questions", ...question };
            }
            if (comprehensionQuestion) {
              return {
                __typename: "ComprehensionQuestions",
                ...comprehensionQuestion,
              };
            }
            return null;
          })
        );

        const filteredQuestionData = questionData.filter((q) => q !== null);

        return filteredQuestionData;
      } catch (error) {
        return { err: error.message };
      }
    },
    enrolledStudents: async (parent, _, { tenantDB }) => {
      if (!parent.enrolledStudents) return [];
      const { student } = connectTodb(tenantDB);
      const ids = parent.enrolledStudents;
      let res = [];
      try {
        for (c of ids) {
          const id = new mongoDB.ObjectId(c);
          const data = await student.findOne({ _id: id });

          res.push(data);
        }
      } catch (error) {
        return { err: error.message };
      }

      return res;
    },
    blockedStudents: async (parent, _, { tenantDB }) => {
      if (!parent.blockedStudents) return [];
      const { student } = connectTodb(tenantDB);
      const ids = parent.blockedStudents;
      let res = [];
      try {
        for (c of ids) {
          const id = new mongoDB.ObjectId(c);
          const data = await student.findOne({ _id: id });

          res.push(data);
        }
        return res;
      } catch (error) {
        return { err: error.message };
      }
    },

    category: async (parent, _, { tenantDB }) => {
      if (!Array.isArray(parent.category) || !parent.category) return [];
      const { categories } = connectTodb(tenantDB);
      const ids = parent.category;
      let res = [];
      try {
        for (c of ids) {
          if (!c) break;
          const id = new mongoDB.ObjectId(c);
          const data = await categories.findOne({ _id: id });

          res.push(data);
        }
      } catch (error) {
        return res;
      }
      return res;
    },
    language: async (parent, _, { tenantDB }) => {
      if (!Array.isArray(parent.language) || !parent.language) return [];
      const { languages } = connectTodb(tenantDB);
      const ids = parent.language;
      let res = [];
      try {
        for (c of ids) {
          if (!c) break;
          const id = new mongoDB.ObjectId(c);
          const data = await languages.findOne({ _id: id });

          res.push(data);
        }
      } catch (error) {
        return { err: error.message };
      }
      return res;
    },
  },
};

module.exports = resolvers;
