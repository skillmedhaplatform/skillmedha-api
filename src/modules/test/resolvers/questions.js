// const { questions, categories } = require("../mongoDB");

const mongoDB = require("mongodb");
const { connectTodb } = require("../../../shared/db/connection");
// const cors = require("cors");
// const express = require("express")

// const app = express()
// app.use(cors());

const date = new Date();
const resolvers = {
  Query: {
    questions: async (
      _,
      { cursor, limit, category: questionCategory, questionType },
      { tenantDB }
    ) => {
      try {
        const { questions, categories } = connectTodb(tenantDB);
        let newLimit = limit;
        if (limit && limit !== null && typeof limit == "number")
          newLimit = parseInt(limit);
        let query = cursor
          ? { _id: { $gt: new mongoDB.ObjectId(cursor) } }
          : {};
        let data = await questions.find(query).limit(newLimit).toArray();
        if (questionCategory && questionCategory !== null) {
          const filterIds = await categories
            .find({ name: questionCategory })
            .toArray();

          const categoryIds = filterIds.map((category) =>
            category._id.toString()
          );

          data = await questions
            .find({
              $and: [query, { questionCategory: { $in: categoryIds } }],
            })
            .limit(newLimit)
            .toArray();
        }
        if (questionType && questionType !== null) {
          data = await questions
            .find({ $and: [query, { questionType: questionType }] })
            .limit(newLimit)
            .toArray();
        }

        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
    question: async (_, args, { tenantDB }) => {
      try {
        const { questions } = connectTodb(tenantDB);
        const id = new mongoDB.ObjectId(args.id);

        const data = await questions.findOne({ _id: id });

        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
  },

  QuestionsUnion: {
    __resolveType(obj, context, info) {
      if (obj._id) {
        return "Questions";
      }
      if (obj.err) {
        return "err";
      }
      return null;
    },
  },
  Questions: {
    questionCategory: async (parent, _, { tenantDB }) => {
      const { categories } = connectTodb(tenantDB);
      if (!parent.questionCategory) return [];

      const ids = parent.questionCategory;
      let res = [];
      try {
        for (c of ids) {
          if (!c) break;
          const id = new mongoDB.ObjectId(c);
          const data = await categories.findOne({ _id: id });

          res.push(data);
        }
        return res;
      } catch (error) {
        return { err: error.message };
      }
    },
  },
};

module.exports = resolvers;
