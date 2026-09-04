// services/proctoring-analytics/agoraAudioProcessor.js
// --- AWS SDK (kept for reference) ---
// const AWS = require("aws-sdk");
const axios = require("axios"); // Add this import
const path = require("path");
const fs = require("fs");
const AudioProctoringAnalyzer = require("./audioAnalyzer");

// --- Azure Blob Storage ---
const azureBlobService = require("../../../shared/utils/azureBlobService");

class AgoraAudioProcessor {
  constructor() {
    this.audioAnalyzer = new AudioProctoringAnalyzer();
    this.recordingClients = new Map(); // sessionId -> recording client
    this.activeRecordings = new Map(); // sessionId -> recording details

    // --- AWS S3 client (kept for reference) ---
    // this.s3 = new AWS.S3({
    //   region: process.env.AWS_REGION,
    //   credentials: {
    //     accessKeyId: process.env.AWS_REKOG_KEY,
    //     secretAccessKey: process.env.AWS_REKOG_SECRET,
    //   },
    // });

    this.containerName = process.env.AZURE_PROCTORING_CONTAINER_NAME || "proctoringrecordings";
  }

  // ✅ ADD THE MISSING METHOD
  async analyzeAudioBuffer(audioBuffer, sessionId, duration = 5000) {
    try {
      // Delegate to the internal audio analyzer
      return await this.audioAnalyzer.analyzeAudioBuffer(
        audioBuffer,
        sessionId,
        duration
      );
    } catch (error) {
      console.error(
        "❌ AgoraAudioProcessor: Audio buffer analysis failed:",
        error
      );
      throw error;
    }
  }

  // ✅ ADD WRAPPER FOR DIRECT AUDIO ANALYSIS
  async analyzeAudio(audioData, sessionId, studentUID) {
    try {
      return await this.audioAnalyzer.analyzeAudio(
        audioData,
        sessionId,
        studentUID
      );
    } catch (error) {
      console.error("❌ AgoraAudioProcessor: Audio analysis failed:", error);
      throw error;
    }
  }

  // Start audio analysis using Agora Cloud Recording
  async startAudioAnalysis(sessionId, channelName, studentUID) {
    try {
      // Validate required environment variables
      const requiredEnvVars = [
        "AWS_REGION",
        "AWS_S3_BUCKET",
        "AGORA_APP_ID",
        "AGORA_CUSTOMER_ID",
        "AGORA_CUSTOMER_SECRET",
      ];
      const missing = requiredEnvVars.filter((envVar) => !process.env[envVar]);

      if (missing.length > 0) {
        throw new Error(
          `Missing required environment variables: ${missing.join(", ")}`
        );
      }

      // First acquire a resource ID
      const resourceId = await this.acquireAgoraResource(
        channelName,
        `audio_analyzer_${sessionId}`
      );

      // Use Agora Cloud Recording API to capture audio
      const recordingConfig = {
        cname: channelName,
        uid: `audio_analyzer_${sessionId}`,
        clientRequest: {
          recordingConfig: {
            channelType: 0,
            streamTypes: 1, // Audio only
            audioProfile: 1,
            maxIdleTime: 30,
            transcodingConfig: {
              width: 0, // Audio only
              height: 0,
              fps: 0,
              bitrate: 0,
              audioSampleRate: 48000,
              audioChannels: 1,
            },
          },
          storageConfig: {
            vendor: 5, // Azure Blob Storage (was 1 for AWS S3)
            region: 0, // Not used for Azure
            bucket: this.containerName,
            accessKey: process.env.AZURE_STORAGE_ACCOUNT_NAME,
            secretKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
            fileNamePrefix: [`audio_analysis/${sessionId}`],
          },
        },
      };

      // Start recording
      const recordingId = await this.startAgoraRecording(
        resourceId,
        recordingConfig
      );

      // Store recording details
      this.activeRecordings.set(sessionId, {
        resourceId,
        recordingId: recordingId.sid,
        channelName,
        studentUID,
        startTime: new Date(),
      });

      // Monitor for new audio files and analyze them
      this.monitorAudioFiles(sessionId, recordingId.sid, studentUID);

      return recordingId.sid;
    } catch (error) {
      console.error("❌ Failed to start audio analysis:", error);
      throw error;
    }
  }

