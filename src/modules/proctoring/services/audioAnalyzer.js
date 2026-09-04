// services/proctoring-analytics/audioAnalyzer.js
// --- AWS SDK v2 (kept for reference) ---
// const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");

// --- Azure Blob Storage ---
const azureBlobService = require("../../../shared/utils/azureBlobService");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

class AudioProctoringAnalyzer {
  constructor() {
    this.validateEnvironmentVariables();

    // --- AWS S3 / Transcribe (kept for reference) ---
    // this.s3 = new AWS.S3({
    //   region: process.env.AWS_REGION,
    //   credentials: {
    //     accessKeyId: process.env.AWS_KEY_S3 || process.env.AWS_ACCESS_KEY,
    //     secretAccessKey:
    //       process.env.AWS_SECRET_S3 || process.env.AWS_SECRET_KEY,
    //   },
    // });
    // this.transcribe = new AWS.TranscribeService({
    //   region: process.env.AWS_REGION,
    // });

    this.containerName = process.env.AZURE_PROCTORING_CONTAINER_NAME || "proctoringrecordings";
    this.tempDir = path.join(__dirname, "temp_audio");

    this.suspiciousKeywords = [
      "google",
      "search",
      "answer",
      "help",
      "cheat",
      "look up",
      "phone",
      "text",
      "message",
      "call",
      "alexa",
      "siri",
      "hey google",
      "ok google",
      "hey siri",
    ];
  }

