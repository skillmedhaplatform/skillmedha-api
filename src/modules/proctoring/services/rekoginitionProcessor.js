// services/proctoring-analytics/rekoginitionProcessor.js - CLEANED VERSION
require("dotenv").config({
  path: "../../../.env",
});

const {
  RekognitionClient,
  DetectFacesCommand,
  CompareFacesCommand,
} = require("@aws-sdk/client-rekognition");
// --- AWS S3 (kept for reference) ---
// const { S3Client } = require("@aws-sdk/client-s3");

// --- Azure Blob Storage ---
const azureBlobService = require("../../../shared/utils/azureBlobService");
const ProctoringConfiguration = require("./proctoringConfig");
const GazeTrackingAnalyzer = require("./gazeTrackingAnalyzer");
const AWSVideoProcessor = require("./awsVideoProcessor");
const AudioProctoringAnalyzer = require("./audioProctoring");
const axios = require("axios");

class EnhancedRekognitionAnalyzer {
  constructor() {
    this.configureAWSv3();
    this.configManager = new ProctoringConfiguration();
    this.activeTimers = new Map();
    this.sessionConfigs = new Map();
    this.gazeAnalyzers = new Map();
    this.notificationCallbacks = new Map();
    this.videoProcessor = new AWSVideoProcessor();
    this.audioAnalyzer = new AudioProctoringAnalyzer();
    this.audioBuffers = new Map();
  }

