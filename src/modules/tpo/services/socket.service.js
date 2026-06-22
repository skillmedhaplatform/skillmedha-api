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
const {
  organisation,
  skillsCollection,
  jobAssessmentProgressCollection,
  questions,
} = require("../../../shared/db/connection").getGlobalCollections();
const jwt = require("jsonwebtoken");
const { connectTodb } = require("../../../shared/db/connection");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");

// Standalone server creation moved to bottom
module.exports = function setupSocketService(io, app) {

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
          { $set: { ConnectedSocketId: socket.id } },
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

  socket.on("testStarted", async (data) => {
    try {
      const { student } = connectTodb(socket.tenantDB);
      const covId = new mongoDB.ObjectId(data.userId);
      const findUser = await student.findOne({ _id: covId });

      if (findUser) {
        await student.updateOne(
          { _id: findUser._id },
          { $set: { testEndedSocketId: socket.id } },
        );
        io.to(socket.id)
          .to(findUser.ConnectedSocketId)
          .emit("testStartedStudent", data);
      }
    } catch (error) {
      console.error("testStarted event error:", error);
      socket.emit("error", {
        message: "Failed to process testStarted event",
      });
    }
  });

  socket.on("testEnded", async (data) => {
    console.log(data, "data recieved");

    try {
      const { student, questions, test, progress } = connectTodb(
        socket.tenantDB,
      );
      const covId = new mongoDB.ObjectId(data.userId);

      const findUser = await student.findOne({ _id: covId });
      if (!findUser) return socket.emit("error", { message: "User not found" });

      await student.updateOne(
        { _id: findUser._id },
        { $set: { testEndedSocketId: socket.id } },
      );

      const { response } = data;
      const questionIds = Object.keys(response);
      const questionObjectIds = questionIds.map((e) => new mongoDB.ObjectId(e));
      const questionsDataFetched = await questions.find({ _id: { $in: questionObjectIds } }).toArray();

      let testData;
      try {
        const gqlRes = await axios.post(
          graphqlUrl.replace("localhost", "127.0.0.1"),
          {
            query: SingleTestQuery,
            variables: { testId: data?.testId },
          },
          {
            headers: {
              Authorization: `Bearer ${socket.token}`,
            },
          },
        );
        testData = gqlRes.data;
      } catch (err) {
        console.error("testEnded: Failed to fetch testData via GraphQL:", err.message);
        return socket.emit("error", { message: "Failed to process test results: unable to fetch test data." });
      }

      const answersArray = questionsDataFetched
        .map((doc) => ({
          answer: doc?.answer,
          scoreSettings: doc?.scoreSettings,
          _id: doc?._id,
        }))
        .filter((e) => e._id != null);
      let finalScore = 0,
        correctQues = 0,
        incorrectQues = 0,
        unattemptedQues = 0,
        totalTimeTaken = 0,
        notAnswered = 0,
        averageTimeTaken = 0;
      answersArray.forEach((e) => {
        if (!e?.answer) {
          console.warn(`Skipping question ${e._id}: answer data is missing`);
          unattemptedQues++;
          if (data.response[e._id]) {
            data.response[e._id].status = "unattempted";
          }
          return;
        }
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
        switch (questionType) {
          case "shortPara": {
            let { correctScore, negativeScore, correctFlag } =
              getShortParaScore(e, data.response[e._id]);
            correctQScore = correctScore;
            negativeQScore = negativeScore;
            correctQFlag = correctFlag;
            // let correctFlag = true;
            // if (negativeScore) {
            //   incorrectQues++;
            //   correctFlag = false;
            // } else if (correctScore) correctQues++;
            // else {
            //   if( data.response[e._id].answers.length == 0) notAnswered++;
            //   correctFlag = false;
            // }
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
            // let correctFlag = true;
            // if (negativeScore) {
            //   incorrectQues++;
            //   correctFlag = false;
            // } else if (correctScore) correctQues++;
            // else {
            //   if( data.response[e._id].answers.length == 0)
            //   notAnswered++;
            //   correctFlag = false;
            // }
            data.response[e._id] = {
              ...data.response[e._id],
              correctScore,
              negativeScore,
              correctFlag,
            };
            break;
          }

          // case "video": {
          //    let{ correctScore, negativeScore,correctFlag } = getSingleChoiceScore(
          //     e,
          //     data.response[e._id]
          //   );
          //   correctQScore = correctScore;
          //   negativeQScore = negativeScore;
          //   correctQFlag = correctFlag;
          //   finalScore += +correctScore + +negativeScore;
          //   // let correctFlag = true;
          //   // if (negativeScore) {
          //   //   incorrectQues++;
          //   //   correctFlag = false;
          //   // } else if (correctScore) correctQues++;
          //   // else {
          //   //   if( data.response[e._id].answers.length == 0)
          //   //   notAnswered++;
          //   //   correctFlag = false;
          //   // }
          //   data.response[e._id] = {
          //     ...data.response[e._id],
          //     correctScore,
          //     negativeScore,
          //     correctFlag,
          //   };
          //   break;
          // }

          // case "audio": {
          //    let{ correctScore, negativeScore,correctFlag } = getSingleChoiceScore(
          //     e,
          //     data.response[e._id]
          //   );
          //   correctQScore = correctScore;
          //   negativeQScore = negativeScore;
          //   correctQFlag = correctFlag;
          //   finalScore += +correctScore + +negativeScore;
          //   // let correctFlag = true;
          //   // if (negativeScore) {
          //   //   incorrectQues++;
          //   //   correctFlag = false;
          //   // } else if (correctScore) correctQues++;
          //   // else {
          //   //   if( data.response[e._id].answers.length == 0)
          //   //   notAnswered++;
          //   //   correctFlag = false;
          //   // }
          //   data.response[e._id] = {
          //     ...data.response[e._id],
          //     correctScore,
          //     negativeScore,
          //     correctFlag,
          //   };
          //   break;
          // }
          case "multipleChoice": {
            let { correctScore, negativeScore, bonusScore, correctFlag } =
              getMultipleChoiceScore(e, data.response[e._id]);
            finalScore += +correctScore + +negativeScore + +bonusScore;
            correctQScore = correctScore;
            negativeQScore = negativeScore;
            bonusQScore = bonusScore;

            correctQFlag = correctFlag;
            // if (negativeScore) incorrectQues++;
            // else if (!data.response[e._id]?.answers?.length) notAnswered++;
            // else if (correctFlag) correctQues++;
            // if (!correctFlag && !correctScore && correctScore !== 0)
            //   unattemptedQues++;
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

            // let correctFlag = true;
            // if (negativeScore) {
            //   incorrectQues++;
            //   correctFlag = false;
            // } else if (correctScore) correctQues++;
            // else {
            //   if( data.response[e._id].answers.length == 0) notAnswered++;
            //   correctFlag = false;
            // }
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
        } else {
          console.log(123);
        }
      });

      data.scoreData = {};
      if (Object.keys(data.response).length > 0) {
        averageTimeTaken = totalTimeTaken / Object.keys(data.response).length;
        unattemptedQues +=
          answersArray.length - Object.keys(data.response).length;
      }
      const testQuestions = testData?.data?.test?.questions;
      let totalNoOfQues = [];
      if (testQuestions && Array.isArray(testQuestions)) {
        totalNoOfQues = testQuestions.reduce(
          (acc, question) => {
            if (question?.questionType?.includes("Comprehension")) {
              const updatedContentArr = question?.questionContentArr?.map(
                (content) => ({
                  ...content,
                  qType: question?.questionType,
                }),
              );

              if (updatedContentArr) {
                updatedContentArr.forEach((e) => acc.push(e));
              }
              return acc;
            } else {
              acc.push({ ...question, qType: question?.questionType });
              return acc;
            }
          },
          [],
        );
      } else {
        console.warn("testEnded: testData questions not found, testData:", JSON.stringify(testData?.data?.test));
      }
      unattemptedQues =
        totalNoOfQues.length - Object.keys(data.response).length;
      data.scoreData.finalScore = +finalScore;
      data.scoreData.correctQues = +correctQues;
      data.scoreData.incorrectQues = +incorrectQues;
      data.scoreData.unattemptedQues = +unattemptedQues;
      data.scoreData.totalTimeTaken = +totalTimeTaken;
      data.scoreData.averageTimeTaken = +averageTimeTaken;
      data.scoreData.notAnswered = +notAnswered;
      let progData = "";
      try {
        // const { studentId, testId } = req.body;
        const newStudentId = new mongoDB.ObjectId(findUser?._id?.toString());
        const newTestId = new mongoDB.ObjectId(data?.testId);
        const findStudent = await student.findOne({ _id: newStudentId });
        const findTest = await test.findOne({ _id: newTestId });
        if (!findStudent)
          throw new Error("No student With that id to update progress");
        if (!findTest)
          throw new Error("No Test With that id to update progress");
        progData = await progress.insertOne({
          ...data,
          studentId: findUser?._id?.toString(),
          testId: data?.testId,
        });
        console.log("✅ Progress saved to DB with ID:", progData.insertedId.toString());
        if (findStudent?._id) {
          await student.updateOne(
            { _id: findStudent?._id },
            { $push: { progress: progData.insertedId.toString() } },
          );
          console.log("✅ Student progress array updated for:", findStudent._id.toString());
        }
      } catch (error) {
        console.error("❌ Failed to save progress to DB:", error.message);
      }

      console.log("Emitting testEndedtestportal to:", socket.id, findUser.ConnectedSocketId);
      io.to(socket.id)
        .to(findUser.ConnectedSocketId)
        .emit("testEndedtestportal", {
          ...data,
          progData: progData?.insertedId,
        });
      console.log("testEndedtestportal emitted successfully");
    } catch (error) {
      require('fs').appendFileSync('socket_error.log', new Date().toISOString() + ' testEnded error: ' + error.stack + '\n');
      console.error("testEnded event error:", error);
      socket.emit("error", { message: "Failed to process testEnded event" });
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
          { $set: { jobAssessmentSocketId: socket.id } },
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

  // socket.on("jobAssessmentEnded", async (data) => {
  //   try {
  //     const { student, jobAssessments, job, assignedJob } = connectTodb(
  //       socket.tenantDB
  //     );
  //     const { userId, assessmentId, jobId, response } = data;
  //     const covId = new mongoDB.ObjectId(userId);

  //     const findUser = await student.findOne({ _id: covId });
  //     if (!findUser) return socket.emit("error", { message: "User not found" });

  //     await student.updateOne(
  //       { _id: findUser._id },
  //       { $set: { jobAssessmentEndedSocketId: socket.id } }
  //     );

  //     // Get job details to determine source type
  //     let jobDetails = null;
  //     let sourceType = "local";
  //     let sourceOrgId = socket.orgId;
  //     let jobAssessmentProgressCollection; // This will determine where to save

  //     // First try to find job locally
  //     jobDetails = await job.findOne({ _id: new mongoDB.ObjectId(jobId) });

  //     if (jobDetails) {
  //       // Job is local, use local jobAssessmentProgress collection
  //       const localCollections = connectTodb(socket.tenantDB);
  //       jobAssessmentProgressCollection =
  //         localCollections.jobAssessmentProgress;
  //     } else {
  //       // If not found locally, check assignedJob collection
  //       const assignedJobDoc = await assignedJob.findOne({ jobId });
  //       if (assignedJobDoc) {
  //         sourceType = "assigned";
  //         sourceOrgId = assignedJobDoc.companyOrgId;

  //         // Get job details from company's DB
  //         const externalTenantDB = await getTenantDB(
  //           assignedJobDoc.companyOrgId
  //         );
  //         const externalCollections = connectTodb(externalTenantDB);
  //         jobDetails = await externalCollections.job.findOne({
  //           _id: new mongoDB.ObjectId(jobId),
  //         });

  //         // Use company's jobAssessmentProgress collection
  //         jobAssessmentProgressCollection =
  //           externalCollections.jobAssessmentProgress;
  //       }
  //     }

  //     if (!jobDetails) {
  //       return socket.emit("error", { message: "Job not found" });
  //     }

  //     // Get assessment data
  //     let assessment = null;
  //     let skillsData = [];

  //     // First try local jobAssessments
  //     assessment = await jobAssessments.findOne({
  //       _id: new mongoDB.ObjectId(assessmentId),
  //     });

  //     // If not found locally, search in external orgs based on source
  //     if (!assessment && sourceType === "assigned") {
  //       const externalTenantDB = await getTenantDB(sourceOrgId);
  //       const externalCollections = connectTodb(externalTenantDB);
  //       assessment = await externalCollections.jobAssessments.findOne({
  //         _id: new mongoDB.ObjectId(assessmentId),
  //       });

  //       // Get skills data from external org
  //       if (
  //         assessment &&
  //         assessment.skills &&
  //         Array.isArray(assessment.skills)
  //       ) {
  //         const skillIds = assessment.skills.map(
  //           (s) => new mongoDB.ObjectId(s.skillId)
  //         );
  //         skillsData = await skillsCollection
  //           .find({ _id: { $in: skillIds } })
  //           .toArray();
  //       }
  //     } else if (assessment) {
  //       // Get skills data from local skills collection
  //       if (assessment.skills && Array.isArray(assessment.skills)) {
  //         const skillIds = assessment.skills.map(
  //           (s) => new mongoDB.ObjectId(s.skillId)
  //         );
  //         skillsData = await skillsCollection
  //           .find({ _id: { $in: skillIds } })
  //           .toArray();
  //       }
  //     }

  //     if (!assessment) {
  //       return socket.emit("error", { message: "Assessment not found" });
  //     }

  //     // Get questions data from student's local DB (questions should be in student's DB)

  //     const questionIds = Object.keys(response);
  //     const questionsData = questionIds.map((e) => {
  //       const quesIdObj = new mongoDB.ObjectId(e);
  //       return questions.findOne({ _id: quesIdObj });
  //     });

  //     const questionData = await Promise.allSettled(questionsData);
  //     const answersArray = questionData.map((e) => ({
  //       answer: e.value.answer,
  //       scoreSettings: e.value.scoreSettings,
  //       _id: e.value._id,
  //     }));

  //     let finalScore = 0,
  //       correctQues = 0,
  //       incorrectQues = 0,
  //       unattemptedQues = 0,
  //       totalTimeTaken = 0,
  //       notAnswered = 0,
  //       averageTimeTaken = 0;

  //     // Calculate scores for each question
  //     answersArray.forEach((e) => {
  //       const questionType = Object.keys(e.answer)[0];

  //       if (
  //         data.response[e._id].answers == undefined ||
  //         data.response[e._id].answers == "undefined" ||
  //         data.response[e._id].answers == null
  //       ) {
  //         if (data.response[e._id].timeTaken == undefined) {
  //           unattemptedQues++;
  //           data.response[e._id].status = "unattempted";
  //           return;
  //         } else {
  //           totalTimeTaken += data.response[e._id].timeTaken;
  //           notAnswered++;
  //           data.response[e._id].status = "notanswered";
  //           return;
  //         }
  //       }

  //       if (data.response[e._id].answers.length == 0) {
  //         if (data.response[e._id].timeTaken) {
  //           totalTimeTaken += data.response[e._id].timeTaken;
  //           notAnswered++;
  //           data.response[e._id].status = "notanswered";
  //           return;
  //         } else {
  //           notAnswered++;
  //           data.response[e._id].status = "notanswered";
  //           return;
  //         }
  //       }

  //       totalTimeTaken += data.response[e._id].timeTaken;
  //       let correctQScore = 0,
  //         negativeQScore = 0,
  //         bonusQScore = 0,
  //         correctQFlag;

  //       // Calculate score based on question type
  //       switch (questionType) {
  //         case "shortPara": {
  //           let { correctScore, negativeScore, correctFlag } =
  //             getShortParaScore(e, data.response[e._id]);
  //           correctQScore = correctScore;
  //           negativeQScore = negativeScore;
  //           correctQFlag = correctFlag;
  //           finalScore += +correctScore + +negativeScore;
  //           data.response[e._id] = {
  //             ...data.response[e._id],
  //             correctScore,
  //             negativeScore,
  //             correctFlag,
  //           };
  //           break;
  //         }

  //         case "singleChoice": {
  //           let { correctScore, negativeScore, correctFlag } =
  //             getSingleChoiceScore(e, data.response[e._id]);
  //           correctQScore = correctScore;
  //           negativeQScore = negativeScore;
  //           correctQFlag = correctFlag;
  //           finalScore += +correctScore + +negativeScore;
  //           data.response[e._id] = {
  //             ...data.response[e._id],
  //             correctScore,
  //             negativeScore,
  //             correctFlag,
  //           };
  //           break;
  //         }

  //         case "multipleChoice": {
  //           let { correctScore, negativeScore, bonusScore, correctFlag } =
  //             getMultipleChoiceScore(e, data.response[e._id]);
  //           finalScore += +correctScore + +negativeScore + +bonusScore;
  //           correctQScore = correctScore;
  //           negativeQScore = negativeScore;
  //           bonusQScore = bonusScore;
  //           correctQFlag = correctFlag;
  //           data.response[e._id] = {
  //             ...data.response[e._id],
  //             correctScore,
  //             negativeScore,
  //             bonusScore,
  //             correctFlag,
  //           };
  //           break;
  //         }

  //         case "truefalse": {
  //           let { correctScore, negativeScore, correctFlag } =
  //             getTrueFalseScore(e, data.response[e._id]);
  //           correctQScore = correctScore;
  //           negativeQScore = negativeScore;
  //           correctQFlag = correctFlag;
  //           finalScore += +correctScore + +negativeScore;
  //           data.response[e._id] = {
  //             ...data.response[e._id],
  //             correctScore,
  //             negativeScore,
  //             correctFlag,
  //           };
  //           break;
  //         }
  //       }

  //       if (data.response[e._id].answers.length) {
  //         if (correctQFlag) {
  //           correctQues++;
  //           data.response[e._id].status = "correct";
  //         } else {
  //           if (correctQFlag == undefined) {
  //             notAnswered++;
  //             data.response[e._id].status = "notanswered";
  //           }
  //           incorrectQues++;
  //           data.response[e._id].status = "incorrect";
  //         }
  //       }
  //     });

  //     // Calculate final statistics
  //     data.scoreData = {};
  //     if (Object.keys(data.response).length > 0) {
  //       averageTimeTaken = totalTimeTaken / Object.keys(data.response).length;
  //       unattemptedQues +=
  //         answersArray.length - Object.keys(data.response).length;
  //     }

  //     data.scoreData.finalScore = +finalScore;
  //     data.scoreData.correctQues = +correctQues;
  //     data.scoreData.incorrectQues = +incorrectQues;
  //     data.scoreData.unattemptedQues = +unattemptedQues;
  //     data.scoreData.totalTimeTaken = +totalTimeTaken;
  //     data.scoreData.averageTimeTaken = +averageTimeTaken;
  //     data.scoreData.notAnswered = +notAnswered;

  //     // Save job assessment progress to the appropriate org's DB
  //     let progData = "";
  //     try {
  //       const newStudentId = new mongoDB.ObjectId(findUser?._id?.toString());
  //       const newAssessmentId = new mongoDB.ObjectId(assessmentId);
  //       const newJobId = new mongoDB.ObjectId(jobId);

  //       // Save to the organization's DB where the job originated from
  //       progData = await jobAssessmentProgressCollection.insertOne({
  //         ...data,
  //         studentId: findUser?._id?.toString(),
  //         studentOrgId: socket.orgId, // Student's org ID
  //         assessmentId: assessmentId,
  //         jobId: jobId,
  //         assessmentData: assessment,
  //         skillsData: skillsData,
  //         jobDetails: jobDetails,
  //         sourceType: sourceType, // "local" or "assigned"
  //         sourceOrgId: sourceOrgId, // Where the job/assessment came from
  //         createdAt: new Date().getTime(),
  //       });

  //       // Also update student's local record with progress reference
  //       if (findUser?._id) {
  //         await student.updateOne(
  //           { _id: findUser?._id },
  //           { $push: { jobAssessmentProgress: progData.insertedId.toString() } }
  //         );
  //       }
  //     } catch (error) {
  //       console.log({ err: error.message });
  //     }

  //     io.to(socket.id)
  //       .to(findUser.ConnectedSocketId)
  //       .emit("jobAssessmentEndedPortal", {
  //         ...data,
  //         progData: progData?.insertedId,
  //         assessmentData: assessment,
  //         skillsData: skillsData,
  //         jobDetails: jobDetails,
  //         sourceType: sourceType,
  //       });
  //   } catch (error) {
  //     console.error("jobAssessmentEnded event error:", error);
  //     socket.emit("error", {
  //       message: "Failed to process jobAssessmentEnded event",
  //     });
  //   }
  // });

  // Proctoring room management

  socket.on("jobAssessmentEnded", async (data) => {
    try {
      const { student, jobAssessments, job, assignedJob } = connectTodb(
        socket.tenantDB,
      );
      const { userId, assessmentId, jobId, response } = data;
      const covId = new mongoDB.ObjectId(userId);

      const findUser = await student.findOne({ _id: covId });
      if (!findUser) return socket.emit("error", { message: "User not found" });

      await student.updateOne(
        { _id: findUser._id },
        { $set: { jobAssessmentEndedSocketId: socket.id } },
      );

      // Get job details to determine source type
      let jobDetails = null;
      let sourceType = "local";
      let sourceOrgId = socket.orgId;
      let jobAssessmentProgressCollection; // This will determine where to save

      // First try to find job locally
      jobDetails = await job.findOne({ _id: new mongoDB.ObjectId(jobId) });

      if (jobDetails) {
        // Job is local, use local jobAssessmentProgress collection
        const localCollections = connectTodb(socket.tenantDB);
        jobAssessmentProgressCollection =
          localCollections.jobAssessmentProgress;
      } else {
        // If not found locally, check assignedJob collection
        const assignedJobDoc = await assignedJob.findOne({ jobId });
        if (assignedJobDoc) {
          sourceType = "assigned";
          sourceOrgId = assignedJobDoc.companyOrgId;

          // Get job details from company's DB
          const externalTenantDB = await getTenantDB(
            assignedJobDoc.companyOrgId,
          );
          const externalCollections = connectTodb(externalTenantDB);
          jobDetails = await externalCollections.job.findOne({
            _id: new mongoDB.ObjectId(jobId),
          });

          // Use company's jobAssessmentProgress collection
          jobAssessmentProgressCollection =
            externalCollections.jobAssessmentProgress;
        }
      }

      if (!jobDetails) {
        return socket.emit("error", { message: "Job not found" });
      }

      // Get assessment data
      // let assessment = null;
      // let skillsData = [];

      // Get assessment data
      let assessment = null;
      let skillsData = [];

      // First try local jobAssessments
      assessment = await jobAssessments.findOne({
        _id: new mongoDB.ObjectId(assessmentId),
      });

      // If not found locally, search in external orgs based on source
      if (!assessment && sourceType === "assigned") {
        const externalTenantDB = await getTenantDB(sourceOrgId);
        const externalCollections = connectTodb(externalTenantDB);
        assessment = await externalCollections.jobAssessments.findOne({
          _id: new mongoDB.ObjectId(assessmentId),
        });

        // Get skills data from external org

        // Get skills data from external org
        // if (
        //   assessment &&
        //   assessment.skills &&
        //   Array.isArray(assessment.skills)
        // ) {
        //   const skillIds = assessment.skills.map((s) => new mongoDB.ObjectId(s.skillId));
        //   skillsData = await skillsCollection.find({
        //     _id: { $in: skillIds }
        //   }).toArray();
        // }
      } else if (assessment) {
        // Get skills data from local skills collection
        // if (assessment.skills && Array.isArray(assessment.skills)) {
        //   const skillIds = assessment.skills.map((s) => new mongoDB.ObjectId(s.skillId));
        //   skillsData = await skillsCollection.find({
        //     _id: { $in: skillIds }
        //   }).toArray();
        // }
      }

      // Get questions data from student's local DB (questions should be in student's DB)
      const questionIds = Object.keys(response);
      const questionObjectIds = questionIds.map((e) => new mongoDB.ObjectId(e));
      const questionsDataFetched = await questions.find({ _id: { $in: questionObjectIds } }).toArray();

      const answersArray = questionsDataFetched.map((doc) => ({
        answer: doc.answer,
        scoreSettings: doc.scoreSettings,
        _id: doc._id,
        questionType:
          doc.questionType || (doc.answer ? Object.keys(doc.answer)[0] : ""),
      }));

      let finalScore = 0,
        correctQues = 0,
        incorrectQues = 0,
        unattemptedQues = 0,
        totalTimeTaken = 0,
        notAnswered = 0,
        averageTimeTaken = 0;

      // ======== SCORING LOGIC STARTS HERE ========
      answersArray.forEach((e) => {
        const questionType = e.questionType.toLowerCase();
        const userResponse = data.response[e._id];

        if (
          userResponse.answers === undefined ||
          userResponse.answers == "undefined" ||
          userResponse.answers == null
        ) {
          if (userResponse.timeTaken === undefined) {
            unattemptedQues++;
            userResponse.status = "unattempted";
            return;
          } else {
            totalTimeTaken += userResponse.timeTaken;
            notAnswered++;
            userResponse.status = "notanswered";
            return;
          }
        }

        if (userResponse.answers.length === 0) {
          if (userResponse.timeTaken) {
            totalTimeTaken += userResponse.timeTaken;
            notAnswered++;
            userResponse.status = "notanswered";
            return;
          } else {
            notAnswered++;
            userResponse.status = "notanswered";
            return;
          }
        }

        totalTimeTaken += userResponse.timeTaken;
        let correctQScore = 0,
          correctQFlag = false;

        if (questionType.includes("multiple")) {
          // Partial scoring for multiple choice
          const correctOptions = Array.isArray(
            e.answer.multipleChoice?.correctOptions,
          )
            ? e.answer.multipleChoice.correctOptions
            : [];

          const userOptions = Array.isArray(userResponse.answers)
            ? userResponse.answers
            : [];

          const correctMarked = userOptions.filter((opt) =>
            correctOptions.includes(opt),
          ).length;

          if (correctOptions.length === 0) {
            correctQScore = 0;
          } else if (
            correctMarked === correctOptions.length &&
            userOptions.length === correctOptions.length
          ) {
            correctQScore = 2;
            correctQFlag = true;
          } else if (correctMarked > 0) {
            correctQScore = 1;
            correctQFlag = true;
          } else {
            correctQScore = 0;
            correctQFlag = false;
          }

          finalScore += correctQScore;
          userResponse.correctScore = correctQScore;
          userResponse.negativeScore = 0;
          userResponse.correctFlag = correctQFlag;
        } else {
          // Default: 2 points for correct answer, else 0
          // We assume boolean correctFlag from e.answer structure if available, else fallback to correct
          const isCorrect =
            typeof e.answer?.correctFlag === "boolean"
              ? e.answer.correctFlag
              : true;

          correctQScore = isCorrect ? 2 : 0;
          correctQFlag = isCorrect;

          finalScore += correctQScore;
          userResponse.correctScore = correctQScore;
          userResponse.negativeScore = 0;
          userResponse.correctFlag = correctQFlag;
        }

        if (userResponse.answers.length) {
          if (correctQFlag) {
            correctQues++;
            userResponse.status = "correct";
          } else {
            incorrectQues++;
            userResponse.status = "incorrect";
          }
        }
      });
      // ======== SCORING LOGIC ENDS HERE ========

      // Calculate final statistics
      data.scoreData = {};
      if (Object.keys(data.response).length > 0) {
        averageTimeTaken = totalTimeTaken / Object.keys(data.response).length;
        unattemptedQues +=
          answersArray.length - Object.keys(data.response).length;
      }

      data.scoreData.finalScore = +finalScore;
      data.scoreData.correctQues = +correctQues;
      data.scoreData.incorrectQues = +incorrectQues;
      data.scoreData.unattemptedQues = +unattemptedQues;
      data.scoreData.totalTimeTaken = +totalTimeTaken;
      data.scoreData.averageTimeTaken = +averageTimeTaken;
      data.scoreData.notAnswered = +notAnswered;

      // Save job assessment progress to the appropriate org's DB
      // let progData = "";
      // try {
      //   const newStudentId = new mongoDB.ObjectId(findUser?._id?.toString());
      //   const newAssessmentId = new mongoDB.ObjectId(assessmentId);
      //   const newJobId = new mongoDB.ObjectId(jobId);

      // Save job assessment progress to the appropriate org's DB
      let progData = "";
      try {
        const newStudentId = new mongoDB.ObjectId(findUser?._id?.toString());
        const newAssessmentId = new mongoDB.ObjectId(assessmentId);
        const newJobId = new mongoDB.ObjectId(jobId);

        // Save to the organization's DB where the job originated from
        progData = await jobAssessmentProgressCollection.insertOne({
          ...data,
          studentId: findUser?._id?.toString(),
          studentOrgId: socket.orgId, // Student's org ID
          assessmentId: assessmentId,
          jobId: jobId,
          assessmentData: assessment,
          // skillsData: skillsData,
          jobDetails: jobDetails,
          sourceType: sourceType, // "local" or "assigned"
          sourceOrgId: sourceOrgId, // Where the job/assessment came from
          createdAt: new Date().getTime(),
        });

        // Also update student's local record with progress reference
        if (findUser?._id) {
          await student.updateOne(
            { _id: findUser?._id },
            {
              $push: { jobAssessmentProgress: progData.insertedId.toString() },
            },
          );
        }
      } catch (error) {
        console.log({ err: error.message });
      }

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
      socket.emit("error", {
        message: "Failed to process jobAssessmentEnded event",
      });
    }
  });
  socket.on("joinProctoringSession", async (data) => {
    try {
      console.log("=== PROCTORING SESSION JOIN REQUEST ===");
      console.log("Request data:", data);
      // console.log("Socket info:", {
      //   id: socket.id,
      //   userID: socket.userID,
      //   tenantDB: socket.tenantDB,
      //   connected: socket.connected,
      // });

      const { sessionId, userType } = data;

      if (!sessionId || !userType) {
        console.log("❌ Missing required data:", {
          sessionId: !!sessionId,
          userType: !!userType,
        });
        socket.emit("error", { message: "sessionId and userType required" });
        return;
      }

      const roomId = `proctoring_session_${sessionId}`;

      console.log("Attempting to join room:", roomId);
      socket.join(roomId);

      console.log("Room joined successfully. Current rooms:", socket.rooms);
      console.log("✅ User joined proctoring room:", roomId);

      socket.emit("proctoringRoomJoined", {
        sessionId,
        roomId,
        message: "Successfully joined proctoring session",
        timestamp: new Date(),
      });

      console.log("=== PROCTORING SESSION JOIN COMPLETE ===");
    } catch (error) {
      console.error("=== PROCTORING SESSION JOIN ERROR ===");
      console.error("Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      socket.emit("error", {
        message: "Failed to join proctoring session",
        error: error.message,
      });
    }
  });
  socket.on("leaveProctoringSession", async (data) => {
    try {
      const { sessionId, userType } = data;
      const roomId = `proctoring_session_${sessionId}`;

      // Leave the proctoring room
      socket.leave(roomId);

      console.log(
        `User ${socket.userID} (${userType}) left proctoring room: ${roomId}`,
      );

      // Notify others in the room
      socket.to(roomId).emit("userLeftProctoring", {
        userId: socket.userID,
        userType,
        sessionId,
        socketId: socket.id,
      });
    } catch (error) {
      console.error("leaveProctoringSession error:", error);
      socket.emit("error", { message: "Failed to leave proctoring session" });
    }
  });

  // Add to your existing socket server
  // Fixed socket server event for sending proctor messages
  socket.on("sendProctorMessage", async (data) => {
    try {
      const { sessionId, message, targetStudentId } = data;

      console.log("=== SEND PROCTOR MESSAGE DEBUG ===");
      console.log("Data received:", data);
      console.log("Sender socket ID:", socket.id);
      console.log("Sender user ID:", socket.userID);

      if (targetStudentId) {
        // Send to specific student
        console.log("Sending to specific student:", targetStudentId);

        // Method 1: Find student by stored socket ID
        const { student } = connectTodb(socket.tenantDB);
        const targetStudent = await student.findOne({
          $or: [{ globalId: targetStudentId }, { _id: targetStudentId }],
        });

        if (targetStudent && targetStudent.ConnectedSocketId) {
          console.log(
            "Found student socket ID:",
            targetStudent.ConnectedSocketId,
          );

          // Send directly to student's socket
          io.to(targetStudent.ConnectedSocketId).emit("proctorMessage", {
            message,
            sessionId,
            from: socket.userID,
            timestamp: new Date(),
          });

          console.log("✅ Message sent to student socket");
        } else {
          console.log("❌ Student socket not found");

          // Fallback: Send to room and let student filter by their ID
          const roomId = `proctoring_session_${sessionId}`;
          socket.to(roomId).emit("proctorMessage", {
            message,
            sessionId,
            targetStudentId, // Include this so student can check if message is for them
            from: socket.userID,
            timestamp: new Date(),
          });
        }
      } else {
        // Send to all students in the session
        console.log("Sending to all students in session");
        const roomId = `proctoring_session_${sessionId}`;

        // Check room exists and has members
        const roomMembers = io.sockets.adapter.rooms.get(roomId);
        console.log(
          "Room members:",
          roomMembers ? Array.from(roomMembers) : "No members",
        );

        if (roomMembers && roomMembers.size > 0) {
          socket.to(roomId).emit("proctorMessage", {
            message,
            sessionId,
            from: socket.userID,
            timestamp: new Date(),
          });
          console.log("✅ Message sent to room");
        } else {
          console.log("❌ No members in room");
        }
      }

      console.log("=== END SEND MESSAGE DEBUG ===");
    } catch (error) {
      console.error("sendProctorMessage error:", error);
      socket.emit("error", { message: "Failed to send proctor message" });
    }
  });

  // Add this event handler to your socket server
  socket.on("captureFrame", async (data) => {
    try {
      const { sessionId, respond } = data;

      // Request the client to capture and send a frame
      socket.emit("requestFrameCapture", {
        sessionId,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error("Frame capture request error:", error);
    }
  });

  // socket.on("frameData", async (data) => {
  //   try {
  //     const { requestId, frameBuffer, sessionId, timestamp, error } = data;

  //     console.log("📸 Frame data received:", {
  //       requestId,
  //       hasFrameBuffer: !!frameBuffer,
  //       frameBufferLength: frameBuffer ? frameBuffer.length : 0,
  //       error: error || "none",
  //     });

  //     const pendingRequest = pendingFrameRequests.get(requestId);
  //     if (pendingRequest) {
  //       clearTimeout(pendingRequest.timer);
  //       pendingFrameRequests.delete(requestId);

  //       if (error) {
  //         console.log("⚠️ Frame capture error from client:", error);
  //         pendingRequest.resolve({ error, sessionId, timestamp });
  //       } else if (frameBuffer) {
  //         console.log("✅ Frame data resolved successfully");
  //         pendingRequest.resolve({
  //           frameBuffer,
  //           sessionId,
  //           timestamp,
  //           requestId,
  //         });
  //       } else {
  //         console.log("⚠️ No frame buffer in client response");
  //         pendingRequest.resolve({
  //           error: "No frame buffer",
  //           sessionId,
  //           timestamp,
  //         });
  //       }
  //     } else {
  //       console.log("⚠️ No pending request found for requestId:", requestId);
  //     }
  //   } catch (error) {
  //     console.error("❌ Frame data handling error:", error);
  //   }
  // });
  socket.on("frameData", async (data) => {
    try {
      const {
        requestId,
        frameBuffer,
        audioBuffer, // ✅ Add this
        audioDuration, // ✅ Add this
        sessionId,
        timestamp,
        error,
        hasAudio, // ✅ Add this
      } = data;

      console.log("📸 Frame data received:", {
        requestId,
        hasFrameBuffer: !!frameBuffer,
        frameBufferLength: frameBuffer ? frameBuffer.length : 0,
        hasAudioBuffer: !!audioBuffer, // ✅ Add this
        audioBufferLength: audioBuffer ? audioBuffer.length : 0, // ✅ Add this
        audioDuration: audioDuration, // ✅ Add this
        error: error || "none",
      });

      const pendingRequest = pendingFrameRequests.get(requestId);
      if (pendingRequest) {
        clearTimeout(pendingRequest.timer);
        pendingFrameRequests.delete(requestId);

        if (error) {
          console.log("⚠️ Frame capture error from client:", error);
          pendingRequest.resolve({ error, sessionId, timestamp });
        } else if (frameBuffer) {
          console.log("✅ Frame and audio data resolved successfully");
          pendingRequest.resolve({
            frameBuffer,
            audioBuffer, // ✅ Include audio buffer
            audioDuration, // ✅ Include audio duration
            hasAudio, // ✅ Include audio flag
            sessionId,
            timestamp,
            requestId,
          });
        } else {
          console.log("⚠️ No frame buffer in client response");
          pendingRequest.resolve({
            error: "No frame buffer",
            sessionId,
            timestamp,
          });
        }
      } else {
        console.log("⚠️ No pending request found for requestId:", requestId);
      }
    } catch (error) {
      console.error("❌ Frame data handling error:", error);
    }
  });

  socket.on("request-frame-capture", async (data) => {
    try {
      const requestId = Date.now() + Math.random();

      // Request frame from client
      socket.emit("requestFrameCapture", {
        sessionId: data.sessionId,
        requestId: requestId,
        timestamp: data.timestamp,
      });

      // Wait for client response with timeout
      const frameResponse = await waitForFrameResponse(socket, requestId, 8000);

      // Send success response
      socket.emit("frameResponse", {
        success: true,
        frameBuffer: frameResponse.frameBuffer,
        sessionId: data.sessionId,
      });
    } catch (error) {
      console.error("Frame capture failed:", error.message);

      // Send error response
      socket.emit("frameResponse", {
        success: false,
        error: error.message,
        sessionId: data.sessionId,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Optionally handle user disconnect logic here
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

// Add Express middleware for parsing JSON
app.use(express.json());
// app.use(authenticate);
// app.use(selectTenantDB);
// HTTP endpoint for proctoring server to request frames

// Add this function to your socket server file
function waitForFrameResponse(socket, requestId, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for frame response (${timeout}ms)`));
    }, timeout);

    const responseHandler = (data) => {
      clearTimeout(timer);
      if (data.requestId === requestId) {
        resolve(data);
      } else {
        reject(new Error("Mismatched requestId"));
      }
    };

    socket.on("frameData", responseHandler);
  });
}

// In socket.js - Fix the request-frame-capture endpoint

// ✅ ENHANCED: Better frame response waiting with session-based tracking
const pendingFrameRequests = new Map(); // requestId -> { resolve, reject, timer }
// app.post("/request-frame-capture", async (req, res) => {
//   try {
//     const { sessionId, timestamp } = req.body;

//     console.log("📸 Frame capture request received:", { sessionId, timestamp });

//     if (!sessionId) {
//       return res.status(400).json({
//         success: false,
//         error: "sessionId is required",
//       });
//     }

//     const roomId = `proctoring_session_${sessionId}`;

//     // Check if room exists
//     const roomMembers = io.sockets.adapter.rooms.get(roomId);
//     if (!roomMembers || roomMembers.size === 0) {
//       console.log("⚠️ No members in proctoring room:", roomId);
//       return res.status(404).json({
//         success: false,
//         error: "No active students in session",
//       });
//     }

//     console.log(
//       `📡 Requesting frame from ${roomMembers.size} members in room: ${roomId}`
//     );

//     // Generate unique request ID
//     const requestId = `capture-${sessionId}-${Date.now()}-${Math.random()
//       .toString(36)
//       .substr(2, 9)}`;

//     // Create promise to wait for response
//     const framePromise = new Promise((resolve, reject) => {
//       const timer = setTimeout(() => {
//         pendingFrameRequests.delete(requestId);
//         console.log("⏰ Frame capture timeout for request:", requestId);
//         resolve(null);
//       }, 8000);

//       pendingFrameRequests.set(requestId, { resolve, reject, timer });
//     });

//     // Send request to room
//     io.to(roomId).emit("requestFrameCapture", {
//       sessionId,
//       requestId,
//       timestamp: timestamp || Date.now(),
//       requester: "proctoring_server",
//     });

//     console.log("📤 Frame capture request sent with ID:", requestId);

//     // Wait for response
//     const frameResponse = await framePromise;

//     if (frameResponse) {
//       console.log("✅ Frame received:", {
//         hasVideo: !!frameResponse.frameBuffer,
//         hasAudio: !!frameResponse.audioBuffer,
//         videoSize: frameResponse.frameBuffer?.length,
//         audioSize: frameResponse.audioBuffer?.length,
//       });
//       res.json({
//         success: true,
//         frameBuffer: frameResponse.frameBuffer,
//         audioBuffer: frameResponse.audioBuffer, // Include audio
//         hasAudio: !!frameResponse.audioBuffer,
//         sessionId,
//         requestId,
//         timestamp: frameResponse.timestamp,
//       });
//     } else {
//       console.log("⚠️ No frame buffer in response");
//       res.json({
//         success: true,
//         frameBuffer: null,
//         sessionId,
//         requestId,
//         error: frameResponse?.error || "No frame available",
//       });
//     }
//   } catch (error) {
//     console.error("❌ Frame capture endpoint error:", error);
//     res.status(500).json({
//       success: false,
//       error: error.message,
//     });
//   }
// });

app.post("/request-frame-capture", async (req, res) => {
  try {
    const { sessionId, timestamp, includeAudio = true } = req.body; // ✅ Add includeAudio
    console.log("📸 Frame capture request received:", {
      sessionId,
      timestamp,
      includeAudio,
    });

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: "sessionId is required",
      });
    }

    const roomId = `proctoring_session_${sessionId}`;

    // Check if room exists
    const roomMembers = io.sockets.adapter.rooms.get(roomId);
    if (!roomMembers || roomMembers.size === 0) {
      console.log("⚠️ No members in proctoring room:", roomId);
      return res.status(404).json({
        success: false,
        error: "No active students in session",
      });
    }

    console.log(
      `📡 Requesting frame from ${roomMembers.size} members in room: ${roomId}`,
    );

    // Generate unique request ID
    const requestId = `capture-${sessionId}-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    // Create promise to wait for response
    const framePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFrameRequests.delete(requestId);
        console.log("⏰ Frame capture timeout for request:", requestId);
        resolve(null);
      }, 12000); // ✅ Increased timeout for audio processing

      pendingFrameRequests.set(requestId, { resolve, reject, timer });
    });

    // Send request to room with audio flag
    io.to(roomId).emit("requestFrameCapture", {
      sessionId,
      requestId,
      timestamp: timestamp || Date.now(),
      includeAudio: includeAudio, // ✅ Pass audio flag to frontend
      requester: "proctoring_server",
    });

    console.log("📤 Frame capture request sent with ID:", requestId);

    // Wait for response
    const frameResponse = await framePromise;

    if (frameResponse) {
      console.log("✅ Frame and audio received:", {
        hasVideo: !!frameResponse.frameBuffer,
        hasAudio: !!frameResponse.audioBuffer,
        videoSize: frameResponse.frameBuffer?.length,
        audioSize: frameResponse.audioBuffer?.length,
        audioDuration: frameResponse.audioDuration,
      });

      res.json({
        success: true,
        frameBuffer: frameResponse.frameBuffer,
        audioBuffer: frameResponse.audioBuffer, // ✅ Include audio
        audioDuration: frameResponse.audioDuration, // ✅ Include duration
        hasAudio: !!frameResponse.audioBuffer, // ✅ Include flag
        sessionId,
        requestId,
        timestamp: frameResponse.timestamp,
      });
    } else {
      console.log("⚠️ No frame response received");
      res.json({
        success: false,
        frameBuffer: null,
        audioBuffer: null,
        sessionId,
        requestId,
        error: "No response received",
      });
    }
  } catch (error) {
    console.error("❌ Frame capture endpoint error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

function waitForFrameResponse(sessionId, requestId, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFrameRequests.delete(requestId);
      console.log("⏰ Frame capture timeout for request:", requestId);
      resolve(null); // Don't reject, just return null
    }, timeout);

    pendingFrameRequests.set(requestId, { resolve, reject, timer });
    console.log("⏳ Waiting for frame response, requestId:", requestId);
  });
}

// HTTP endpoint to send violation alerts from proctoring server
app.post("/send-violation-alert", async (req, res) => {
  try {
    const { sessionId, violation, studentId, analysis, result } = req.body;

    console.log(
      `Sending violation alert for session ${sessionId}, student ${studentId}`,
    );

    // Send to proctoring room (for proctors)
    const roomId = `proctoring_session_${sessionId}`;
    io.to(roomId).emit("violationAlert", {
      sessionId,
      violation,
      studentId,
      analysis,
      timestamp: new Date(),
      result,
    });

    // Also send directly to the student using their stored socket ID
    if (studentId) {
      // You'll need to get tenant info from the request or session
      // For now, you might need to pass tenantDB info in the request
      const { tenantDB } = req.body; // Pass this from proctoring server

      if (tenantDB) {
        const { student } = connectTodb(tenantDB);
        const studentData = await student.findOne({
          globalId: studentId,
        });

        if (studentData && studentData.ConnectedSocketId) {
          io.to(studentData.ConnectedSocketId).emit("violationNotification", {
            message: "Please maintain exam integrity",
            violation,
            sessionId,
            timestamp: new Date(),
          });
        }
      }
    }

    res.json({ success: true, message: "Violation alert sent" });
  } catch (error) {
    console.error("Failed to send violation alert:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// HTTP endpoint to send proctor messages from proctoring server
app.post("/send-proctor-message", async (req, res) => {
  try {
    const { sessionId, message, targetStudentId, tenantDB } = req.body;

    if (targetStudentId && tenantDB) {
      const { student } = connectTodb(tenantDB);
      const studentData = await student.findOne({
        globalId: targetStudentId,
      });

      if (studentData && studentData.ConnectedSocketId) {
        io.to(studentData.ConnectedSocketId).emit("proctorMessage", {
          message,
          sessionId,
          timestamp: new Date(),
        });
      }
    }

    res.json({ success: true, message: "Proctor message sent" });
  } catch (error) {
    console.error("Failed to send proctor message:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// HTTP endpoint to get active proctoring sessions
app.get("/active-proctoring-sessions", (req, res) => {
  try {
    const rooms = Array.from(io.sockets.adapter.rooms.keys())
      .filter((room) => room.startsWith("proctoring_session_"))
      .map((room) => ({
        roomId: room,
        sessionId: room.replace("proctoring_session_", ""),
        userCount: io.sockets.adapter.rooms.get(room)?.size || 0,
      }));

    res.json({ success: true, sessions: rooms });
  } catch (error) {
    console.error("Failed to get active sessions:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

};

if (require.main === module) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: "*" });
  const port = 2222;

  module.exports(io, app);

  httpServer.listen(port, () =>
    console.log(`socket server running at port ${port}`)
  );
}
