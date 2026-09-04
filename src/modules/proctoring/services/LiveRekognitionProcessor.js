// services/liveProctoring/LiveRekognitionProcessor.js

// ✅ AWS SDK v3 CommonJS imports
var RekognitionClient =
  require("@aws-sdk/client-rekognition").RekognitionClient;
var DetectFacesCommand =
  require("@aws-sdk/client-rekognition").DetectFacesCommand;
var DetectLabelsCommand =
  require("@aws-sdk/client-rekognition").DetectLabelsCommand;
var DetectModerationLabelsCommand =
  require("@aws-sdk/client-rekognition").DetectModerationLabelsCommand;

// ✅ Removed: Stream processor imports (not needed for proctoring)
// ConnectedHome was causing the label issues, so we'll use frame-based analysis instead

// ✅ LiveRekognitionProcessor Class - PROCTORING OPTIMIZED
function LiveRekognitionProcessor(config) {
  console.log("✅ LiveRekognitionProcessor initialized for proctoring (frame-based analysis)");
  config = config || {};

  this.config = {
    region: config.region || process.env.AWS_REGION || "us-east-1",
    credentials: config.credentials || {
      accessKeyId: process.env.AWS_REKOG_KEY,
      secretAccessKey: process.env.AWS_REKOG_SECRET,
    },
  };

  this.activeSessions = new Map();
  this.violationCallbacks = new Map();
  this.analysisIntervals = new Map(); // Track analysis intervals

  this.initializeClients();
}

// ✅ Initialize AWS v3 clients (simplified for proctoring)
LiveRekognitionProcessor.prototype.initializeClients = function () {
  var clientConfig = {
    region: this.config.region,
    credentials: this.config.credentials,
  };

  this.rekognitionClient = new RekognitionClient(clientConfig);
};

// ✅ 1. START PROCTORING FOR A SESSION
LiveRekognitionProcessor.prototype.startLiveProcessing = function (
  sessionId,
  options
) {
  options = options || {};
  var self = this;

  return new Promise(function (resolve, reject) {
    try {
      // Store session configuration
      var sessionConfig = {
        sessionId: sessionId,
        method: "frame_analysis",
        rules: {
          prohibitedItems: options.prohibitedItems || [
            "Mobile Phone",
            "Cell Phone",
            "Phone",
            "Smartphone",
            "Tablet",
            "iPad",
            "Laptop",
            "Computer",
            "Notebook",
            "Book",
            "Paper",
            "Document",
            "Text",
            "Calculator",
            "Watch",
            "Smartwatch",
          ],
          gazeTracking: options.gazeTracking || {
            enabled: true,
            maxYaw: 30,
            maxPitch: 20,
          },
          minConfidence: options.minConfidence || 75,
        },
        startedAt: new Date(),
        status: "active",
      };

      self.activeSessions.set(sessionId, sessionConfig);

      resolve({
        success: true,
        sessionId: sessionId,
        method: "proctoring_frame_analysis",
        message:
          "Ready to analyze frames - call analyzeFrame() with video data",
        rules: sessionConfig.rules,
      });
    } catch (error) {
      console.error(
        "❌ Failed to start proctoring for " + sessionId + ":",
        error
      );
      reject(error);
    }
  });
};

// ✅ 2. STOP PROCTORING FOR A SESSION
LiveRekognitionProcessor.prototype.stopLiveProcessing = function (sessionId) {
  var self = this;

  return new Promise(function (resolve, reject) {
    try {
      // Clear any analysis intervals
      var interval = self.analysisIntervals.get(sessionId);
      if (interval) {
        clearInterval(interval);
        self.analysisIntervals.delete(sessionId);
      }

      // Remove session data
      self.activeSessions.delete(sessionId);
      self.violationCallbacks.delete(sessionId);

      resolve({ success: true, sessionId: sessionId });
    } catch (error) {
      console.error(
        "❌ Failed to stop proctoring for " + sessionId + ":",
        error
      );
      reject(error);
    }
  });
};

