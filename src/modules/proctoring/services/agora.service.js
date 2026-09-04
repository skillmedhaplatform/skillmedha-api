require("dotenv").config({
  path: "../../../.env",
});

const express = require("express");
const { ObjectId } = require("mongodb");
const router = express.Router();
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const agoraService = require("./agoraService");
const EnhancedRekognitionAnalyzer = require("./rekoginitionProcessor");
const AutoProctoringConfigGenerator = require("./autoProctoringConfigGenerator");
const axios = require("axios");
const { getTenantDB } = require("../../../shared/db/connection");

const analyzer = new EnhancedRekognitionAnalyzer();
const APP_ID = process.env.AGORA_APP_ID;

// ✅ CREATE EXAM SESSION
router.post(
  "/create-exam-session/:testId",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      const { testId } = req.params;
      const { companyOrg } = req.body;
      const studentId = req.userID;
      const orgDB = await getTenantDB(companyOrg);

      const { proctoringSessions, assessment, jobAssessments } =
        connectTodb(orgDB);

      // Check for existing session
      const existingSession = await proctoringSessions.findOne({
        testId: testId,
        "students.globalId": studentId,
        isActive: true,
      });

      if (existingSession) {
        // Start analysis for existing session
        if (existingSession.proctoringConfig?.analysisInterval?.enabled) {
          await startProctoringAnalysis(
            existingSession._id.toString(),
            existingSession.proctoringConfig,
            studentId
          );
        }

        return res.json({
          success: true,
          sessionId: existingSession._id,
          channelName: existingSession.channelName,
          appId: APP_ID,
          reconnected: true,
          settings: existingSession.settings,
          proctoringConfig: existingSession.proctoringConfig,
        });
      }

      const channelName = `exam_${studentId}_${Date.now()}`;
      const testData = await jobAssessments.findOne({
        _id: new ObjectId(testId),
      });
      const autoConfig = await AutoProctoringConfigGenerator.generateConfig(
        testData,
        {}
      );
      const sessionDoc = {
        channelName,
        testId: testId,
        jobId: testData?.jobId,
        examType: "student-initiated",
        createdBy: studentId,
        students: [
          {
            globalId: studentId,
            joinedAt: null,
            uid: null,
            isActive: false,
          },
        ],
        proctors: [],
        settings: {
          maxProctors: 10,
          allowLateJoining: true,
          allowProctorSelfJoin: true,
        },
        proctoringConfig: autoConfig,
        violations: [],
        createdAt: new Date(),
        isActive: true,
        sessionStarted: false,
      };

      const result = await proctoringSessions.insertOne(sessionDoc);

      // Create Agora channel
      await agoraService.createProctoringChannel(
        channelName,
        {
          students: [studentId],
          proctors: [],
        },
        { maxStudents: 1, maxProctors: 10 }
      );

      // Start proctoring analysis
      if (sessionDoc.proctoringConfig?.analysisInterval?.enabled) {
        await startProctoringAnalysis(
          result.insertedId.toString(),
          sessionDoc.proctoringConfig,
          studentId
        );
      }

      return res.json({
        success: true,
        sessionId: result.insertedId,
        channelName,
        appId: APP_ID,
        reconnected: false,
        settings: sessionDoc.settings,
        proctoringConfig: sessionDoc.proctoringConfig,
      });
    } catch (err) {
      console.error("❌ Create exam session error:", err);
      res.status(500).json({
        success: false,
        error: "Failed to create exam session",
        message: err.message,
      });
    }
  }
);

// ✅ UNIFIED PROCTORING ANALYSIS STARTER
async function startProctoringAnalysis(sessionId, config, studentId) {
  try {
    const notificationCallback = (analysisData) => {
      // Send violations to socket server
      if (process.env.SOCKET_SERVER_URL) {
        axios
          .post(`${process.env.SOCKET_SERVER_URL}/send-violation-alert`, {
            sessionId: sessionId,
            violation: analysisData.overallViolations,
            studentId: studentId,
            analysis: analysisData,
            timestamp: new Date(),
          })
          .catch((err) => console.error("Failed to send violation:", err));
      }
    };

    // Start both scheduled and live processing
    await Promise.all([
      analyzer.startRandomizedAnalysis(sessionId, config, notificationCallback),
      analyzer.videoProcessor.startLiveStreamProcessing(sessionId, studentId),
    ]);
  } catch (error) {
    console.error("❌ Failed to start proctoring analysis:", error);
  }
}

