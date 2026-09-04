// services/agoraService.js
require("dotenv").config({
  path: "../../../.env",
});
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
const LiveRekognitionProcessor = require("./LiveRekognitionProcessor");
const AWSVideoProcessor = require("./awsVideoProcessor");

class AgoraService {
  constructor() {
    // Add validation for required environment variables
    if (!process.env.AGORA_APP_ID) {
      throw new Error("AGORA_APP_ID environment variable is required");
    }
    if (!process.env.AGORA_APP_CERTIFICATE) {
      throw new Error("AGORA_APP_CERTIFICATE environment variable is required");
    }

    this.appId = process.env.AGORA_APP_ID;
    this.appCertificate = process.env.AGORA_APP_CERTIFICATE;

    // Track active channels and users
    this.activeChannels = new Map(); // channelName -> channel info
    this.userSessions = new Map(); // uid -> session info
    this.liveProcessor = new LiveRekognitionProcessor({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_REKOG_KEY,
        secretAccessKey: process.env.AWS_REKOG_SECRET,
      },
      roleArn: process.env.REKOGNITION_ROLE_ARN,
      accountId: process.env.AWS_ACCOUNT_ID,
    });
    this.frameProcessor = new AWSVideoProcessor();
  }

  generateToken(
    channelName,
    uid,
    role = RtcRole.SUBSCRIBER,
    expirationTime = 3600
  ) {
    try {
      const currentTime = Math.floor(Date.now() / 1000);
      const privilegeExpiredTs = currentTime + expirationTime;

      const token = RtcTokenBuilder.buildTokenWithUid(
        this.appId,
        this.appCertificate,
        channelName,
        uid,
        role,
        privilegeExpiredTs
      );

      return token;
    } catch (error) {
      console.error("Token generation failed:", error);
      throw new Error(`Token generation failed: ${error.message}`);
    }
  }

  generateMultipleTokens(channelName, users, expirationTime = 3600) {
    const tokens = {};

    users.forEach((user) => {
      const { uid, role = RtcRole.SUBSCRIBER } = user;
      tokens[uid] = this.generateToken(channelName, uid, role, expirationTime);
    });

    return tokens;
  }

  // KEY FIX: Create channel in Agora service when database session is created
  async createProctoringChannel(channelName, participants, examInfo = {}) {
    try {
      if (!channelName) {
        throw new Error("Channel name is required");
      }

      const { proctors = [], students = [] } = participants;

      // Create channel info and store it immediately
      const channelInfo = {
        channelName,
        examInfo,
        proctors: new Set(proctors),
        students: new Set(students),
        createdAt: new Date(),
        isActive: true,
        maxStudents: examInfo.maxStudents || 50,
        maxProctors: examInfo.maxProctors || 10,
      };

      // IMPORTANT: Store the channel so joinChannel can find it
      this.activeChannels.set(channelName, channelInfo);

      return {
        success: true,
        channelName,
        appId: this.appId,
        participants: {
          proctors: Array.from(channelInfo.proctors),
          students: Array.from(channelInfo.students),
        },
        channelConfig: {
          maxStudents: channelInfo.maxStudents,
          maxProctors: channelInfo.maxProctors,
        },
      };
    } catch (error) {
      console.error("Failed to create proctoring channel:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // In agoraService.js - Update the joinChannel method
  async joinChannel(channelName, uid, userType, options = {}) {
    try {
      let channel = this.activeChannels.get(channelName);
      if (!channel) {
        const createResult = await this.createProctoringChannel(channelName, {
          students: userType === "student" ? [uid] : [],
          proctors: userType === "proctor" ? [uid] : [],
        });
        if (!createResult.success) {
          throw new Error(
            `Failed to auto-create channel: ${createResult.error}`
          );
        }
        channel = this.activeChannels.get(channelName);
      }

      if (!channel.isActive) {
        throw new Error(`Channel ${channelName} is not active`);
      }

      // ✅ CRITICAL FIX: Both student and proctor should be PUBLISHER
      // This ensures proctors can receive video from students properly
      const role = RtcRole.PUBLISHER;

      // Check capacity limits
      // if (
      //   userType === "proctor" &&
      //   channel.proctors.size >= channel.maxProctors
      // ) {
      //   throw new Error("Maximum proctor capacity reached");
      // }

      // Generate token
      const token = this.generateToken(
        channelName,
        uid,
        role,
        options.expirationTime || 3600
      );
      if (userType === "student") {
        await this.startLiveProctoring(channelName, uid);
      }

      // Add user to channel tracking
      if (userType === "student") {
        channel.students.add(uid);
      } else {
        channel.proctors.add(uid);
      }

      // Track user session
      this.userSessions.set(uid, {
        channelName,
        role,
        userType,
        joinedAt: new Date(),
        isActive: true,
      });

      return {
        success: true,
        token,
        channelName,
        appId: this.appId,
        role: "publisher", // ✅ Return consistent role
        uid,
        channelStats: this.getChannelStats(channelName),
      };
    } catch (error) {
      console.error(`Failed to join channel ${channelName}:`, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async startLiveProctoring(sessionId, studentId) {
    try {
      // 1. START REAL-TIME STREAMING (Primary)
      const streamResult = await this.liveProcessor.startLiveProcessing(
        sessionId,
        {
          prohibitedItems: ["Mobile Phone", "Tablet", "Laptop", "Book"],
          gazeTracking: { enabled: true, maxYaw: 30, maxPitch: 20 },
          minConfidence: 75,
        }
      );

      // 2. START FRAME RECORDING (Backup)
      const recordingResult = await this.frameProcessor.startRecording(
        sessionId,
        studentId
      );

      // 3. SET UP VIOLATION CALLBACKS
      this.liveProcessor.setViolationCallback(
        sessionId,
        async (violationData) => {
          await this.handleLiveViolation(sessionId, studentId, violationData);
        }
      );

      return {
        streamProcessing: streamResult,
        frameRecording: recordingResult,
        method: "hybrid",
      };
    } catch (error) {
      console.error(
        "❌ Live proctoring failed, falling back to frame-only:",
        error
      );

      // FALLBACK: If streaming fails, use frame analysis only
      return await this.frameProcessor.startRecording(sessionId, studentId);
    }
  }

  async handleLiveViolation(sessionId, studentId, violationData) {
    try {
      // Process violations
      const violations = violationData.violations;

      for (const violation of violations) {
        // ✅ INTEGRATE: Send to your existing socket server
        if (this.io) {
          this.io.emit("violationAlert", {
            sessionId: sessionId,
            studentId: studentId,
            violation: [violation], // Wrap in array to match your existing format
            analysis: violationData.analysis,
            timestamp: violationData.timestamp,
          });
        }

        // ✅ INTEGRATE: Store in your database (if you have violation storage)
        // await this.storeViolation(sessionId, studentId, violation);

        // ✅ INTEGRATE: Send notification to proctors
        // await this.notifyProctors(sessionId, violation);
      }
    } catch (error) {
      console.error("Error handling live violation:", error);
    }
  }

  async leaveChannel(uid) {
    try {
      const session = this.userSessions.get(uid);

      if (!session) {
        return {
          success: true,
          message: "No active session found",
        };
      }

      const channel = this.activeChannels.get(session.channelName);

      if (channel) {
        if (session.userType === "student") {
          await this.stopLiveProctoring(session.channelName);
          channel.students.delete(uid);
        } else {
          channel.proctors.delete(uid);
        }
      }

      this.userSessions.delete(uid);

      return {
        success: true,
        channelName: session.channelName,
        message: "User left channel successfully",
      };
    } catch (error) {
      console.error("Failed to leave channel:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async stopLiveProctoring(sessionId) {
    try {
      const result = await this.liveProcessor.stopLiveProcessing(sessionId);

      return result;
    } catch (error) {
      console.error("❌ Failed to stop live proctoring:", error);
      return null;
    }
  }

  getChannelStats(channelName) {
    const channel = this.activeChannels.get(channelName);

    if (!channel) {
      return null;
    }

    return {
      channelName,
      studentCount: channel.students.size,
      proctorCount: channel.proctors.size,
      totalUsers: channel.students.size + channel.proctors.size,
      maxStudents: channel.maxStudents,
      maxProctors: channel.maxProctors,
      createdAt: channel.createdAt,
      isActive: channel.isActive,
      examInfo: channel.examInfo,
    };
  }

  getAllActiveChannels() {
    const channels = [];

    for (const [channelName, channel] of this.activeChannels) {
      if (channel.isActive) {
        channels.push(this.getChannelStats(channelName));
      }
    }

    return channels;
  }

  getUserSession(uid) {
    return this.userSessions.get(uid) || null;
  }

  async closeChannel(channelName) {
    try {
      const channel = this.activeChannels.get(channelName);

      if (!channel) {
        return {
          success: true,
          message: "Channel not found (may already be closed)",
        };
      }

      channel.isActive = false;

      const usersToRemove = [];
      for (const [uid, session] of this.userSessions) {
        if (session.channelName === channelName) {
          usersToRemove.push(uid);
        }
      }

      usersToRemove.forEach((uid) => {
        this.userSessions.delete(uid);
      });

      return {
        success: true,
        channelName,
        removedUsers: usersToRemove.length,
        message: "Channel closed successfully",
      };
    } catch (error) {
      console.error("Failed to close channel:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  refreshUserToken(uid, expirationTime = 3600) {
    try {
      const session = this.userSessions.get(uid);

      if (!session) {
        throw new Error("User session not found");
      }

      const token = this.generateToken(
        session.channelName,
        uid,
        session.role,
        expirationTime
      );

      return {
        success: true,
        token,
        channelName: session.channelName,
        expiresIn: expirationTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Backward compatibility - but now actually creates the channel
  async createChannel(channelName) {
    const result = await this.createProctoringChannel(channelName, {
      students: [],
      proctors: [],
    });

    return {
      success: result.success,
      channelName,
      appId: this.appId,
    };
  }

  // Utility method to check if channel exists
  channelExists(channelName) {
    return this.activeChannels.has(channelName);
  }
}

module.exports = new AgoraService();