  // ✅ FIXED: Add acquire resource method
  async acquireAgoraResource(channelName, uid) {
    try {
      const url = `https://api.agora.io/v1/apps/${process.env.AGORA_APP_ID}/cloud_recording/acquire`;

      const body = {
        cname: channelName,
        uid: uid,
        clientRequest: {
          resourceExpiredHour: 24,
          scene: 0,
        },
      };

      const credential = this.generateAgoraCredential();
      const response = await axios.post(url, body, {
        headers: {
          Authorization: `Basic ${credential}`,
          "Content-Type": "application/json",
        },
      });

      if (response.data && response.data.resourceId) {
        return response.data.resourceId;
      } else {
        throw new Error("Failed to acquire Agora resource");
      }
    } catch (error) {
      console.error("❌ Failed to acquire Agora resource:", error);
      throw error;
    }
  }

  // ✅ FIXED: Monitor audio files with better error handling
  async monitorAudioFiles(sessionId, recordingId, studentUID) {
    const monitoringInterval = setInterval(async () => {
      try {
        // Check if session is still active
        if (!this.activeRecordings.has(sessionId)) {
          clearInterval(monitoringInterval);
          return;
        }

        // List recent audio files from Azure Blob (Agora recording)
        const objects = await azureBlobService.listBlobs(
          this.containerName,
          `audio_analysis/${sessionId}/`,
          10
        );

        if (!objects || objects.length === 0) {
          return;
        }

        // Process latest audio files
        for (const obj of objects) {
          if (
            obj.Key.endsWith(".m4a") ||
            obj.Key.endsWith(".wav") ||
            obj.Key.endsWith(".aac")
          ) {
            await this.processAudioFile(sessionId, obj.Key, studentUID);
          }
        }
      } catch (error) {
        console.error("❌ Audio monitoring error:", error);
      }
    }, 30000); // Check every 30 seconds

    // Store interval reference for cleanup
    this.recordingClients.set(sessionId, monitoringInterval);
  }

  // ✅ FIXED: Process audio file with better error handling
  async processAudioFile(sessionId, s3Key, studentUID) {
    try {
      // Download audio file from Azure Blob
      const audioBody = await azureBlobService.downloadBlob(
        this.containerName,
        s3Key
      );

      if (!audioBody || audioBody.length === 0) {
        console.warn(`⚠️ Empty audio file: ${s3Key}`);
        return;
      }

      // Analyze with AWS services
      const analysis = await this.audioAnalyzer.analyzeAudio(
        audioBody,
        sessionId,
        studentUID
      );

      // Process violations if any
      if (analysis.violations && analysis.violations.length > 0) {
        await this.handleAudioViolations(sessionId, analysis);
      }

      // Clean up processed file from Azure Blob
      await azureBlobService.deleteBlob(
        this.containerName,
        s3Key
      );
    } catch (error) {
      console.error(`❌ Audio file processing error for ${s3Key}:`, error);
    }
  }

  // ✅ FIXED: Handle audio violations with proper error handling
  async handleAudioViolations(sessionId, analysis) {
    try {
      // Store violations in database (if available)
      try {
        const { proctoringSessions } =
          require("../../../shared/db/connection").connectTodb();

        await proctoringSessions.updateOne(
          { _id: sessionId },
          {
            $push: {
              audioViolations: {
                ...analysis,
                timestamp: new Date(),
              },
              violations: {
                type: "AUDIO_VIOLATION",
                analysis,
                timestamp: new Date(),
              },
            },
          }
        );
      } catch (dbError) {
        console.warn(
          `⚠️ Could not store violations in database:`,
          dbError.message
        );
      }

      // Send real-time notification to proctors
      try {
        const io = require("../../socket/socketManager");
        io.to(`session_${sessionId}`).emit("audio_violation", {
          sessionId,
          analysis,
          timestamp: new Date(),
        });
      } catch (socketError) {
        console.warn(
          `⚠️ Could not send real-time notification:`,
          socketError.message
        );
      }
    } catch (error) {
      console.error(`❌ Failed to handle audio violations:`, error);
    }
  }