async function startLiveProctoringAnalysis(sessionId, config, studentId) {
  try {
    // Use AgoraService's enhanced live proctoring
    const result = await agoraService.startLiveProctoring(sessionId, studentId);

    // Also start the existing analyzer for comprehensive coverage
    await analyzer.startRandomizedAnalysis(
      sessionId,
      config,
      (analysisData) => {
        // Combined notification callback
        sendViolationAlert(sessionId, studentId, analysisData);
      }
    );

    return result;
  } catch (error) {
    console.error("❌ Failed to start hybrid proctoring analysis:", error);
    throw error;
  }
}

router.post("/join-session", authenticate, selectTenantDB, async (req, res) => {
  try {
    const { sessionId, userType, companyOrg } = req.body;

    // Choose database based on presence of companyOrg
    let orgDB, studentDB, usersDB;
    if (companyOrg) {
      orgDB = await getTenantDB(companyOrg);
      const orgCollections = connectTodb(orgDB);
      const tenantCollections = connectTodb(req.tenantDB);
      usersDB = orgCollections.users;
      studentDB = tenantCollections.student;
    } else {
      orgDB = req.tenantDB;
      const collections = connectTodb(orgDB);
      usersDB = collections.users;
      studentDB = collections.student;
    }

    const { proctoringSessions } = connectTodb(orgDB);

    const session = await proctoringSessions.findOne({
      _id: new ObjectId(sessionId),
      isActive: true,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found or inactive" });
    }

    let userData, uid, token, role;

    if (userType === "student") {
      userData = await studentDB.findOne({ globalId: req.userID });
      if (!userData) {
        return res.status(404).json({ error: "Student not found" });
      }

      // Check if student is registered for this session
      const studentInSession = session.students.find(
        (s) => s.globalId === req.userID
      );
      if (!studentInSession) {
        return res
          .status(403)
          .json({ error: "Student not registered for this session" });
      }

      uid = parseInt(userData._id.toString().slice(-9), 16) % 4_000_000_000;
      const agoraResult = await agoraService.joinChannel(
        session.channelName,
        uid,
        "student"
      );

      if (!agoraResult.success) {
        return res.status(500).json({ error: agoraResult.error });
      }

      token = agoraResult.token;
      role = "publisher";

      // Update session - mark student as joined
      await proctoringSessions.updateOne(
        { _id: new ObjectId(sessionId), "students.globalId": req.userID },
        {
          $set: {
            "students.$.uid": uid,
            "students.$.joinedAt": new Date(),
            "students.$.isActive": true,
          },
        }
      );
    } else if (userType === "proctor") {
      userData = await usersDB.findOne({ globalId: req.userID });
      if (!userData) {
        return res.status(404).json({ error: "Proctor not found" });
      }

      // Check if proctor is assigned to this session
      // if (session.proctorId !== req.userID) {
      //   return res
      //     .status(403)
      //     .json({ error: "You are not assigned as proctor for this session" });
      // }

      uid =
        (parseInt(userData._id.toString().slice(-9), 16) % 4_000_000_000) +
        1_000_000_000;

      const agoraResult = await agoraService.joinChannel(
        session.channelName,
        uid,
        "proctor"
      );

      if (!agoraResult.success) {
        return res.status(500).json({ error: agoraResult.error });
      }

      token = agoraResult.token;
      role = "subscriber"; // Proctors typically observe (audience role)

      // Update session - mark proctor as joined
      await proctoringSessions.updateOne(
        { _id: new ObjectId(sessionId) },
        {
          $set: {
            proctorUid: uid,
            proctorJoinedAt: new Date(),
            proctorActive: true,
          },
        }
      );
    } else {
      return res
        .status(400)
        .json({ error: "Invalid userType. Must be 'student' or 'proctor'" });
    }

    return res.json({
      success: true,
      appId: agoraService.appId,
      channelName: session.channelName,
      uid,
      token,
      role,
      userType,
      proctoringConfig: session.proctoringConfig,
      sessionDetails: {
        sessionId: session._id,
        sessionName: session.sessionName,
        startTime: session.startTime,
        endTime: session.endTime,
        totalStudents: session.students.length,
        activeStudents: session.students.filter((s) => s.isActive).length,
      },
    });
  } catch (err) {
    console.error("❌ Join session error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ PROCESS FRAME - UNIFIED ENDPOINT
router.post(
  "/process-frame",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      const { sessionId, frameBuffer, timestamp } = req.body;

      if (!frameBuffer || !sessionId) {
        return res.status(400).json({
          success: false,
          error: "Missing frameBuffer or sessionId",
        });
      }

      const imageBuffer = Buffer.from(frameBuffer, "base64");

      // Process with live stream processor
      const result = await analyzer.videoProcessor.processLiveStreamFrame(
        sessionId,
        imageBuffer,
        timestamp
      );

      if (result.success && result.analysis.violations.length > 0) {
        // Send to socket server if configured
        if (process.env.SOCKET_SERVER_URL) {
          try {
            await axios.post(
              `${process.env.SOCKET_SERVER_URL}/send-violation-alert`,
              {
                sessionId: sessionId,
                violation: result.analysis.violations,
                analysis: result.analysis,
                timestamp: new Date(),
                result,
              }
            );
          } catch (socketError) {
            console.warn(
              "Failed to send to socket server:",
              socketError.message
            );
          }
        }
      }

      res.json({
        success: true,
        violations: result.analysis?.violations || [],
        frameNumber: result.analysis?.frameNumber || 0,
      });
    } catch (error) {
      console.error("❌ Frame processing error:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ✅ END SESSION
router.post(
  "/end-session/:sessionId",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const { proctoringSessions } = connectTodb(req.tenantDB);

      // Stop all analysis
      analyzer.stopAnalysis(sessionId);

      // Close Agora channel
      const session = await proctoringSessions.findOne({
        _id: new ObjectId(sessionId),
      });
      if (session) {
        await agoraService.closeChannel(session.channelName);
      }

      // Update database
      await proctoringSessions.updateOne(
        { _id: new ObjectId(sessionId) },
        {
          $set: {
            isActive: false,
            endedAt: new Date(),
            "students.$[].isActive": false,
          },
        }
      );

      return res.json({
        success: true,
        message: "Session ended successfully",
      });
    } catch (err) {
      console.error("❌ End session error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ✅ RECORDING STATUS
router.get(
  "/recording-status/:sessionId",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const status = analyzer.videoProcessor.getLiveStreamStatus(sessionId);

      res.json({
        success: true,
        status,
      });
    } catch (error) {
      console.error("Recording status error:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ✅ GET ACTIVE SESSIONS
router.get(
  "/active-sessions",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      const {
        userType = "all", // Query parameter: 'student', 'proctor', or 'all'
        limit = 50,
        offset = 0,
        sortBy = "createdAt",
        sortOrder = "desc",
        jobId,
      } = req.query;

      const { companyOrg } = req.query;
      let dbToUse;
      const matchCriteria = { isActive: true };
      if (jobId && jobId !== "undefined" && jobId !== "null") {
        matchCriteria.jobId = jobId;
      }

      // Use company org DB if specified, otherwise use tenant DB
      if (companyOrg && companyOrg !== "undefined" && companyOrg !== "null") {
        dbToUse = await getTenantDB(companyOrg);
      } else {
        dbToUse = req.tenantDB;
      }

      const { proctoringSessions, users } = connectTodb(dbToUse);
      const { student } = connectTodb(req.tenantDB);

      // Build aggregation pipeline
      const pipeline = [
        {
          $match: matchCriteria,
        },
        {
          $addFields: {
            activeStudentCount: {
              $size: {
                $filter: {
                  input: "$students",
                  cond: { $eq: ["$$this.isActive", true] },
                },
              },
            },
            totalStudentCount: { $size: "$students" },
            activeProctoCount: {
              $cond: [{ $eq: ["$proctorActive", true] }, 1, 0],
            },
          },
        },
        {
          $sort: { [sortBy]: sortOrder === "desc" ? -1 : 1 },
        },
        {
          $skip: parseInt(offset),
        },
        {
          $limit: parseInt(limit),
        },
      ];

      // Execute aggregation
      const sessions = await proctoringSessions.aggregate(pipeline).toArray();

      // Get additional details for each session
      const enrichedSessions = await Promise.all(
        sessions.map(async (session) => {
          try {
            // Get student details
            const studentDetails = await Promise.all(
              session.students.map(async (s) => {
                try {
                  const studentData = await student.findOne({
                    globalId: s.globalId,
                  });
                  return {
                    ...s,
                    name: studentData?.name || "Unknown Student",
                    email: studentData?.email || "N/A",
                  };
                } catch (err) {
                  console.error(`Error fetching student ${s.globalId}:`, err);
                  return { ...s, name: "Unknown Student", email: "N/A" };
                }
              })
            );

            // Get proctor details if exists
            let proctorDetails = null;
            if (session.proctorId) {
              try {
                const proctorData = await users.findOne({
                  globalId: session.proctorId,
                });
                proctorDetails = {
                  globalId: session.proctorId,
                  name: proctorData?.name || "Unknown Proctor",
                  email: proctorData?.email || "N/A",
                  joinedAt: session.proctorJoinedAt,
                  isActive: session.proctorActive || false,
                };
              } catch (err) {
                console.error(
                  `Error fetching proctor ${session.proctorId}:`,
                  err
                );
              }
            }

            // Calculate session duration
            const sessionDuration = session.createdAt
              ? Math.floor((new Date() - session.createdAt) / (1000 * 60)) // minutes
              : 0;

            // Get violation count
            const violationCount = session.violations
              ? session.violations.length
              : 0;

            return {
              jobId: session.jobId,
              sessionId: session._id,
              channelName: session.channelName,
              testId: session.testId,
              examType: session.examType,
              createdBy: session.createdBy,
              createdAt: session.createdAt,
              sessionStarted: session.sessionStarted,
              sessionDuration, // in minutes
              students: studentDetails,
              proctor: proctorDetails,
              activeStudentCount: session.activeStudentCount,
              totalStudentCount: session.totalStudentCount,
              activeProctoCount: session.activeProctoCount,
              violationCount,
              proctoringConfig: session.proctoringConfig,
              settings: session.settings,
              status: session.sessionStarted
                ? "In Progress"
                : "Waiting to Start",
            };
          } catch (err) {
            console.error(`Error enriching session ${session._id}:`, err);
            return {
              ...session,
              error: "Failed to load session details",
            };
          }
        })
      );

      // Filter by userType if specified
      let filteredSessions = enrichedSessions;
      if (userType === "student") {
        filteredSessions = enrichedSessions.filter(
          (s) => s.activeStudentCount > 0
        );
      } else if (userType === "proctor") {
        filteredSessions = enrichedSessions.filter(
          (s) => s.activeProctoCount > 0
        );
      }

      // Get total count for pagination
      const totalCount = await proctoringSessions.countDocuments({
        isActive: true,
      });

      // Summary statistics
      const summary = {
        totalActiveSessions: totalCount,
        totalActiveStudents: enrichedSessions.reduce(
          (sum, s) => sum + s.activeStudentCount,
          0
        ),
        totalActiveProctors: enrichedSessions.reduce(
          (sum, s) => sum + s.activeProctoCount,
          0
        ),
        averageSessionDuration:
          enrichedSessions.length > 0
            ? Math.floor(
              enrichedSessions.reduce(
                (sum, s) => sum + s.sessionDuration,
                0
              ) / enrichedSessions.length
            )
            : 0,
        totalViolations: enrichedSessions.reduce(
          (sum, s) => sum + s.violationCount,
          0
        ),
      };

      return res.json({
        success: true,
        data: filteredSessions,
        summary,
        pagination: {
          total: totalCount,
          offset: parseInt(offset),
          limit: parseInt(limit),
          hasMore: parseInt(offset) + filteredSessions.length < totalCount,
        },
        message: `Found ${filteredSessions.length} active sessions`,
      });
    } catch (err) {
      console.error("❌ Get active sessions error:", err);
      res.status(500).json({
        success: false,
        error: "Failed to fetch active sessions",
        message: err.message,
      });
    }
  }
);

// ✅ GET SESSION DETAILS BY ID
router.get(
  "/session/:sessionId",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { companyOrg } = req.query;

      let dbToUse;
      if (companyOrg) {
        dbToUse = await getTenantDB(companyOrg);
      } else {
        dbToUse = req.tenantDB;
      }

      const { proctoringSessions, users } = connectTodb(dbToUse);
      const { student } = connectTodb(req.tenantDB);

      const session = await proctoringSessions.findOne({
        _id: new ObjectId(sessionId),
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: "Session not found",
        });
      }

      // Get detailed student information
      const studentDetails = await Promise.all(
        session.students.map(async (s) => {
          try {
            const studentData = await student.findOne({ globalId: s.globalId });
            return {
              ...s,
              name: studentData?.name || "Unknown Student",
              email: studentData?.email || "N/A",
            };
          } catch (err) {
            return { ...s, name: "Unknown Student", email: "N/A" };
          }
        })
      );

      // Get proctor details if exists
      let proctorDetails = null;
      if (session.proctorId) {
        try {
          const proctorData = await users.findOne({
            globalId: session.proctorId,
          });
          proctorDetails = {
            globalId: session.proctorId,
            name: proctorData?.name || "Unknown Proctor",
            email: proctorData?.email || "N/A",
            joinedAt: session.proctorJoinedAt,
            isActive: session.proctorActive || false,
          };
        } catch (err) {
          console.error(`Error fetching proctor details:`, err);
        }
      }

      const enrichedSession = {
        ...session,
        students: studentDetails,
        proctor: proctorDetails,
        sessionDuration: session.createdAt
          ? Math.floor((new Date() - session.createdAt) / (1000 * 60))
          : 0,
        violationCount: session.violations ? session.violations.length : 0,
      };

      return res.json({
        success: true,
        data: enrichedSession,
        message: "Session details retrieved successfully",
      });
    } catch (err) {
      console.error("❌ Get session details error:", err);
      res.status(500).json({
        success: false,
        error: "Failed to fetch session details",
        message: err.message,
      });
    }
  }
);

module.exports = router;
