// const { questions, categories ,comprehensionQuestions } = require("../mongoDB");

const mongoDB = require("mongodb");
const { connectTodb } = require("../../../shared/db/connection");

const date = new Date();
const resolvers = {
  Query: {
    ComprehensionQuestions: async (parent, _, { tenantDB }) => {
      try {
        const { comprehensionQuestions } = connectTodb(tenantDB);
        const data = await comprehensionQuestions.find({}).toArray();
        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
    ComprehensionQuestion: async (_, args, { tenantDB }) => {
      try {
        const { comprehensionQuestions } = connectTodb(tenantDB);
        const id = new mongoDB.ObjectId(args.id);

        const data = await comprehensionQuestions.findOne({ _id: id });

        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
  },

  ComprehensionQuestionsUnion: {
    __resolveType(obj, context, info) {
      if (obj._id) {
        return "ComprehensionQuestions";
      }
      if (obj.err) {
        return "err";
      }
      return null;
    },
  },
  ComprehensionQuestions: {
    tags: async (parent, _, { tenantDB }) => {
      if (!parent.tags) return [];
      const { categories } = connectTodb(tenantDB);
      const ids = parent.tags;
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
    questionContentArr: async (parent, _, { tenantDB }) => {
      const { questions } = connectTodb(tenantDB);
      if (!parent.questionContentArr) return [];

      const ids = parent.questionContentArr;

      let res = [];
      try {
        for (c of ids) {
          if (!c) break;
          const id = new mongoDB.ObjectId(c);
          const data = await questions.findOne({ _id: id });

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