// ✅ 3. ANALYZE SINGLE FRAME (Main method for proctoring)
LiveRekognitionProcessor.prototype.analyzeFrame = function (
  sessionId,
  frameBuffer,
  customRules
) {
  var self = this;

  return new Promise(function (resolve, reject) {
    (async function () {
      try {
        var session = self.activeSessions.get(sessionId);
        if (!session) {
          throw new Error(
            "Session " +
              sessionId +
              " not found - call startLiveProcessing first"
          );
        }

        // Merge session rules with custom rules
        var rules = customRules
          ? Object.assign({}, session.rules, customRules)
          : session.rules;

        // Parallel analysis using AWS Rekognition
        var results = await Promise.all([
          self.detectFaces(frameBuffer),
          self.detectLabels(frameBuffer),
          self.detectModerationLabels(frameBuffer), // For inappropriate content
        ]);

        var faceAnalysis = results[0];
        var labelAnalysis = results[1];
        var moderationAnalysis = results[2];

        // Check for violations
        var violations = self.checkViolations(
          faceAnalysis,
          labelAnalysis,
          moderationAnalysis,
          rules
        );

        var analysis = {
          sessionId: sessionId,
          timestamp: new Date(),
          faces: faceAnalysis,
          labels: labelAnalysis,
          moderation: moderationAnalysis,
          violations: violations,
          frameAnalysisId:
            Date.now() + "-" + Math.random().toString(36).substr(2, 9),
        };

        // Trigger callback if violations found
        if (violations.length > 0) {
          await self.handleViolations(sessionId, violations, analysis);
        }

        resolve({
          success: true,
          analysis: analysis,
        });
      } catch (error) {
        console.error("❌ Frame analysis failed for " + sessionId + ":", error);
        resolve({
          success: false,
          error: error.message,
          sessionId: sessionId,
        });
      }
    })();
  });
};

// ✅ 4. SET VIOLATION CALLBACK
LiveRekognitionProcessor.prototype.setViolationCallback = function (
  sessionId,
  callback
) {
  this.violationCallbacks.set(sessionId, callback);
};

// ✅ 5. GET SESSION STATUS
LiveRekognitionProcessor.prototype.getSessionStatus = function (sessionId) {
  var session = this.activeSessions.get(sessionId);

  return {
    sessionId: sessionId,
    isActive: !!session,
    session: session
      ? {
          method: session.method,
          startedAt: session.startedAt,
          status: session.status,
          rules: session.rules,
        }
      : null,
    hasCallback: this.violationCallbacks.has(sessionId),
  };
};

// ✅ 6. START CONTINUOUS ANALYSIS (Optional)
LiveRekognitionProcessor.prototype.startContinuousAnalysis = function (
  sessionId,
  frameProvider,
  intervalMs
) {
  var self = this;
  intervalMs = intervalMs || 5000; // Default 5 seconds

  return new Promise(function (resolve, reject) {
    try {
      if (!frameProvider || typeof frameProvider !== "function") {
        throw new Error(
          "frameProvider must be a function that returns frame data"
        );
      }

      var interval = setInterval(async function () {
        try {
          var frameData = await frameProvider();
          if (frameData && frameData.length > 0) {
            await self.analyzeFrame(sessionId, frameData);
          }
        } catch (error) {
          console.error("❌ Continuous analysis error:", error);
        }
      }, intervalMs);

      self.analysisIntervals.set(sessionId, interval);

      resolve({
        success: true,
        sessionId: sessionId,
        intervalMs: intervalMs,
      });
    } catch (error) {
      reject(error);
    }
  });
};

// =============== AWS REKOGNITION METHODS ===============

LiveRekognitionProcessor.prototype.detectFaces = function (imageBuffer) {
  var command = new DetectFacesCommand({
    Image: { Bytes: imageBuffer },
    Attributes: ["ALL", "EYE_DIRECTION"],
  });

  return this.rekognitionClient.send(command).then(function (result) {
    return {
      faceCount: result.FaceDetails.length,
      faces: result.FaceDetails,
      confidence: result.FaceDetails.map(function (face) {
        return face.Confidence;
      }),
      rawResult: result,
    };
  });
};

LiveRekognitionProcessor.prototype.detectLabels = function (imageBuffer) {
  var self = this;
  var command = new DetectLabelsCommand({
    Image: { Bytes: imageBuffer },
    MaxLabels: 50,
    MinConfidence: 60,
  });

  return this.rekognitionClient.send(command).then(function (result) {
    return {
      labels: result.Labels,
      prohibitedItems: self.findProhibitedItems(result.Labels),
      rawResult: result,
    };
  });
};