  configureAWSv3() {
    try {
      // Validate required environment variables
      const requiredVars = {
        AWS_REGION: process.env.AWS_REGION,
        AWS_REKOG_KEY: process.env.AWS_REKOG_KEY,
        AWS_REKOG_SECRET: process.env.AWS_REKOG_SECRET,
      };

      const missingVars = [];
      for (const [key, value] of Object.entries(requiredVars)) {
        if (!value) {
          missingVars.push(key);
        }
      }

      if (missingVars.length > 0) {
        throw new Error(
          `Missing required environment variables: ${missingVars.join(", ")}`
        );
      }

      this.rekognitionClient = new RekognitionClient({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_REKOG_KEY,
          secretAccessKey: process.env.AWS_REKOG_SECRET,
        },
      });

      // --- AWS S3 client (kept for reference) ---
      // this.s3Client = new S3Client({
      //   region: process.env.AWS_REGION,
      //   credentials: {
      //     accessKeyId: process.env.AWS_KEY_S3,
      //     secretAccessKey: process.env.AWS_SECRET_S3,
      //   },
      // });

      // Azure Blob client is managed by azureBlobService singleton
      this.containerName = process.env.AZURE_PROCTORING_CONTAINER_NAME || "proctoringrecordings";
    } catch (error) {
      console.error("❌ AWS/Azure configuration failed:", error.message);
      throw error;
    }
  }

  async startRandomizedAnalysis(
    sessionId,
    customConfig = null,
    notificationCallback = null
  ) {
    try {
      const config = customConfig || this.configManager.defaultConfig;
      this.sessionConfigs.set(sessionId, config);

      if (config.gazeDetection?.enabled) {
        const gazeAnalyzer = new GazeTrackingAnalyzer(config);
        this.gazeAnalyzers.set(sessionId, gazeAnalyzer);
      }

      if (notificationCallback) {
        this.notificationCallbacks.set(sessionId, notificationCallback);
      }

      // Don't stop existing analysis, just start new one
      this.scheduleNextAnalysis(sessionId, config);

      // Start video recording
      const recordingResult = await this.videoProcessor.startRecording(
        sessionId,
        config.studentId || "unknown"
      );
      if (recordingResult.success) {}
    } catch (error) {
      console.error("❌ Failed to start randomized analysis:", error);
      throw error;
    }
  }

  scheduleNextAnalysis(sessionId, config) {
    if (!config.analysisInterval.enabled) {
      return;
    }

    const nextInterval = this.configManager.generateRandomInterval(config);

    const timer = setTimeout(async () => {
      await this.performComprehensiveAnalysis(sessionId);
      const updatedConfig = this.sessionConfigs.get(sessionId);
      if (updatedConfig) {
        this.scheduleNextAnalysis(sessionId, updatedConfig);
      }
    }, nextInterval * 1000);

    // Clear existing timer if any
    const existingTimer = this.activeTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.activeTimers.set(sessionId, timer);
  }

  // async captureFrameFromAgora(sessionId) {
  //   try {
  //     if (!process.env.SOCKET_SERVER_URL) {
  //       console.warn(
  //         "⚠️ No SOCKET_SERVER_URL configured, skipping frame capture"
  //       );
  //       return null;
  //     }

  //     console.log("📸 Requesting frame capture from socket server...");
  //     const response = await axios.post(
  //       `${process.env.SOCKET_SERVER_URL}/request-frame-capture`,
  //       {
  //         sessionId: sessionId.toString(),
  //         timestamp: Date.now(),
  //       },
  //       {
  //         timeout: 10000, // Increased timeout
  //         headers: {
  //           "Content-Type": "application/json",
  //           // Add any required auth headers here if needed
  //         },
  //       }
  //     );

  //     if (response.data.success && response.data.frameBuffer) {
  //       const frameBuffer = Buffer.from(response.data.frameBuffer, "base64");
  //       console.log(
  //         "✅ Frame captured from socket server, size:",
  //         frameBuffer.length
  //       );
  //       return frameBuffer;
  //     } else {
  //       console.warn("⚠️ Frame capture succeeded but no frame buffer returned");
  //       return null;
  //     }
  //   } catch (error) {
  //     console.warn(
  //       "⚠️ Frame capture from socket server failed:",
  //       error.message
  //     );

  //     // ✅ Don't throw error, just log and continue
  //     if (error.response) {
  //       console.warn("Response status:", error.response.status);
  //       console.warn("Response data:", error.response.data);
  //     }

  //     return null;
  //   }
  // }

  // ✅ Enhanced analysis with better error handling
  // async performComprehensiveAnalysis(sessionId) {
  //   try {
  //     console.log(
  //       `🔍 Performing comprehensive analysis for session ${sessionId}`
  //     );

  //     // Try to capture frame
  //     const frameBuffer = await this.captureFrameFromAgora(sessionId);

  //     if (!frameBuffer) {
  //       console.log(
  //         "⚠️ No frame available for scheduled analysis - skipping this cycle"
  //       );
  //       return; // Don't throw error, just skip this analysis cycle
  //     }

  //     const config = this.sessionConfigs.get(sessionId);
  //     const gazeAnalyzer = this.gazeAnalyzers.get(sessionId);

  //     // Process with video processor
  //     const videoAnalysis = await this.videoProcessor.processVideoFrame(
  //       sessionId,
  //       frameBuffer,
  //       Date.now()
  //     );

  //     // Gaze analysis (if enabled)
  //     let gazeAnalysis = null;
  //     if (gazeAnalyzer) {
  //       gazeAnalysis = await gazeAnalyzer.analyzeGaze(
  //         frameBuffer,
  //         sessionId,
  //         "student"
  //       );
  //     }

  //     // Combine results
  //     const combinedAnalysis = {
  //       sessionId,
  //       timestamp: new Date(),
  //       videoAnalysis: videoAnalysis.analysis,
  //       gaze: gazeAnalysis,
  //       overallViolations: this.combineViolations(
  //         videoAnalysis.analysis,
  //         gazeAnalysis
  //       ),
  //     };

  //     // Process results
  //     await this.processAnalysisResults(sessionId, combinedAnalysis);
  //   } catch (error) {
  //     console.error(`❌ Analysis failed for session ${sessionId}:`, error);
  //     // Don't re-throw - let the interval continue
  //   }
  // }

  // combineViolations(videoAnalysis, gazeAnalysis) {
  //   const allViolations = [
  //     ...(videoAnalysis?.violations || []),
  //     ...(gazeAnalysis?.gazeViolations || []),
  //   ];

  //   return allViolations.sort((a, b) => {
  //     const severityOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  //     return (
  //       (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0)
  //     );
  //   });
  // }

  async captureFrameFromAgora(sessionId) {
    try {
      if (!process.env.SOCKET_SERVER_URL) {
        console.warn(
          "⚠️ No SOCKET_SERVER_URL configured, skipping frame capture"
        );
        return null;
      }

      const response = await axios.post(
        `${process.env.SOCKET_SERVER_URL}/request-frame-capture`,
        {
          sessionId: sessionId.toString(),
          timestamp: Date.now(),
          includeAudio: true, // Request audio along with video
        },
        {
          timeout: 15000, // Increased timeout for audio processing
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data.success) {
        let result = {};
        // Process video frame
        if (response.data.frameBuffer) {
          result.frameBuffer = Buffer.from(response.data.frameBuffer, "base64");
        }

        // Process audio buffer
        if (response.data.audioBuffer) {
          result.audioBuffer = Buffer.from(response.data.audioBuffer, "base64");
          result.audioDuration = response.data.audioDuration || 5000;
        }

        return result;
      }

      return null;
    } catch (error) {
      console.warn("⚠️ Frame/Audio capture failed:", error.message);
      return null;
    }
  }

  // Enhanced analysis with audio processing
  async performComprehensiveAnalysis(sessionId) {
    try {
      // Capture frame and audio
      const captureData = await this.captureFrameFromAgora(sessionId);

      if (!captureData) {
        return;
      }

      const config = this.sessionConfigs.get(sessionId);
      const gazeAnalyzer = this.gazeAnalyzers.get(sessionId);

      let videoAnalysis = null;
      let audioAnalysis = null;

      // Process video if available
      if (captureData.frameBuffer) {
        videoAnalysis = await this.videoProcessor.processVideoFrame(
          sessionId,
          captureData.frameBuffer,
          Date.now()
        );
      }

      // Process audio if available
      if (captureData.audioBuffer) {
        audioAnalysis = await this.analyzeAudioBuffer(
          sessionId,
          captureData.audioBuffer,
          captureData.audioDuration
        );
      }

      // Gaze analysis (if enabled)
      let gazeAnalysis = null;
      if (gazeAnalyzer && captureData.frameBuffer) {
        gazeAnalysis = await gazeAnalyzer.analyzeGaze(
          captureData.frameBuffer,
          sessionId,
          "student"
        );
      }

      // Combine all results
      const combinedAnalysis = {
        sessionId,
        timestamp: new Date(),
        videoAnalysis: videoAnalysis?.analysis,
        audioAnalysis: audioAnalysis,
        gaze: gazeAnalysis,
        overallViolations: this.combineAllViolations(
          videoAnalysis?.analysis,
          audioAnalysis,
          gazeAnalysis
        ),
        frameUrl: videoAnalysis?.frameUrl || null,
      };

      await this.processAnalysisResults(sessionId, combinedAnalysis);
    } catch (error) {
      console.error(`❌ Analysis failed for session ${sessionId}:`, error);
    }
  }

  // New method to analyze audio buffer
  async analyzeAudioBuffer(sessionId, audioBuffer, duration) {
    try {
      // Use your audio analyzer
      const analysis =
        await this.audioAnalyzer.audioAnalyzer.analyzeAudioBuffer(
          audioBuffer,
          sessionId,
          duration
        );

      return analysis;
    } catch (error) {
      console.error("❌ Audio analysis failed:", error);
      return { violations: [], error: error.message };
    }
  }

  // Enhanced violation combining
  combineAllViolations(videoAnalysis, audioAnalysis, gazeAnalysis) {
    const allViolations = [
      ...(videoAnalysis?.violations || []),
      ...(audioAnalysis?.violations || []),
      ...(gazeAnalysis?.gazeViolations || []),
    ];

    return allViolations.sort((a, b) => {
      const severityOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return (
        (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0)
      );
    });
  }

  async processAnalysisResults(sessionId, analysis) {
    if (analysis.overallViolations.length > 0) {
      await this.storeViolations(sessionId, analysis);
      await this.sendViolationToSocketServer(sessionId, analysis);

      const callback = this.notificationCallbacks.get(sessionId);
      if (callback) {
        callback(analysis);
      }
    } else {}
  }

  async storeViolations(sessionId, analysis) {
    try {} catch (error) {
      console.error("❌ Failed to store violations:", error);
    }
  }

  async sendViolationToSocketServer(sessionId, analysis) {
    try {
      if (!process.env.SOCKET_SERVER_URL) {
        console.warn(
          "⚠️ No SOCKET_SERVER_URL configured, skipping violation alert"
        );
        return;
      }
      await axios.post(
        `${process.env.SOCKET_SERVER_URL}/send-violation-alert`,
        {
          sessionId: sessionId.toString(),
          violation: analysis.overallViolations,
          analysis: analysis,
          timestamp: new Date(),
        }
      );
    } catch (error) {
      console.error("❌ Failed to send violation to socket server:", error);
    }
  }

  stopAnalysis(sessionId) {
    const timer = this.activeTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(timer);
    }

    // End video recording
    this.videoProcessor
      .endRecording(sessionId)
      .then((result) => {
        if (result.success) {}
      })
      .catch((err) => console.error("Failed to end recording:", err));

    this.sessionConfigs.delete(sessionId);
    this.gazeAnalyzers.delete(sessionId);
    this.notificationCallbacks.delete(sessionId);
  }

  // Delegate methods to video processor
  getRecordingStatus(sessionId) {
    return this.videoProcessor.getRecordingStatus(sessionId);
  }

  getAllActiveRecordings() {
    return this.videoProcessor.getAllActiveRecordings();
  }

  updateSessionConfig(sessionId, newConfig) {
    if (this.sessionConfigs.has(sessionId)) {
      const updatedConfig = {
        ...this.sessionConfigs.get(sessionId),
        ...newConfig,
      };
      this.sessionConfigs.set(sessionId, updatedConfig);

      const gazeAnalyzer = this.gazeAnalyzers.get(sessionId);
      if (gazeAnalyzer && newConfig.gazeDetection) {
        gazeAnalyzer.updateConfig(newConfig.gazeDetection);
      }

      return true;
    }
    return false;
  }

  getNextAnalysisTime(sessionId) {
    const timer = this.activeTimers.get(sessionId);
    if (timer) {
      const config = this.sessionConfigs.get(sessionId);
      return this.configManager.generateRandomInterval(config);
    }
    return null;
  }
}

module.exports = EnhancedRekognitionAnalyzer;
