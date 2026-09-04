require("dotenv").config({
  path: "../../.env",
});

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const mongoDB = require("mongodb");
const {
  getShortParaScore,
  getSingleChoiceScore,
  getTrueFalseScore,
  getMultipleChoiceScore,
} = require("./utils/scoreCalculation");
const { default: axios } = require("axios");
const { graphqlUrl } = require("./utils/apiUrls");
const SingleTestQuery = require("./utils/gqlTestQuery");
const { getTenantDB } = require("../../../shared/db/connection");
const { organisation, skillsCollection, jobAssessmentProgressCollection } = require("../../../shared/db/connection").getGlobalCollections();
const jwt = require("jsonwebtoken");
const { connectTodb } = require("../../../shared/db/connection");

// Standalone server creation moved to bottom
module.exports = function setupJobSocketService(io, app) {

// ===== Register middleware ONCE, UP FRONT =====
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error: token missing"));

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return next(new Error("Authentication error: invalid token"));
    }

    const orgId = decoded.orgId;
    if (!orgId)
      return next(new Error("Authentication error: orgId not in token"));

    const orgRecord = await organisation.findOne({ orgId });
    if (!orgRecord) return next(new Error("Organization not found"));

    socket.tenantDB = await getTenantDB(orgId);
    socket.userID = decoded.userID;
    socket.email = decoded.email;
    socket.roles = Array.isArray(decoded.roles)
      ? decoded.roles
      : [decoded.roles];
    socket.isAdmin = socket.roles.includes("admin");
    socket.orgId = orgId;
    socket.token = token;

    next();
  } catch (err) {
    console.error("Socket auth error:", err);
    next(new Error("Internal server error"));
  }
});