LiveRekognitionProcessor.prototype.detectModerationLabels = function (
  imageBuffer
) {
  var command = new DetectModerationLabelsCommand({
    Image: { Bytes: imageBuffer },
    MinConfidence: 60,
  });

  return this.rekognitionClient
    .send(command)
    .then(function (result) {
      return {
        moderationLabels: result.ModerationLabels,
        isInappropriate: result.ModerationLabels.length > 0,
        rawResult: result,
      };
    })
    .catch(function (error) {
      console.warn("⚠️ Moderation detection failed:", error.message);
      return {
        moderationLabels: [],
        isInappropriate: false,
        error: error.message,
      };
    });
};

// ✅ ENHANCED VIOLATION DETECTION LOGIC
LiveRekognitionProcessor.prototype.checkViolations = function (
  faceAnalysis,
  labelAnalysis,
  moderationAnalysis,
  rules
) {
  var violations = [];
  var timestamp = Date.now();

  // ✅ 1. Multiple People Detection
  if (faceAnalysis.faceCount > 1) {
    violations.push({
      type: "MULTIPLE_PEOPLE",
      severity: "HIGH",
      count: faceAnalysis.faceCount,
      timestamp: timestamp,
      message:
        faceAnalysis.faceCount + " people detected - only 1 student allowed",
      details: {
        detectedFaces: faceAnalysis.faceCount,
        confidences: faceAnalysis.confidence,
      },
    });
  }

  // ✅ 2. No Student Visible
  if (faceAnalysis.faceCount === 0) {
    violations.push({
      type: "NO_STUDENT_VISIBLE",
      severity: "MEDIUM",
      timestamp: timestamp,
      message: "Student not visible in camera",
      details: {
        detectedFaces: 0,
      },
    });
  }

  // ✅ 3. Prohibited Items Detection
  var excludedNames = [
    "Person",
    "Human",
    "Adult",
    "Man",
    "Woman",
    "Male",
    "Female",
    "Face",
    "Head",
  ];
  var actuallyProhibitedItems = labelAnalysis.prohibitedItems.filter(function (
    item
  ) {
    return (
      excludedNames.indexOf(item.Name) === -1 &&
      item.Confidence >= rules.minConfidence
    );
  });

  actuallyProhibitedItems.forEach(function (item) {
    violations.push({
      type: "PROHIBITED_ITEM",
      severity: "HIGH",
      item: item.Name,
      confidence: item.Confidence,
      timestamp: timestamp,
      message:
        "Prohibited item detected: " +
        item.Name +
        " (" +
        item.Confidence.toFixed(1) +
        "% confidence)",
      details: {
        boundingBox:
          item.Instances && item.Instances.length > 0
            ? item.Instances[0].BoundingBox
            : null,
        instances: item.Instances || [],
      },
    });
  });

  // ✅ 4. Gaze Tracking Violations
  if (
    rules.gazeTracking &&
    rules.gazeTracking.enabled &&
    faceAnalysis.faces.length > 0
  ) {
    faceAnalysis.faces.forEach(function (face, index) {
      if (face.EyeDirection && face.EyeDirection.Confidence > 80) {
        var yaw = face.EyeDirection.Yaw;
        var pitch = face.EyeDirection.Pitch;
        var confidence = face.EyeDirection.Confidence;

        var maxYaw = rules.gazeTracking.maxYaw || 30;
        var maxPitch = rules.gazeTracking.maxPitch || 20;

        if (Math.abs(yaw) > maxYaw || Math.abs(pitch) > maxPitch) {
          violations.push({
            type: "SUSPICIOUS_GAZE",
            severity: "MEDIUM",
            yaw: yaw,
            pitch: pitch,
            confidence: confidence,
            timestamp: timestamp,
            message:
              "Student looking away (Yaw: " +
              yaw.toFixed(1) +
              "°, Pitch: " +
              pitch.toFixed(1) +
              "°)",
            details: {
              faceIndex: index,
              eyeDirection: face.EyeDirection,
              thresholds: {
                maxYaw: maxYaw,
                maxPitch: maxPitch,
              },
            },
          });
        }
      }
    });
  }

  // ✅ 5. Inappropriate Content Detection
  if (moderationAnalysis.isInappropriate) {
    moderationAnalysis.moderationLabels.forEach(function (label) {
      violations.push({
        type: "INAPPROPRIATE_CONTENT",
        severity: "HIGH",
        category: label.Name,
        confidence: label.Confidence,
        timestamp: timestamp,
        message: "Inappropriate content detected: " + label.Name,
        details: {
          parentName: label.ParentName,
          categories: label.Categories || [],
        },
      });
    });
  }

  // ✅ 6. Face Quality Checks
  if (faceAnalysis.faces.length > 0) {
    faceAnalysis.faces.forEach(function (face, index) {
      // Check if face is too dark
      if (face.Quality && face.Quality.Brightness < 30) {
        violations.push({
          type: "POOR_LIGHTING",
          severity: "LOW",
          brightness: face.Quality.Brightness,
          timestamp: timestamp,
          message: "Poor lighting detected - image too dark",
          details: {
            faceIndex: index,
            quality: face.Quality,
          },
        });
      }

      // Check if face is occluded
      if (
        face.FaceOccluded &&
        face.FaceOccluded.Value &&
        face.FaceOccluded.Confidence > 70
      ) {
        violations.push({
          type: "FACE_OCCLUDED",
          severity: "MEDIUM",
          confidence: face.FaceOccluded.Confidence,
          timestamp: timestamp,
          message: "Student's face is partially blocked",
          details: {
            faceIndex: index,
            occlusion: face.FaceOccluded,
          },
        });
      }
    });
  }

  return violations;
};

