const { progress, randomStudent } = require("../mongoDB");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const mongoDB = require("mongodb");
const { StudentProgress } = require("../mongoDB");
const cors = require("cors");
const express = require("express");

const app = express();
app.use(cors());

const date = new Date();

const resolvers = {
  Query: {
    randomStudents: async (_, args, { req }) => {
      try {
        const data = await randomStudent.find({}).toArray();
        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
    randomStudent: async (_, args, { req }) => {
      try {
        const id = new mongoDB.ObjectId(args._id);

        const data = await randomStudent.findOne({ _id: id });
        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
  },

  randomStudentUnion: {
    __resolveType(obj, context, info) {
      if (obj._id) {
        return "randomStudent";
      }
      if (obj.err) {
        return "err";
      }
      return null;
    },
  },

  randomStudent: {
    progress: async (parent) => {
      if (!parent.progress) return [];
      const ids = parent.progress;

      let res = [];
      try {
        for (c of ids) {
          const id = new mongoDB.ObjectId(c);
          const data = await progress.findOne({ _id: id });

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
