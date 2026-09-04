// services/proctoring-analytics/proctoringConfig.js - FIXED VERSION
class ProctoringConfiguration {
  constructor() {
    this.defaultConfig = {
      // FIXED: Reasonable analysis intervals
      analysisInterval: {
        min: 1, // 30 seconds minimum
        max: 2, // 2 minutes maximum
        enabled: true,
      },
      deviceDetection: {
        enabled: true,
        allowedDevices: {
          mobile: false,
          calculator: false,
          laptop: false,
          tablet: false,
          smartwatch: false,
        },
      },
      faceDetection: {
        multiplePeopleAlert: true,
        absentStudentAlert: true,
        confidenceThreshold: 70, // Lowered for better detection
      },
      gazeDetection: {
        enabled: false, // Disable until properly tested
        suspiciousYaw: 45,
        suspiciousPitch: 30,
        confidenceThreshold: 70,
        consecutiveViolations: 3,
        alerts: {
          lookingAway: true,
          lookingUp: true,
          lookingDown: true,
          persistentGaze: false,
        },
      },
      alertSettings: {
        immediateAlert: ["MULTIPLE_PEOPLE", "PROHIBITED_DEVICE"],
        delayedAlert: ["STUDENT_ABSENT"],
        autoCapture: true,
      },
    };
  }

  generateRandomInterval(config) {
    const { min, max } = config.analysisInterval;
    const interval = Math.floor(Math.random() * (max - min + 1)) + min;
    return interval;
  }

  validateDeviceInFrame(detectedObjects, allowedDevices) {
    const prohibitedDevices = [];
    detectedObjects.forEach((obj) => {
      const deviceType = this.classifyDevice(obj.Name.toLowerCase());
      if (deviceType && !allowedDevices[deviceType]) {
        prohibitedDevices.push({
          type: deviceType,
          confidence: obj.Confidence,
          boundingBox: obj.BoundingBox,
        });
      }
    });
    return prohibitedDevices;
  }

  classifyDevice(objectName) {
    const deviceMappings = {
      mobile: ["cell phone", "mobile phone", "smartphone", "iphone", "android"],
      calculator: ["calculator", "scientific calculator"],
      laptop: ["laptop", "computer", "notebook"],
      tablet: ["tablet", "ipad"],
      smartwatch: ["watch", "smartwatch", "apple watch"],
    };

    for (const [deviceType, keywords] of Object.entries(deviceMappings)) {
      if (keywords.some((keyword) => objectName.includes(keyword))) {
        return deviceType;
      }
    }
    return null;
  }
}

module.exports = ProctoringConfiguration;