LiveRekognitionProcessor.prototype.findProhibitedItems = function (labels) {
  var prohibitedKeywords = [
    "Mobile Phone",
    "Cell Phone",
    "Phone",
    "Smartphone",
    "Tablet",
    "iPad",
    "Computer",
    "Laptop",
    "Notebook",
    "Book",
    "Paper",
    "Document",
    "Text",
    "Reading",
    "Calculator",
    "Watch",
    "Smartwatch",
    "Wristwatch",
    "Headphones",
    "Earbuds",
    "Earphones",
    "Electronics",
    "Device",
    "Screen",
  ];

  return labels.filter(function (label) {
    var isProhibited = prohibitedKeywords.some(function (keyword) {
      return label.Name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1;
    });
    return isProhibited && label.Confidence > 60; // Lower threshold for detection
  });
};

LiveRekognitionProcessor.prototype.handleViolations = function (
  sessionId,
  violations,
  analysis
) {
  var self = this;

  return new Promise(function (resolve, reject) {
    (async function () {
      try {
        // Call registered callback
        var callback = self.violationCallbacks.get(sessionId);
        if (callback) {
          try {
            await callback({
              sessionId: sessionId,
              violations: violations,
              analysis: analysis,
              timestamp: new Date(),
            });
          } catch (error) {
            console.error("Violation callback error:", error);
          }
        }

        // Enhanced logging with violation details
        if (violations.length > 0) {
          violations.forEach(function (v, index) {});
        }

        resolve();
      } catch (error) {
        reject(error);
      }
    })();
  });
};

// ✅ UTILITY METHODS
LiveRekognitionProcessor.prototype.getAllActiveSessions = function () {
  return Array.from(this.activeSessions.keys());
};

LiveRekognitionProcessor.prototype.getSessionStatistics = function (sessionId) {
  var session = this.activeSessions.get(sessionId);
  if (!session) {
    return null;
  }

  var now = new Date();
  var duration = Math.floor((now - session.startedAt) / 1000); // Duration in seconds

  return {
    sessionId: sessionId,
    duration: duration,
    status: session.status,
    rules: session.rules,
    startedAt: session.startedAt,
  };
};

LiveRekognitionProcessor.prototype.cleanup = function () {
  var self = this;

  return new Promise(function (resolve, reject) {
    try {
      // Clear all analysis intervals
      self.analysisIntervals.forEach(function (interval, sessionId) {
        clearInterval(interval);
      });

      // Clear all data
      self.activeSessions.clear();
      self.violationCallbacks.clear();
      self.analysisIntervals.clear();

      resolve();
    } catch (error) {
      reject(error);
    }
  });
};

// ✅ CommonJS export
module.exports = LiveRekognitionProcessor;
