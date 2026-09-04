// const {

//     instructor,

//   } = require("../mongoDB");

const mongoDB = require("mongodb");

const date = new Date();
const resolvers = {
  Query: {
    instructors: async () => {
      try {
        const data = await instructor.find({}).toArray();
        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
    instructor: async (_, args) => {
      try {
        const id = new mongoDB.ObjectId(args.id);
        const data = await instructor.findOne({ _id: id });
        return data;
      } catch (error) {
        return { err: error.message };
      }
    },
  },

  InstructorUnion: {
    __resolveType(obj, context, info) {
      if (obj._id) {
        return "Instructor";
      }
      if (obj.err) {
        return "err";
      }
      return null;
    },
  },
};

module.exports = resolvers;
