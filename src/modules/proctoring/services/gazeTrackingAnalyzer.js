// // services/proctoring-analytics/gazeTrackingAnalyzer.js
// const AWS = require('aws-sdk');

// class GazeTrackingAnalyzer {
//   constructor(config) {
//     this.rekognition = new AWS.Rekognition();
//     this.gazeConfig = config?.gazeDetection || {};
//     this.violationHistory = new Map(); // sessionId -> violation count
//   }

//   async analyzeGaze(imageBuffer, sessionId, studentId) {
//     try {
//       if (!this.gazeConfig.enabled) {
//         return { gazeViolations: [], gazeData: [] };
//       }

//       const params = {
//         Image: { Bytes: imageBuffer },
//         Attributes: [
//           'ALL',
//           'EyeDirection'  // Request eye direction data
//         ]
//       };

//       const result = await this.rekognition.detectFaces(params).promise();

//       return this.processGazeResults(result, sessionId, studentId);

//     } catch (error) {
//       console.error('Gaze analysis error:', error);
//       throw error;
//     }
//   }

//   processGazeResults(rekognitionResult, sessionId, studentId) {
//     const faces = rekognitionResult.FaceDetails;
//     const analysis = {
//       sessionId,
//       studentId,
//       timestamp: new Date(),
//       gazeViolations: [],
//       gazeData: []
//     };

//     faces.forEach((face, index) => {
//       const eyeDirection = face.EyeDirection;

//       if (!eyeDirection || eyeDirection.Confidence < this.gazeConfig.confidenceThreshold) {
//         return;
//       }

//       const gazeInfo = {
//         faceIndex: index,
//         yaw: eyeDirection.Yaw,
//         pitch: eyeDirection.Pitch,
//         confidence: eyeDirection.Confidence,
//         lookingAt: this.interpretGazeDirection(eyeDirection.Yaw, eyeDirection.Pitch)
//       };

//       analysis.gazeData.push(gazeInfo);

//       const violations = this.checkGazeViolations(gazeInfo);
//       if (violations.length > 0) {
//         analysis.gazeViolations.push(...violations);
//         this.trackConsecutiveViolations(sessionId, violations);
//       }
//     });

//     return analysis;
//   }

//   interpretGazeDirection(yaw, pitch) {
//     let direction = [];

//     // Horizontal direction (Yaw)
//     if (Math.abs(yaw) <= 15) {
//       direction.push('center');
//     } else if (yaw > 15) {
//       direction.push(yaw > 45 ? 'far-right' : 'right');
//     } else {
//       direction.push(yaw < -45 ? 'far-left' : 'left');
//     }

//     // Vertical direction (Pitch)
//     if (Math.abs(pitch) <= 10) {
//       direction.push('straight');
//     } else if (pitch > 10) {
//       direction.push(pitch > 30 ? 'far-up' : 'up');
//     } else {
//       direction.push(pitch < -30 ? 'far-down' : 'down');
//     }

//     return direction.join('-');
//   }

//   checkGazeViolations(gazeInfo) {
//     const violations = [];
//     const { yaw, pitch, confidence } = gazeInfo;
//     const cfg = this.gazeConfig;

//     // Check horizontal gaze violations (looking away from screen)
//     if (cfg.alerts.lookingAway && Math.abs(yaw) > cfg.suspiciousYaw) {
//       violations.push({
//         type: 'SUSPICIOUS_GAZE_HORIZONTAL',
//         severity: Math.abs(yaw) > 90 ? 'HIGH' : 'MEDIUM',
//         details: {
//           angle: yaw,
//           direction: yaw > 0 ? 'right' : 'left',
//           confidence: confidence
//         },
//         message: `Student looking ${Math.abs(yaw) > 90 ? 'significantly' : 'moderately'} ${yaw > 0 ? 'right' : 'left'} (${Math.round(yaw)}°)`
//       });
//     }

//     // Check vertical gaze violations (looking up/down)
//     if (cfg.alerts.lookingUp && pitch > cfg.suspiciousPitch) {
//       violations.push({
//         type: 'SUSPICIOUS_GAZE_VERTICAL',
//         severity: pitch > 60 ? 'HIGH' : 'MEDIUM',
//         details: {
//           angle: pitch,
//           direction: 'up',
//           confidence: confidence
//         },
//         message: `Student looking ${pitch > 60 ? 'significantly' : 'moderately'} up (${Math.round(pitch)}°)`
//       });
//     }