  validateEnvironmentVariables() {
    const required = [
      "AZURE_STORAGE_CONNECTION_STRING",
    ];
    const optional = [
      "AZURE_STORAGE_ACCOUNT_NAME",
      "AZURE_STORAGE_ACCOUNT_KEY",
      "AZURE_PROCTORING_CONTAINER_NAME",
    ];

    const missing = required.filter((envVar) => !process.env[envVar]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`
      );
    }
  }

  async analyzeAudioBuffer(audioBuffer, sessionId, duration = 5000) {
    try {
      // ✅ Enhanced validation with detailed logging
      const validationResult = await this.validateAudioBufferEnhanced(
        audioBuffer,
        sessionId
      );
      if (!validationResult.isValid) {
        console.warn(
          `⚠️ Audio buffer validation failed: ${validationResult.reason}`
        );
        return this.createFailureResponse(
          sessionId,
          "INVALID_AUDIO_BUFFER",
          validationResult.reason
        );
      }

      // ✅ Try to save and validate the temporary file
      const tempWebMPath = await this.saveTemporaryAudioBufferEnhanced(
        audioBuffer,
        sessionId,
        "webm"
      );
      if (!tempWebMPath) {
        console.error("❌ Failed to save temporary audio file");
        return this.createFailureResponse(
          sessionId,
          "FILE_SAVE_ERROR",
          "Could not save audio buffer to file"
        );
      }

      const analysis = {
        sessionId,
        timestamp: new Date(),
        duration: duration,
        violations: [],
        audioMetrics: {},
        transcription: null,
        confidence: 0,
      };

      const acousticResult = await this.analyzeAcousticPatternsFromBuffer(
        audioBuffer
      );

      if (acousticResult) {
        analysis.audioMetrics = acousticResult.metrics;
        analysis.violations.push(...(acousticResult.violations || []));
      }

      // Add a notification that transcription was skipped
      analysis.violations.push({
        type: "TRANSCRIPTION_SKIPPED",
        severity: "LOW",
        description:
          "Audio transcription skipped due to WebM format compatibility issues",
        confidence: 0.5,
      });

      analysis.confidence = this.calculateConfidence(analysis.violations);
      this.cleanupTemporaryFile(tempWebMPath);

      return analysis;
    } catch (error) {
      console.error("❌ Audio buffer analysis failed:", error);
      return this.createFailureResponse(
        sessionId,
        "AUDIO_ANALYSIS_ERROR",
        error.message
      );
    }
  }

  // ✅ Enhanced audio buffer validation
  async validateAudioBufferEnhanced(audioBuffer, sessionId) {
    try {
      let bufferData = audioBuffer;
      if (typeof audioBuffer === "string") {
        bufferData = Buffer.from(audioBuffer, "base64");
      }

      const bufferSize = bufferData.length;

      if (bufferSize === 0) {
        return {
          isValid: false,
          reason: "Audio buffer is empty",
          bufferSize: 0,
        };
      }

      if (bufferSize < 100) {
        return {
          isValid: false,
          reason: "Audio buffer too small to be valid audio",
          bufferSize,
        };
      }

      // ✅ Check for various audio signatures
      const signatures = {
        webm: [0x1a, 0x45, 0xdf, 0xa3],
        riff: [0x52, 0x49, 0x46, 0x46], // RIFF (WAV)
        mp4: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], // ftyp
        ogg: [0x4f, 0x67, 0x67, 0x53], // OggS
      };

      let detectedFormat = "unknown";
      for (const [format, signature] of Object.entries(signatures)) {
        const signatureBuffer = Buffer.from(signature);
        if (bufferData.indexOf(signatureBuffer) !== -1) {
          detectedFormat = format;
          break;
        }
      }

      // ✅ Check if it's mostly valid data (not all zeros or repeated patterns)
      const uniqueBytes = new Set(
        bufferData.slice(0, Math.min(1000, bufferSize))
      );
      const entropy = uniqueBytes.size / Math.min(1000, bufferSize);

      if (entropy < 0.1) {
        return {
          isValid: false,
          reason: "Audio buffer appears to be mostly empty or repeated data",
          bufferSize,
          entropy,
        };
      }

      return {
        isValid: true,
        reason: "Audio buffer appears valid",
        bufferSize,
        detectedFormat,
        entropy,
      };
    } catch (error) {
      return {
        isValid: false,
        reason: `Validation error: ${error.message}`,
        bufferSize: 0,
      };
    }
  }

  // ✅ Enhanced file saving with validation
  async saveTemporaryAudioBufferEnhanced(
    audioBuffer,
    sessionId,
    format = "webm"
  ) {
    try {
      const tempDir = path.join(__dirname, "temp");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const filename = `audio_buffer_${sessionId}_${Date.now()}.${format}`;
      const filepath = path.join(tempDir, filename);

      // ✅ Convert base64 to buffer properly
      let bufferData = audioBuffer;
      if (typeof audioBuffer === "string") {
        try {
          bufferData = Buffer.from(audioBuffer, "base64");
        } catch (base64Error) {
          console.error("❌ Base64 decode error:", base64Error);
          return null;
        }
      }

      if (bufferData.length === 0) {
        console.error("❌ Buffer is empty after conversion");
        return null;
      }

      // ✅ Write file synchronously and validate
      fs.writeFileSync(filepath, bufferData);

      // ✅ Verify file was written correctly
      if (!fs.existsSync(filepath)) {
        console.error("❌ File was not created");
        return null;
      }

      const fileStats = fs.statSync(filepath);

      if (fileStats.size === 0) {
        console.error("❌ File was created but is empty");
        return null;
      }

      if (fileStats.size !== bufferData.length) {
        console.warn(
          `⚠️ File size mismatch: expected ${bufferData.length}, got ${fileStats.size}`
        );
      }

      return filepath;
    } catch (error) {
      console.error("❌ Failed to save temporary audio buffer:", error);
      return null;
    }
  }

  // ✅ Enhanced acoustic analysis (no FFmpeg required)
  async analyzeAcousticPatternsFromBuffer(audioBuffer) {
    try {
      const violations = [];
      const metrics = {
        volume: 0,
        backgroundNoise: 0,
        speechActivity: 0,
        bufferSize: 0,
        estimatedDuration: 0,
        entropy: 0,
        dataVariance: 0,
      };

      let bufferData = audioBuffer;
      if (typeof audioBuffer === "string") {
        bufferData = Buffer.from(audioBuffer, "base64");
      }

      const bufferSize = bufferData.length;
      metrics.bufferSize = bufferSize;

      // ✅ Estimate duration based on buffer size
      const estimatedBitrate = 128000; // 128 kbps
      const estimatedDuration = (bufferSize * 8) / estimatedBitrate;
      metrics.estimatedDuration = estimatedDuration;

      // ✅ Analyze data patterns
      const entropy = this.calculateBufferEntropy(bufferData);
      metrics.entropy = entropy;

      const variance = this.calculateBufferVariance(bufferData);
      metrics.dataVariance = variance;

      // ✅ Generate violations based on analysis
      if (bufferSize === 0) {
        violations.push({
          type: "NO_AUDIO_DETECTED",
          severity: "HIGH",
          description: "No audio content detected during monitoring period",
          confidence: 0.9,
        });
      } else if (bufferSize < 5000) {
        violations.push({
          type: "MINIMAL_AUDIO_ACTIVITY",
          severity: "MEDIUM",
          description: "Very low audio activity detected",
          confidence: 0.7,
        });
      } else if (bufferSize > 500000) {
        violations.push({
          type: "EXCESSIVE_AUDIO_ACTIVITY",
          severity: "MEDIUM",
          description: "Unusually high audio activity detected",
          confidence: 0.6,
        });
      }

      if (entropy < 0.3) {
        violations.push({
          type: "LOW_AUDIO_ENTROPY",
          severity: "LOW",
          description: "Audio appears to be mostly silence or repetitive",
          confidence: 0.4,
        });
      }

      if (estimatedDuration > 10) {
        violations.push({
          type: "EXTENDED_AUDIO_DURATION",
          severity: "MEDIUM",
          description: "Extended audio content detected during exam period",
          confidence: 0.6,
        });
      }

      return { violations, metrics };
    } catch (error) {
      console.error("❌ Acoustic analysis failed:", error);
      return {
        violations: [
          {
            type: "ACOUSTIC_ANALYSIS_ERROR",
            severity: "LOW",
            description: `Acoustic analysis failed: ${error.message}`,
            confidence: 0.2,
          },
        ],
        metrics: { bufferSize: 0 },
      };
    }
  }

  // ✅ Enhanced entropy calculation
  calculateBufferEntropy(buffer) {
    try {
      const frequency = {};
      const sampleSize = Math.min(buffer.length, 10000);

      for (let i = 0; i < sampleSize; i++) {
        const byte = buffer[i];
        frequency[byte] = (frequency[byte] || 0) + 1;
      }

      let entropy = 0;
      Object.values(frequency).forEach((count) => {
        const probability = count / sampleSize;
        if (probability > 0) {
          entropy -= probability * Math.log2(probability);
        }
      });

      return entropy / 8; // Normalize to 0-1 range
    } catch (error) {
      console.warn("⚠️ Could not calculate buffer entropy:", error.message);
      return 0.5;
    }
  }

  // ✅ Add variance calculation
  calculateBufferVariance(buffer) {
    try {
      const sampleSize = Math.min(buffer.length, 5000);
      if (sampleSize === 0) return 0;

      // Calculate mean
      let sum = 0;
      for (let i = 0; i < sampleSize; i++) {
        sum += buffer[i];
      }
      const mean = sum / sampleSize;

      // Calculate variance
      let varianceSum = 0;
      for (let i = 0; i < sampleSize; i++) {
        varianceSum += Math.pow(buffer[i] - mean, 2);
      }

      return varianceSum / sampleSize / 255; // Normalize to 0-1 range
    } catch (error) {
      console.warn("⚠️ Could not calculate buffer variance:", error.message);
      return 0.5;
    }
  }

  // ✅ Helper method to create failure responses
  createFailureResponse(sessionId, violationType, description) {
    return {
      sessionId,
      violations: [
        {
          type: violationType,
          severity: "LOW",
          description: description,
          confidence: 0.3,
        },
      ],
      error: description,
      confidence: 0,
      timestamp: new Date(),
      duration: 5000,
      audioMetrics: {},
      transcription: null,
    };
  }

  calculateConfidence(violations) {
    if (violations.length === 0) return 1.0;

    const avgConfidence =
      violations.reduce((sum, v) => sum + (v.confidence || 0.5), 0) /
      violations.length;
    return Math.max(0, Math.min(1, avgConfidence));
  }

  cleanupTemporaryFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn("⚠️ Failed to cleanup temporary file:", error.message);
    }
  }

  // Backward compatibility method
  async analyzeAudio(audioData, sessionId, studentUID) {
    try {
      let audioBuffer = audioData;
      if (Buffer.isBuffer(audioData)) {
        audioBuffer = audioData.toString("base64");
      }

      return await this.analyzeAudioBuffer(audioBuffer, sessionId, 5000);
    } catch (error) {
      console.error("❌ Direct audio analysis failed:", error);
      return this.createFailureResponse(
        sessionId,
        "AUDIO_ANALYSIS_ERROR",
        error.message
      );
    }
  }
}

module.exports = AudioProctoringAnalyzer;