  // ✅ FIXED: Start Agora recording with proper API implementation
  async startAgoraRecording(resourceId, config) {
    try {
      // Use Agora Cloud Recording REST API
      const url = `https://api.agora.io/v1/apps/${process.env.AGORA_APP_ID}/cloud_recording/resourceid/${resourceId}/mode/individual/start`;

      const credential = this.generateAgoraCredential();
      const response = await axios.post(url, config, {
        headers: {
          Authorization: `Basic ${credential}`,
          "Content-Type": "application/json",
        },
      });

      if (response.data && response.data.sid) {
        return response.data;
      } else {
        throw new Error("Invalid response from Agora recording start");
      }
    } catch (error) {
      console.error("❌ Failed to start Agora recording:", error);
      throw error;
    }
  }

  // ✅ ADD: Generate Agora credential
  generateAgoraCredential() {
    const credential = Buffer.from(
      `${process.env.AGORA_CUSTOMER_ID}:${process.env.AGORA_CUSTOMER_SECRET}`
    ).toString("base64");
    return credential;
  }

  // ✅ ADD: Get AWS region code for Agora
  getAWSRegionCode(region) {
    const regionMap = {
      "us-east-1": 0,
      "us-east-2": 1,
      "us-west-1": 2,
      "us-west-2": 3,
      "eu-west-1": 4,
      "eu-west-2": 5,
      "eu-west-3": 6,
      "eu-central-1": 7,
      "ap-southeast-1": 8,
      "ap-southeast-2": 9,
      "ap-northeast-1": 10,
      "ap-northeast-2": 11,
      "ap-south-1": 12,
      "cn-north-1": 13,
      "cn-east-2": 14,
      "ca-central-1": 15,
      "ap-northeast-3": 16,
      "us-gov-west-1": 17,
      "ap-northeast-1": 18,
    };

    return regionMap[region] || 12; // Default to us-east-1
  }

  // ✅ ADD: Stop audio analysis
  async stopAudioAnalysis(sessionId) {
    try {
      const recordingDetails = this.activeRecordings.get(sessionId);
      if (!recordingDetails) {
        console.warn(`⚠️ No active recording found for session: ${sessionId}`);
        return;
      }

      // Stop Agora recording
      const url = `https://api.agora.io/v1/apps/${process.env.AGORA_APP_ID}/cloud_recording/resourceid/${recordingDetails.resourceId}/sid/${recordingDetails.recordingId}/mode/individual/stop`;

      const credential = this.generateAgoraCredential();
      const response = await axios.post(
        url,
        {
          cname: recordingDetails.channelName,
          uid: `audio_analyzer_${sessionId}`,
          clientRequest: {},
        },
        {
          headers: {
            Authorization: `Basic ${credential}`,
            "Content-Type": "application/json",
          },
        }
      );

      // Clear monitoring interval
      const monitoringInterval = this.recordingClients.get(sessionId);
      if (monitoringInterval) {
        clearInterval(monitoringInterval);
        this.recordingClients.delete(sessionId);
      }

      // Clean up recording details
      this.activeRecordings.delete(sessionId);

      return response.data;
    } catch (error) {
      console.error(
        `❌ Failed to stop audio analysis for session: ${sessionId}`,
        error
      );
      throw error;
    }
  }

  // ✅ ADD: Get active recordings
  getActiveRecordings() {
    return Array.from(this.activeRecordings.entries()).map(
      ([sessionId, details]) => ({
        sessionId,
        ...details,
      })
    );
  }

  // ✅ ADD: Get recording status
  getRecordingStatus(sessionId) {
    return this.activeRecordings.get(sessionId) || null;
  }
}

module.exports = AgoraAudioProcessor;
