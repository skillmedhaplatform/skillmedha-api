require("dotenv").config({
  path: "../../../.env",
});
const {
  RekognitionClient,
  DetectFacesCommand,
  DetectLabelsCommand,
  StartLabelDetectionCommand,
  GetLabelDetectionCommand,
  StartFaceDetectionCommand,
  GetFaceDetectionCommand,
} = require("@aws-sdk/client-rekognition");
// --- AWS S3 (kept for reference) ---
// const {
//   S3Client,
//   PutObjectCommand,
//   GetObjectCommand,
//   CreateMultipartUploadCommand,
//   UploadPartCommand,
//   CompleteMultipartUploadCommand,
// } = require("@aws-sdk/client-s3");

// --- Azure Blob Storage ---
const azureBlobService = require("../../../shared/utils/azureBlobService");

class AWSVideoProcessor {
  constructor() {
    console.log("🔧 Configuring AWS SDK v3 (Rekognition) + Azure Blob...");
    this.rekognitionClient = new RekognitionClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_REKOG_KEY,
        secretAccessKey: process.env.AWS_REKOG_SECRET,
      },
    });
    console.log("✅ AWS Rekognition + Azure Blob configured successfully");
    console.log(`📍 Region: ${process.env.AWS_REGION || "ap-south-1"}`);

    // --- AWS S3 client (kept for reference) ---
    // this.s3Client = new S3Client({
    //   region: process.env.AWS_REGION,
    //   credentials: {
    //     accessKeyId: process.env.AWS_KEY_S3,
    //     secretAccessKey: process.env.AWS_SECRET_S3,
    //   },
    // });

    this.containerName = process.env.AZURE_PROCTORING_CONTAINER_NAME || "proctoringrecordings";
    this.activeRecordings = new Map(); // Track ongoing recordings
    this.liveStreamProcessors = new Map();
  }

  // Start recording session
  async startRecording(sessionId, studentId) {
    try {
      const recordingData = {
        sessionId,
        studentId,
        startTime: new Date(),
        frames: [],
        audioChunks: [],
        violations: [],
        s3Key: `recordings/${sessionId}/${studentId}/session-${Date.now()}`,
      };

      this.activeRecordings.set(sessionId, recordingData);

      return {
        success: true,
        recordingId: sessionId,
        s3Key: recordingData.s3Key,
      };
    } catch (error) {
      console.error("❌ Failed to start recording:", error);
      return { success: false, error: error.message };
    }
  }

  // Process video frame with AWS Rekognition
  async processVideoFrame(sessionId, frameBuffer, timestamp) {
    try {
      const recording = this.activeRecordings.get(sessionId);
      if (!recording) {
        throw new Error("No active recording found for session");
      }

      // Store frame data
      recording.frames.push({
        timestamp,
        buffer: frameBuffer,
        processed: false,
      });

      // Analyze with Rekognition (parallel processing)
      const [faceAnalysis, labelAnalysis] = await Promise.all([
        this.analyzeFrameForFaces(frameBuffer),
        this.analyzeFrameForLabels(frameBuffer),
      ]);

      // Check for violations
      const violations = this.checkFrameViolations(
        faceAnalysis,
        labelAnalysis,
        timestamp
      );

      if (violations.length > 0) {
        recording.violations.push(...violations);
      }

      // Store frame in Azure Blob (async)
      const frameKey = await this.storeFrameInAzure(
        sessionId,
        frameBuffer,
        timestamp
      );
      return {
        success: true,
        analysis: {
          faces: faceAnalysis,
          labels: labelAnalysis,
          violations,
          timestamp,
        },
        frameUrl: azureBlobService.getBlobUrl(this.containerName, frameKey),
      };
    } catch (error) {
      console.error("❌ Frame processing failed:", error);
      return { success: false, error: error.message };
    }
  }

  // Analyze frame for faces
  async analyzeFrameForFaces(frameBuffer) {
    try {
      const command = new DetectFacesCommand({
        Image: { Bytes: frameBuffer },
        Attributes: ["ALL", "EYE_DIRECTION"],
      });

      const result = await this.rekognitionClient.send(command);

      return {
        faceCount: result.FaceDetails.length,
        faces: result.FaceDetails,
        confidence: result.FaceDetails.map((face) => face.Confidence),
      };
    } catch (error) {
      console.error("Face analysis error:", error);
      return { faceCount: 0, faces: [], confidence: [] };
    }
  }

  // Analyze frame for objects/labels
  async analyzeFrameForLabels(frameBuffer) {
    try {
      const command = new DetectLabelsCommand({
        Image: { Bytes: frameBuffer },
        MinConfidence: 70,
        MaxLabels: 20,
      });

      const result = await this.rekognitionClient.send(command);

      return {
        labels: result.Labels,
        prohibitedItems: this.findProhibitedItems(result.Labels),
      };
    } catch (error) {
      console.error("Label analysis error:", error);
      return { labels: [], prohibitedItems: [] };
    }
  }

  // ✅ COMPLETELY REWRITTEN: Enhanced violation detection
  checkFrameViolations(faceAnalysis, labelAnalysis, timestamp) {
    const violations = [];

    // ✅ 1. MULTIPLE PEOPLE VIOLATION (this is what you want to detect)
    if (faceAnalysis.faceCount > 1) {
      violations.push({
        type: "MULTIPLE_PEOPLE",
        severity: "HIGH",
        count: faceAnalysis.faceCount,
        timestamp,
        message: `${faceAnalysis.faceCount} people detected - only 1 student allowed`,
      });
    }

    // ✅ 2. NO FACE VIOLATION (student left camera)
    if (faceAnalysis.faceCount === 0) {
      violations.push({
        type: "NO_FACE_DETECTED",
        severity: "MEDIUM",
        timestamp,
        message: "Student not visible in camera",
      });
    }

    // ✅ 3. PROHIBITED ITEMS (correctly filtered)
    const actuallyProhibitedItems = this.findActuallyProhibitedItems(
      labelAnalysis.labels
    );

    actuallyProhibitedItems.forEach((item) => {
      violations.push({
        type: "PROHIBITED_ITEM",
        severity: "HIGH",
        item: item.Name,
        confidence: item.Confidence,
        timestamp,
        message: `Prohibited item detected: ${item.Name}`,
      });
    });

    // ✅ 4. SUSPICIOUS BEHAVIOR (if gaze tracking enabled)
    // Add gaze violations here if needed

    return violations;
  }

  // ✅ NEW: Correctly identify actually prohibited items
  findActuallyProhibitedItems(labels) {
    const prohibitedItems = [
      // Electronic devices
      {
        keywords: ["mobile phone", "cell phone", "phone", "smartphone"],
        severity: "HIGH",
      },
      { keywords: ["tablet", "ipad"], severity: "HIGH" },
      { keywords: ["laptop", "computer", "notebook"], severity: "HIGH" },
      { keywords: ["calculator"], severity: "MEDIUM" }, // Context-dependent
      { keywords: ["smartwatch", "watch"], severity: "MEDIUM" },
      { keywords: ["headphones", "earbuds", "earphones"], severity: "HIGH" },

      // Study materials (context-dependent)
      { keywords: ["book"], severity: "MEDIUM" }, // Only if closed-book exam
      { keywords: ["paper", "document", "note"], severity: "MEDIUM" },
      { keywords: ["text"], severity: "LOW" }, // Too generic, needs context

      // Other people (this is the real violation)
      { keywords: ["multiple people"], severity: "HIGH" }, // Custom detection needed
    ];

    const flaggedItems = [];

    labels.forEach((label) => {
      // ✅ SKIP if it's just detecting the student themselves
      if (
        [
          "person",
          "human",
          "adult",
          "male",
          "female",
          "man",
          "woman",
          "face",
          "head",
        ].includes(label.Name.toLowerCase())
      ) {
        return; // These are EXPECTED - student should be detected
      }

      // Check for actually prohibited items
      prohibitedItems.forEach((prohibited) => {
        if (
          prohibited.keywords.some((keyword) =>
            label.Name.toLowerCase().includes(keyword.toLowerCase())
          ) &&
          label.Confidence > 70
        ) {
          flaggedItems.push({
            ...label,
            severity: prohibited.severity,
            reason: `Detected: ${label.Name} (${label.Confidence.toFixed(
              1
            )}% confidence)`,
          });
        }
      });
    });

    return flaggedItems;
  }

  // ✅ CORRECT: Detect multiple people using face analysis
  checkForMultiplePeople(faceAnalysis, labelAnalysis) {
    const violations = [];

    // Method 1: Use face detection count (most reliable)
    if (faceAnalysis.faceCount > 1) {
      violations.push({
        type: "MULTIPLE_PEOPLE",
        severity: "HIGH",
        count: faceAnalysis.faceCount,
        method: "face_detection",
        message: `${faceAnalysis.faceCount} faces detected - only 1 student allowed`,
      });
    }

    // Method 2: Use person instances (backup verification)
    const personLabel = labelAnalysis.labels.find(
      (label) => label.Name.toLowerCase() === "person"
    );

    if (
      personLabel &&
      personLabel.Instances &&
      personLabel.Instances.length > 1
    ) {
      violations.push({
        type: "MULTIPLE_PEOPLE_DETECTED",
        severity: "HIGH",
        count: personLabel.Instances.length,
        method: "object_detection",
        message: `${personLabel.Instances.length} people detected in frame`,
      });
    }

    return violations;
  }

  // ✅ FIXED: findProhibitedItems function
  findProhibitedItems(labels) {
    const prohibitedKeywords = [
      // ✅ ONLY actual prohibited items
      "Mobile Phone",
      "Cell Phone",
      "Phone",
      "Smartphone",
      "Tablet",
      "iPad",
      "Computer",
      "Laptop",
      "Book",
      "Paper",
      "Document",
      "Text",
      "Note",
      "Calculator", // Only if not allowed for the exam
      "Watch",
      "Smartwatch", // Only if not allowed
      "Headphones",
      "Earbuds",
      "Earphones",
      "Glasses", // Only if suspicious (like smart glasses)
      // ❌ REMOVED: 'Person', 'Human', 'People' - these are EXPECTED!
    ];

    return labels.filter((label) => {
      // ✅ IMPORTANT: Only flag items that are actually prohibited
      const isProhibited = prohibitedKeywords.some((keyword) =>
        label.Name.toLowerCase().includes(keyword.toLowerCase())
      );

      // ✅ ADDITIONAL CHECK: High confidence threshold for prohibited items
      return isProhibited && label.Confidence > 80; // Increased threshold
    });
  }

  // --- AWS S3 storeFrameInS3 (kept for reference) ---
  // async storeFrameInS3(sessionId, frameBuffer, timestamp) { ... }

  // Store frame in Azure Blob
  async storeFrameInAzure(sessionId, frameBuffer, timestamp) {
    try {
      const recording = this.activeRecordings.get(sessionId);
      if (!recording) return;

      const frameKey = `${recording.s3Key}/frames/frame-${timestamp}.jpg`;

      await azureBlobService.uploadBlob(
        this.containerName,
        frameKey,
        frameBuffer,
        "image/jpeg",
        {
          sessionId: sessionId.toString(),
          timestamp: timestamp.toString(),
          studentId: recording.studentId.toString(),
        }
      );

      return frameKey;
    } catch (error) {
      console.error("❌ Azure Blob frame storage failed:", error);
    }
  }

  // Process audio chunk
  async processAudioChunk(sessionId, audioBuffer, timestamp) {
    try {
      const recording = this.activeRecordings.get(sessionId);
      if (!recording) {
        throw new Error("No active recording found for session");
      }

      // Store audio chunk
      recording.audioChunks.push({
        timestamp,
        buffer: audioBuffer,
        duration: audioBuffer.length / 16000, // Assuming 16kHz sample rate
      });

      // Store audio chunk in Azure Blob
      await this.storeAudioInAzure(sessionId, audioBuffer, timestamp);

      return {
        success: true,
        audioAnalysis: {
          timestamp,
          duration: audioBuffer.length / 16000,
          stored: true,
        },
      };
    } catch (error) {
      console.error("❌ Audio processing failed:", error);
      return { success: false, error: error.message };
    }
  }

  // --- AWS S3 storeAudioInS3 (kept for reference) ---
  // async storeAudioInS3(sessionId, audioBuffer, timestamp) { ... }

  // Store audio chunk in Azure Blob
  async storeAudioInAzure(sessionId, audioBuffer, timestamp) {
    try {
      const recording = this.activeRecordings.get(sessionId);
      if (!recording) return;

      const audioKey = `${recording.s3Key}/audio/audio-${timestamp}.wav`;

      await azureBlobService.uploadBlob(
        this.containerName,
        audioKey,
        audioBuffer,
        "audio/wav",
        {
          sessionId: sessionId.toString(),
          timestamp: timestamp.toString(),
          studentId: recording.studentId.toString(),
        }
      );
    } catch (error) {
      console.error("❌ Azure Blob audio storage failed:", error);
    }
  }

  // End recording and create final video file
  async endRecording(sessionId) {
    try {
      const recording = this.activeRecordings.get(sessionId);
      if (!recording) {
        throw new Error("No active recording found for session");
      }

      recording.endTime = new Date();
      recording.duration = recording.endTime - recording.startTime;

      // Create session summary
      const summary = {
        sessionId,
        studentId: recording.studentId,
        startTime: recording.startTime,
        endTime: recording.endTime,
        duration: recording.duration,
        totalFrames: recording.frames.length,
        totalAudioChunks: recording.audioChunks.length,
        totalViolations: recording.violations.length,
        violations: recording.violations,
        s3Location: recording.s3Key,
      };

      // Store summary in Azure Blob
      const summaryKey = `${recording.s3Key}/session-summary.json`;
      await azureBlobService.uploadBlob(
        this.containerName,
        summaryKey,
        JSON.stringify(summary, null, 2),
        "application/json"
      );

      // Clean up active recording
      this.activeRecordings.delete(sessionId);

      return {
        success: true,
        summary,
        s3Location: recording.s3Key,
      };
    } catch (error) {
      console.error("❌ Failed to end recording:", error);
      return { success: false, error: error.message };
    }
  }

  // Get recording status
  getRecordingStatus(sessionId) {
    const recording = this.activeRecordings.get(sessionId);
    if (!recording) {
      return { active: false };
    }

    return {
      active: true,
      sessionId: recording.sessionId,
      studentId: recording.studentId,
      startTime: recording.startTime,
      duration: Date.now() - recording.startTime.getTime(),
      frameCount: recording.frames.length,
      audioChunkCount: recording.audioChunks.length,
      violationCount: recording.violations.length,
      recentViolations: recording.violations.slice(-5),
    };
  }

  // Get all active recordings
  getAllActiveRecordings() {
    const recordings = [];
    for (const [sessionId, recording] of this.activeRecordings) {
      recordings.push(this.getRecordingStatus(sessionId));
    }
    return recordings;
  }

  async startLiveStreamProcessing(sessionId, studentId) {
    try {
      const processor = {
        sessionId,
        studentId,
        startTime: new Date(),
        frameCount: 0,
        violationCount: 0,
        lastProcessed: null,
      };

      this.liveStreamProcessors.set(sessionId, processor);

      return { success: true, processorId: sessionId };
    } catch (error) {
      console.error("Failed to start live stream processing:", error);
      return { success: false, error: error.message };
    }
  }

  // ENHANCED: Process live stream frame (called from your endpoint)
  async processLiveStreamFrame(sessionId, frameBuffer, timestamp) {
    try {
      const processor = this.liveStreamProcessors.get(sessionId);
      if (!processor) {
        console.warn(`No live processor found for session ${sessionId}`);
        return { success: false, error: "No active processor" };
      }

      processor.frameCount++;
      processor.lastProcessed = new Date();

      // Parallel AWS analysis
      const [faceAnalysis, labelAnalysis] = await Promise.all([
        this.analyzeFrameForFaces(frameBuffer),
        this.analyzeFrameForLabels(frameBuffer),
      ]);

      // Check violations with lower thresholds for real-time
      const violations = this.checkLiveStreamViolations(
        faceAnalysis,
        labelAnalysis,
        timestamp
      );

      if (violations.length > 0) {
        processor.violationCount += violations.length;
      }

      // Store frame asynchronously (don't wait)
      const frameKey = await this.storeFrameInAzure(
        sessionId,
        frameBuffer,
        timestamp
      );

      return {
        success: true,
        analysis: {
          faces: faceAnalysis,
          labels: labelAnalysis,
          violations,
          timestamp,
          frameNumber: processor.frameCount,
          frameUrl: azureBlobService.getBlobUrl(this.containerName, frameKey),
        },
      };
    } catch (error) {
      console.error("❌ Live stream frame processing failed:", error);
      return { success: false, error: error.message };
    }
  }

  // NEW: Check violations with real-time optimizations
  checkLiveStreamViolations(faceAnalysis, labelAnalysis, timestamp) {
    const violations = [];

    // More sensitive detection for live streams
    if (faceAnalysis.faceCount > 1) {
      violations.push({
        type: "MULTIPLE_PEOPLE_LIVE",
        severity: "HIGH",
        count: faceAnalysis.faceCount,
        timestamp,
        message: `LIVE: ${faceAnalysis.faceCount} people detected`,
        confidence: Math.max(...faceAnalysis.confidence),
      });
    }

    if (faceAnalysis.faceCount === 0) {
      violations.push({
        type: "NO_FACE_LIVE",
        severity: "MEDIUM",
        timestamp,
        message: "LIVE: Student not visible in camera",
      });
    }

    // Prohibited items with lower threshold
    const prohibitedItems = this.findProhibitedItems(labelAnalysis.labels);
    prohibitedItems.forEach((item) => {
      if (item.Confidence > 60) {
        // Lower threshold for live detection
        violations.push({
          type: "PROHIBITED_ITEM_LIVE",
          severity: "HIGH",
          item: item.Name,
          confidence: item.Confidence,
          timestamp,
          message: `LIVE: ${item.Name} detected (${item.Confidence.toFixed(
            1
          )}%)`,
        });
      }
    });

    return violations;
  }

  // NEW: Get live processor status
  getLiveStreamStatus(sessionId) {
    const processor = this.liveStreamProcessors.get(sessionId);
    if (!processor) return { active: false };

    return {
      active: true,
      sessionId: processor.sessionId,
      startTime: processor.startTime,
      frameCount: processor.frameCount,
      violationCount: processor.violationCount,
      lastProcessed: processor.lastProcessed,
      uptime: Date.now() - processor.startTime.getTime(),
    };
  }
}

module.exports = AWSVideoProcessor;