// ===== Register connection and event handlers ONCE at the root =====
io.on("connection", (socket) => {

  socket.on("newUser", async (userId) => {
    try {
      const { student } = connectTodb(socket.tenantDB);
      const covId = new mongoDB.ObjectId(userId);
      const findUser = await student.findOne({ _id: covId });

      if (findUser) {
        await student.updateOne(
          { _id: findUser._id },
          { $set: { ConnectedSocketId: socket.id } }
        );
      }

      socket.userId = userId;

      const findUser1 = await student.findOne({ _id: covId });
      if (!findUser1) {
        return socket.emit("error", { message: "Student Not Found" });
      }

      io.to(socket.id)
        .to(findUser1.ConnectedSocketId)
        .emit("userUpdates", {
          msg: `${findUser1._id} updated successfully`,
          id: findUser1._id,
          socketId: socket.id,
        });
    } catch (error) {
      console.error("newUser event error:", error);
      socket.emit("error", { message: "Failed to process newUser event" });
    }
  });

  socket.on("jobAssessmentStarted", async (data) => {
    try {
      const { student } = connectTodb(socket.tenantDB);
      const covId = new mongoDB.ObjectId(data.userId);
      const findUser = await student.findOne({ _id: covId });

      if (findUser) {
        await student.updateOne(
          { _id: findUser._id },
          { $set: { jobAssessmentSocketId: socket.id } }
        );
        io.to(socket.id)
          .to(findUser.ConnectedSocketId)
          .emit("jobAssessmentStartedStudent", data);
      }
    } catch (error) {
      console.error("jobAssessmentStarted event error:", error);
      socket.emit("error", {
        message: "Failed to process jobAssessmentStarted event",
      });
    }
  });

  socket.on("jobAssessmentEnded", async (data) => {
    try {
      const { student, questions, jobAssessments, job, assignedJob } = connectTodb(socket.tenantDB);
      const { userId, assessmentId, jobId, response } = data;
      const covId = new mongoDB.ObjectId(userId);

      const findUser = await student.findOne({ _id: covId });
      if (!findUser) return socket.emit("error", { message: "User not found" });

      await student.updateOne(
        { _id: findUser._id },
        { $set: { jobAssessmentEndedSocketId: socket.id } }
      );

      // Get job details to determine source type
      let jobDetails = null;
      let sourceType = "local";
      let sourceOrgId = socket.orgId;

      // First try to find job locally
      jobDetails = await job.findOne({ _id: new mongoDB.ObjectId(jobId) });

      if (!jobDetails) {
        // If not found locally, check assignedJob collection
        const assignedJobDoc = await assignedJob.findOne({ jobId });
        if (assignedJobDoc) {
          sourceType = "assigned";
          sourceOrgId = assignedJobDoc.companyOrgId;

          // Get job details from company's DB
          const externalTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
          const externalCollections = connectTodb(externalTenantDB);
          jobDetails = await externalCollections.job.findOne({
            _id: new mongoDB.ObjectId(jobId)
          });
        }
      }

      if (!jobDetails) {
        return socket.emit("error", { message: "Job not found" });
      }

      // Get assessment data
      let assessment = null;
      let skillsData = [];

      // First try local jobAssessments
      assessment = await jobAssessments.findOne({ _id: new mongoDB.ObjectId(assessmentId) });

      // If not found locally, search in external orgs based on source
      if (!assessment && sourceType === "assigned") {
        const externalTenantDB = await getTenantDB(sourceOrgId);
        const externalCollections = connectTodb(externalTenantDB);
        assessment = await externalCollections.jobAssessments.findOne({
          _id: new mongoDB.ObjectId(assessmentId)
        });

        // Get skills data from external org
        if (assessment && assessment.skills && Array.isArray(assessment.skills)) {
          const skillIds = assessment.skills.map(s => new mongoDB.ObjectId(s.skillId));
          skillsData = await externalCollections.skills.find({ _id: { $in: skillIds } }).toArray();
        }
      } else if (assessment) {
        // Get skills data from local skills collection
        if (assessment.skills && Array.isArray(assessment.skills)) {
          const skillIds = assessment.skills.map(s => new mongoDB.ObjectId(s.skillId));
          skillsData = await skillsCollection.find({ _id: { $in: skillIds } }).toArray();
        }
      }

      if (!assessment) {
        return socket.emit("error", { message: "Assessment not found" });
      }

      // Get questions data
      const questionIds = Object.keys(response);
      const questionsData = questionIds.map((e) => {
        const quesIdObj = new mongoDB.ObjectId(e);
        return questions.findOne({ _id: quesIdObj });
      });

      const questionData = await Promise.allSettled(questionsData);
      const answersArray = questionData.map((e) => ({
        answer: e.value.answer,
        scoreSettings: e.value.scoreSettings,
        _id: e.value._id,
      }));

      let finalScore = 0,
        correctQues = 0,
        incorrectQues = 0,
        unattemptedQues = 0,
        totalTimeTaken = 0,
        notAnswered = 0,
        averageTimeTaken = 0;

      // Calculate scores for each question
      answersArray.forEach((e) => {
        const questionType = Object.keys(e.answer)[0];

        if (
          data.response[e._id].answers == undefined ||
          data.response[e._id].answers == "undefined" ||
          data.response[e._id].answers == null
        ) {
          if (data.response[e._id].timeTaken == undefined) {
            unattemptedQues++;
            data.response[e._id].status = "unattempted";
            return;
          } else {
            totalTimeTaken += data.response[e._id].timeTaken;
            notAnswered++;
            data.response[e._id].status = "notanswered";
            return;
          }
        }

        if (data.response[e._id].answers.length == 0) {
          if (data.response[e._id].timeTaken) {
            totalTimeTaken += data.response[e._id].timeTaken;
            notAnswered++;
            data.response[e._id].status = "notanswered";
            return;
          } else {
            notAnswered++;
            data.response[e._id].status = "notanswered";
            return;
          }
        }

        totalTimeTaken += data.response[e._id].timeTaken;
        let correctQScore = 0,
          negativeQScore = 0,
          bonusQScore = 0,
          correctQFlag;

        // Calculate score based on question type
        switch (questionType) {
          case "shortPara": {
            let { correctScore, negativeScore, correctFlag } =
              getShortParaScore(e, data.response[e._id]);
            correctQScore = correctScore;
            negativeQScore = negativeScore;
            correctQFlag = correctFlag;
            finalScore += +correctScore + +negativeScore;
            data.response[e._id] = {
              ...data.response[e._id],
              correctScore,
              negativeScore,
              correctFlag,
            };
            break;
          }

          case "singleChoice": {
            let { correctScore, negativeScore, correctFlag } =
              getSingleChoiceScore(e, data.response[e._id]);
            correctQScore = correctScore;
            negativeQScore = negativeScore;
            correctQFlag = correctFlag;
            finalScore += +correctScore + +negativeScore;
            data.response[e._id] = {
              ...data.response[e._id],
              correctScore,
              negativeScore,
              correctFlag,
            };
            break;
          }

          case "multipleChoice": {
            let { correctScore, negativeScore, bonusScore, correctFlag } =
              getMultipleChoiceScore(e, data.response[e._id]);
            finalScore += +correctScore + +negativeScore + +bonusScore;
            correctQScore = correctScore;
            negativeQScore = negativeScore;
            bonusQScore = bonusScore;
            correctQFlag = correctFlag;
            data.response[e._id] = {
              ...data.response[e._id],
              correctScore,
              negativeScore,
              bonusScore,
              correctFlag,
            };
            break;
          }

          case "truefalse": {
            let { correctScore, negativeScore, correctFlag } =
              getTrueFalseScore(e, data.response[e._id]);
            correctQScore = correctScore;
            negativeQScore = negativeScore;
            correctQFlag = correctFlag;
            finalScore += +correctScore + +negativeScore;
            data.response[e._id] = {
              ...data.response[e._id],
              correctScore,
              negativeScore,
              correctFlag,
            };
            break;
          }
        }

        if (data.response[e._id].answers.length) {
          if (correctQFlag) {
            correctQues++;
            data.response[e._id].status = "correct";
          } else {
            if (correctQFlag == undefined) {
              notAnswered++;
              data.response[e._id].status = "notanswered";
            }
            incorrectQues++;
            data.response[e._id].status = "incorrect";
          }
        }
      });

      // Calculate final statistics
      data.scoreData = {};
      if (Object.keys(data.response).length > 0) {
        averageTimeTaken = totalTimeTaken / Object.keys(data.response).length;
        unattemptedQues += answersArray.length - Object.keys(data.response).length;
      }

      data.scoreData.finalScore = +finalScore;
      data.scoreData.correctQues = +correctQues;
      data.scoreData.incorrectQues = +incorrectQues;
      data.scoreData.unattemptedQues = +unattemptedQues;
      data.scoreData.totalTimeTaken = +totalTimeTaken;
      data.scoreData.averageTimeTaken = +averageTimeTaken;
      data.scoreData.notAnswered = +notAnswered;

      // Save job assessment progress to mainDB
      let progData = "";
      try {
        const newStudentId = new mongoDB.ObjectId(findUser?._id?.toString());
        const newAssessmentId = new mongoDB.ObjectId(assessmentId);
        const newJobId = new mongoDB.ObjectId(jobId);

        // Save to mainDB with source information
        progData = await jobAssessmentProgressCollection.insertOne({
          ...data,
          studentId: findUser?._id?.toString(),
          studentOrgId: socket.orgId, // Student's org ID
          assessmentId: assessmentId,
          jobId: jobId,
          assessmentData: assessment,
          skillsData: skillsData,
          jobDetails: jobDetails,
          sourceType: sourceType, // "local" or "assigned"
          sourceOrgId: sourceOrgId, // Where the job/assessment came from
          createdAt: new Date().getTime(),
        });

        if (findUser?._id) {
          await student.updateOne(
            { _id: findUser?._id },
            { $push: { jobAssessmentProgress: progData.insertedId.toString() } }
          );
        }
      } catch (error) {}

      io.to(socket.id)
        .to(findUser.ConnectedSocketId)
        .emit("jobAssessmentEndedPortal", {
          ...data,
          progData: progData?.insertedId,
          assessmentData: assessment,
          skillsData: skillsData,
          jobDetails: jobDetails,
          sourceType: sourceType,
        });
    } catch (error) {
      console.error("jobAssessmentEnded event error:", error);
      socket.emit("error", { message: "Failed to process jobAssessmentEnded event" });
    }
  });

  socket.on("disconnect", () => {});

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

};

if (require.main === module) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: "*" });
  const port = 8223; // Different port for job assessment socket

  module.exports(io, app);

  httpServer.listen(port, () => {}
  );
}