//     if (cfg.alerts.lookingDown && pitch < -cfg.suspiciousPitch) {
//       violations.push({
//         type: 'SUSPICIOUS_GAZE_VERTICAL',
//         severity: pitch < -60 ? 'HIGH' : 'MEDIUM',
//         details: {
//           angle: pitch,
//           direction: 'down',
//           confidence: confidence
//         },
//         message: `Student looking ${pitch < -60 ? 'significantly' : 'moderately'} down (${Math.round(pitch)}°)`
//       });
//     }

//     return violations;
//   }

//   trackConsecutiveViolations(sessionId, violations) {
//     if (!this.violationHistory.has(sessionId)) {
//       this.violationHistory.set(sessionId, 0);
//     }

//     const currentCount = this.violationHistory.get(sessionId);
//     this.violationHistory.set(sessionId, currentCount + violations.length);

//     // Trigger alert if consecutive violations exceed threshold
//     if (currentCount + violations.length >= this.gazeConfig.consecutiveViolations) {
//       this.triggerGazeAlert(sessionId, violations);
//       this.violationHistory.set(sessionId, 0); // Reset counter
//     }
//   }

//   async triggerGazeAlert(sessionId, violations) {
//     // This will be called by the main analyzer
//     return {
//       type: 'GAZE_VIOLATION',
//       sessionId,
//       violations,
//       timestamp: new Date(),
//       severity: 'HIGH'
//     };
//   }

//   resetViolationHistory(sessionId) {
//     this.violationHistory.set(sessionId, 0);
//   }

//   updateConfig(newConfig) {
//     this.gazeConfig = { ...this.gazeConfig, ...newConfig };
//   }
// }

// module.exports = GazeTrackingAnalyzer;

// services/proctoring-analytics/gazeTrackingAnalyzer.js
const { RekognitionClient, DetectFacesCommand } = require("@aws-sdk/client-rekognition");

class GazeTrackingAnalyzer {
  constructor(config) {
    this.rekognition = new RekognitionClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_REKOG_KEY,
        secretAccessKey: process.env.AWS_REKOG_SECRET,
      },
    });

    // ✅ ENHANCED: More sensitive configuration
    this.gazeConfig = {
      enabled: true,
      confidenceThreshold: 0.5, // Lowered from typical 0.8-0.9
      alerts: {
        lookingAway: true,
        lookingUp: true,
        lookingDown: true,
        eyesClosed: true,
        multipleFaces: true,
      },
      // ✅ More sensitive thresholds
      suspiciousYaw: 15, // Reduced from 45 degrees
      suspiciousPitch: 12, // Reduced from 30 degrees
      consecutiveViolations: 2, // Reduced from 3
      // ✅ New advanced settings
      enableFallbackDetection: true,
      debugMode: true,
      smoothingFrames: 3,
      ...config?.gazeDetection,
    };

    this.violationHistory = new Map();
    this.gazeHistory = new Map(); // For smoothing
  }

  async analyzeGaze(imageBuffer, sessionId, studentId) {
    try {
      if (!this.gazeConfig.enabled) {
        return { gazeViolations: [], gazeData: [] };
      }

      // ✅ ENHANCED: Request more face attributes for better detection
      const params = {
        Image: { Bytes: imageBuffer },
        Attributes: [
          "ALL",
          "EyeDirection",
          "EyesOpen",
          "Pose", // Head pose can supplement gaze detection
        ],
      };

      const command = new DetectFacesCommand(params);
      const result = await this.rekognition.send(command);

      if (this.gazeConfig.debugMode) {}

      return this.processGazeResults(result, sessionId, studentId);
    } catch (error) {
      console.error("❌ Gaze analysis error:", error);
      return {
        gazeViolations: [],
        gazeData: [],
        error: error.message,
      };
    }
  }

  processGazeResults(rekognitionResult, sessionId, studentId) {
    const faces = rekognitionResult.FaceDetails;
    const analysis = {
      sessionId,
      studentId,
      timestamp: new Date(),
      gazeViolations: [],
      gazeData: [],
    };

    // ✅ ENHANCED: Check for multiple faces first
    if (faces.length > 1) {
      analysis.gazeViolations.push({
        type: "MULTIPLE_FACES_DETECTED",
        severity: "HIGH",
        count: faces.length,
        message: `${faces.length} faces detected - only 1 student allowed`,
        timestamp: new Date(),
      });
    }

    if (faces.length === 0) {
      analysis.gazeViolations.push({
        type: "NO_FACE_DETECTED",
        severity: "HIGH",
        message: "No face detected in frame",
        timestamp: new Date(),
      });
      return analysis;
    }

    // Process the primary face (largest/most confident)
    const primaryFace = this.selectPrimaryFace(faces);

    if (this.gazeConfig.debugMode) {}

    const gazeInfo = this.extractGazeInfo(primaryFace, 0);

    if (gazeInfo) {
      // ✅ Apply smoothing
      const smoothedGaze = this.applySmoothening(sessionId, gazeInfo);
      analysis.gazeData.push(smoothedGaze);

      // ✅ Enhanced violation checking
      const violations = this.checkEnhancedGazeViolations(
        smoothedGaze,
        primaryFace
      );
      if (violations.length > 0) {
        analysis.gazeViolations.push(...violations);
        this.trackConsecutiveViolations(sessionId, violations);
      }
    }

    return analysis;
  }

  // ✅ NEW: Select the most prominent face
  selectPrimaryFace(faces) {
    // Sort by confidence and bounding box size
    return faces.sort((a, b) => {
      const aSize = a.BoundingBox.Width * a.BoundingBox.Height;
      const bSize = b.BoundingBox.Width * b.BoundingBox.Height;
      return b.Confidence * bSize - a.Confidence * aSize;
    })[0];
  }

  // ✅ ENHANCED: Extract comprehensive gaze information
  extractGazeInfo(face, index) {
    const eyeDirection = face.EyeDirection;
    const pose = face.Pose;
    const eyesOpen = face.EyesOpen;

    // ✅ Use both eye direction AND head pose for better accuracy
    let yaw = 0,
      pitch = 0,
      confidence = 0;

    if (
      eyeDirection &&
      eyeDirection.Confidence > this.gazeConfig.confidenceThreshold
    ) {
      yaw = eyeDirection.Yaw || 0;
      pitch = eyeDirection.Pitch || 0;
      confidence = eyeDirection.Confidence;
    } else if (pose && pose.Yaw !== undefined && pose.Pitch !== undefined) {
      // ✅ FALLBACK: Use head pose as gaze approximation
      yaw = pose.Yaw;
      pitch = pose.Pitch;
      confidence = Math.min(70, face.Confidence); // Lower confidence for fallback

      if (this.gazeConfig.debugMode) {}
    } else {
      if (this.gazeConfig.debugMode) {}
      return null;
    }

    return {
      faceIndex: index,
      yaw: yaw,
      pitch: pitch,
      confidence: confidence,
      eyesOpen: eyesOpen,
      lookingAt: this.interpretGazeDirection(yaw, pitch),
      source: eyeDirection ? "eye_direction" : "head_pose",
    };
  }

  // ✅ NEW: Apply smoothing to reduce noise
  applySmoothening(sessionId, gazeInfo) {
    if (!this.gazeHistory.has(sessionId)) {
      this.gazeHistory.set(sessionId, []);
    }

    const history = this.gazeHistory.get(sessionId);
    history.push(gazeInfo);

    // Keep only recent frames
    if (history.length > this.gazeConfig.smoothingFrames) {
      history.shift();
    }

    // Apply moving average
    if (history.length >= 2) {
      const avgYaw =
        history.reduce((sum, g) => sum + g.yaw, 0) / history.length;
      const avgPitch =
        history.reduce((sum, g) => sum + g.pitch, 0) / history.length;
      const avgConfidence =
        history.reduce((sum, g) => sum + g.confidence, 0) / history.length;

      return {
        ...gazeInfo,
        yaw: avgYaw,
        pitch: avgPitch,
        confidence: avgConfidence,
        smoothed: true,
      };
    }

    return gazeInfo;
  }

  interpretGazeDirection(yaw, pitch) {
    let direction = [];

    // ✅ More granular horizontal direction
    if (Math.abs(yaw) <= 10) {
      direction.push("center");
    } else if (yaw > 10) {
      if (yaw > 45) direction.push("far-right");
      else if (yaw > 25) direction.push("right");
      else direction.push("slight-right");
    } else {
      if (yaw < -45) direction.push("far-left");
      else if (yaw < -25) direction.push("left");
      else direction.push("slight-left");
    }

    // ✅ More granular vertical direction
    if (Math.abs(pitch) <= 8) {
      direction.push("straight");
    } else if (pitch > 8) {
      if (pitch > 35) direction.push("far-up");
      else if (pitch > 20) direction.push("up");
      else direction.push("slight-up");
    } else {
      if (pitch < -35) direction.push("far-down");
      else if (pitch < -20) direction.push("down");
      else direction.push("slight-down");
    }

    return direction.join("-");
  }

  // ✅ ENHANCED: More comprehensive violation checking
  checkEnhancedGazeViolations(gazeInfo, face) {
    const violations = [];
    const { yaw, pitch, confidence, eyesOpen } = gazeInfo;
    const cfg = this.gazeConfig;

    if (this.gazeConfig.debugMode) {}

    // ✅ ENHANCED: More sensitive horizontal gaze violations
    if (cfg.alerts.lookingAway && Math.abs(yaw) > cfg.suspiciousYaw) {
      const severity = Math.abs(yaw) > 45 ? "HIGH" : "MEDIUM";
      violations.push({
        type: "SUSPICIOUS_GAZE_HORIZONTAL",
        severity: severity,
        details: {
          angle: Math.round(yaw * 10) / 10,
          direction: yaw > 0 ? "right" : "left",
          confidence: Math.round(confidence * 10) / 10,
          source: gazeInfo.source,
        },
        message: `Student looking ${severity === "HIGH" ? "significantly" : "moderately"
          } ${yaw > 0 ? "right" : "left"} (${Math.round(yaw)}deg)`,
        timestamp: new Date(),
      });
    }

    // ✅ ENHANCED: More sensitive vertical gaze violations
    if (cfg.alerts.lookingUp && pitch > cfg.suspiciousPitch) {
      violations.push({
        type: "SUSPICIOUS_GAZE_VERTICAL",
        severity: pitch > 35 ? "HIGH" : "MEDIUM",
        details: {
          angle: Math.round(pitch * 10) / 10,
          direction: "up",
          confidence: Math.round(confidence * 10) / 10,
          source: gazeInfo.source,
        },
        message: `Student looking ${pitch > 35 ? "significantly" : "moderately"
          } up (${Math.round(pitch)}deg)`,
        timestamp: new Date(),
      });
    }

    if (cfg.alerts.lookingDown && pitch < -cfg.suspiciousPitch) {
      violations.push({
        type: "SUSPICIOUS_GAZE_VERTICAL",
        severity: pitch < -35 ? "HIGH" : "MEDIUM",
        details: {
          angle: Math.round(pitch * 10) / 10,
          direction: "down",
          confidence: Math.round(confidence * 10) / 10,
          source: gazeInfo.source,
        },
        message: `Student looking ${pitch < -35 ? "significantly" : "moderately"
          } down (${Math.round(pitch)}deg)`,
        timestamp: new Date(),
      });
    }

    // ✅ NEW: Eyes closed detection
    if (cfg.alerts.eyesClosed && eyesOpen) {
      if (eyesOpen.Value === false && eyesOpen.Confidence > 80) {
        violations.push({
          type: "EYES_CLOSED",
          severity: "MEDIUM",
          details: {
            confidence: eyesOpen.Confidence,
          },
          message: "Student appears to have eyes closed",
          timestamp: new Date(),
        });
      }
    }

    return violations;
  }

  trackConsecutiveViolations(sessionId, violations) {
    if (!this.violationHistory.has(sessionId)) {
      this.violationHistory.set(sessionId, { count: 0, recent: [] });
    }

    const history = this.violationHistory.get(sessionId);
    history.count += violations.length;
    history.recent.push(...violations);

    // Keep only recent violations (last 10)
    if (history.recent.length > 10) {
      history.recent = history.recent.slice(-10);
    }

    // Trigger alert if consecutive violations exceed threshold
    if (history.count >= this.gazeConfig.consecutiveViolations) {
      this.triggerGazeAlert(sessionId, violations);
      history.count = 0; // Reset counter
    }
  }

  async triggerGazeAlert(sessionId, violations) {
    const alert = {
      type: "GAZE_VIOLATION_ALERT",
      sessionId,
      violations,
      timestamp: new Date(),
      severity: "HIGH",
      message: `Multiple gaze violations detected for session ${sessionId}`,
    };

    return alert;
  }

  // ✅ NEW: Get violation statistics
  getViolationStats(sessionId) {
    const history = this.violationHistory.get(sessionId);
    if (!history) return { totalViolations: 0, recentViolations: [] };

    return {
      totalViolations: history.count,
      recentViolations: history.recent,
      violationsByType: this.groupViolationsByType(history.recent),
    };
  }

  groupViolationsByType(violations) {
    return violations.reduce((acc, violation) => {
      acc[violation.type] = (acc[violation.type] || 0) + 1;
      return acc;
    }, {});
  }

  resetViolationHistory(sessionId) {
    this.violationHistory.set(sessionId, { count: 0, recent: [] });
    this.gazeHistory.set(sessionId, []);
  }

  updateConfig(newConfig) {
    this.gazeConfig = { ...this.gazeConfig, ...newConfig };
  }

  // ✅ NEW: Enable/disable debug mode
  setDebugMode(enabled) {
    this.gazeConfig.debugMode = enabled;
  }
}

module.exports = GazeTrackingAnalyzer;
