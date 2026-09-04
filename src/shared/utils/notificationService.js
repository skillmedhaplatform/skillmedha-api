// services/notificationService.js
const axios = require("axios");
const { ObjectId } = require("mongodb");
const { connectTodb } = require("../db/connection");

// ============================================
// CONFIGURATION
// ============================================
const NOTIFICATION_SERVER =
  process.env.NOTIFICATION_SERVER_URL || "http://localhost:2005";

const NOTIFICATION_TYPES = {
  TEST_ASSIGNED: "test_assigned",
  TEST_REMINDER: "test_reminder",
  TEST_RESULT_PUBLISHED: "test_result_published",
  JOB_POSTED: "job_posted",
  JOB_UPDATED: "job_updated",
  JOB_APPLICATION_STATUS: "job_application_status",
  INTERNSHIP_POSTED: "internship_posted",
  EVENT_CREATED: "event_created",
  ANNOUNCEMENT: "announcement",
  PLACEMENT_DRIVE: "placement_drive",
};

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getTargetStudentIds(tenantDB, accessCriteria) {
  const { student } = connectTodb(tenantDB);
  let studentIds = [];

  try {
    let query = {};

    switch (accessCriteria?.type) {
      case "all":
        break;
      case "department":
        const deptIds = accessCriteria.department.map((d) =>
          typeof d === "string" ? d : d.toString()
        );
        query.department = { $in: deptIds };
        break;
      case "batch":
        query.yearOfPassing = { $in: accessCriteria.yearOfPassing };
        break;
      case "department_batch":
        const deptBatchIds = accessCriteria.department.map((d) =>
          typeof d === "string" ? d : d.toString()
        );
        query.department = { $in: deptBatchIds };
        query.yearOfPassing = { $in: accessCriteria.yearOfPassing };
        break;
      case "student":
        query._id = {
          $in: accessCriteria.students.map((e) => new ObjectId(e)),
        };
        break;
      default:
        return [];
    }

    const students = await student.find(query).toArray();

    studentIds = students.map((s) => {
      if (!s.globalId) {
        console.warn(`⚠️ Student ${s._id} is missing globalId field!`);
        return s._id.toString();
      }

      if (typeof s.globalId === "object" && s.globalId.toString) {
        return s.globalId.toString();
      }

      return String(s.globalId);
    });

    return studentIds;
  } catch (error) {
    console.error("❌ Error fetching target students:", error);
    return [];
  }
}

async function sendNotificationToStudents(tenantId, studentIds, message) {
  if (!studentIds || studentIds.length === 0) {
    return { success: 0, failed: 0 };
  }

  let successCount = 0;
  let failedCount = 0;
  const failedStudents = [];

  try {
    const BATCH_SIZE = 50;

    for (let i = 0; i < studentIds.length; i += BATCH_SIZE) {
      const batch = studentIds.slice(i, i + BATCH_SIZE);

      const promises = batch.map(async (studentId) => {
        try {
          await axios.post(
            `${NOTIFICATION_SERVER}/api/notify`,
            {
              type: "user",
              tenantId: tenantId,
              userId: studentId,
              message: message,
            },
            {
              headers: {
                "Content-Type": "application/json",
              },
              timeout: 5000,
            }
          );
          successCount++;
        } catch (error) {
          failedCount++;
          failedStudents.push(studentId);
          console.error(
            `❌ Failed to send notification to student ${studentId}:`,
            error.message
          );
        }
      });

      await Promise.allSettled(promises);
    }

    return {
      success: successCount,
      failed: failedCount,
      failedStudents: failedStudents,
    };
  } catch (error) {
    console.error("❌ Error in sendNotificationToStudents:", error);
    return { success: successCount, failed: failedCount, error: error.message };
  }
}

// ============================================
// MESSAGE BUILDERS
// ============================================

function buildTestAssignedMessage(testData) {
  return {
    title: "New Test Assigned",
    body: `A new test "${testData.title}" has been assigned to you.`,
    data: {
      type: NOTIFICATION_TYPES.TEST_ASSIGNED,
      testId: testData._id.toString(),
      testTitle: testData.title,
      category: testData.category,
      startTime: testData.startTime,
      endTime: testData.endTime,
      duration: testData.duration,
      totalMarks: testData.totalMarks,
      action: {
        route: "/student/tests",
        params: { testId: testData._id.toString() },
      },
    },
    priority: "high",
    timestamp: new Date().toISOString(),
  };
}

function buildJobPostedMessage(jobData) {
  const companyName = jobData.companyName || jobData.company || "Company";

  return {
    title: "New Job Posted",
    body: `${companyName} has posted a new job opening for "${jobData?.title}".`,
    data: {
      type: NOTIFICATION_TYPES.JOB_POSTED,
      jobId: jobData._id.toString(),
      role: jobData?.title,
      company: companyName,
      location: jobData.location,
      ctc: jobData.ctc || jobData.salary,
      lastDate: jobData.lastDate || jobData.deadline,
      action: {
        route: "/student/jobs",
        params: { jobId: jobData._id.toString() },
      },
    },
    priority: "high",
    timestamp: new Date().toISOString(),
  };
}

function buildJobUpdatedMessage(jobData) {
  const companyName = jobData.companyName || jobData.company || "Company";

  return {
    title: "Job Details Updated",
    body: `${companyName}'s job posting for "${jobData?.title}" has been updated. Check the latest details.`,
    data: {
      type: NOTIFICATION_TYPES.JOB_UPDATED,
      jobId: jobData._id.toString(),
      role: jobData?.title,
      company: companyName,
      location: jobData.location,
      ctc: jobData.ctc || jobData.salary,
      lastDate: jobData.lastDate || jobData.deadline,
      action: {
        route: "/student/jobs",
        params: { jobId: jobData._id.toString() },
      },
    },
    priority: "high",
    timestamp: new Date().toISOString(),
  };
}

// ============================================
// NOTIFICATION HANDLERS
// ============================================

async function notifyTestAssignment(
  tenantId,
  tenantDB,
  testData,
  accessCriteria
) {
  try {
    const studentIds = await getTargetStudentIds(tenantDB, accessCriteria);

    if (studentIds.length === 0) {
      return { success: false, message: "No eligible students" };
    }

    const message = buildTestAssignedMessage(testData);
    const result = await sendNotificationToStudents(
      tenantId,
      studentIds,
      message
    );

    return {
      success: true,
      notificationType: NOTIFICATION_TYPES.TEST_ASSIGNED,
      studentsNotified: result.success,
      ...result,
    };
  } catch (error) {
    console.error("❌ Error in notifyTestAssignment:", error);
    return { success: false, error: error.message };
  }
}

async function notifyJobPosting(tenantId, tenantDB, jobData, accessCriteria) {
  try {
    const studentIds = await getTargetStudentIds(tenantDB, accessCriteria);

    if (studentIds.length === 0) {
      return { success: false, message: "No eligible students" };
    }

    const message = buildJobPostedMessage(jobData);
    const result = await sendNotificationToStudents(
      tenantId,
      studentIds,
      message
    );

    return {
      success: true,
      notificationType: NOTIFICATION_TYPES.JOB_POSTED,
      studentsNotified: result.success,
      ...result,
    };
  } catch (error) {
    console.error("❌ Error in notifyJobPosting:", error);
    return { success: false, error: error.message };
  }
}

async function notifyJobUpdate(tenantId, tenantDB, jobData, accessCriteria) {
  try {
    const studentIds = await getTargetStudentIds(tenantDB, accessCriteria);

    if (studentIds.length === 0) {
      return { success: false, message: "No eligible students" };
    }

    const message = buildJobUpdatedMessage(jobData);
    const result = await sendNotificationToStudents(
      tenantId,
      studentIds,
      message
    );

    return {
      success: true,
      notificationType: NOTIFICATION_TYPES.JOB_UPDATED,
      studentsNotified: result.success,
      ...result,
    };
  } catch (error) {
    console.error("❌ Error in notifyJobUpdate:", error);
    return { success: false, error: error.message };
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  NOTIFICATION_TYPES,
  getTargetStudentIds,
  sendNotificationToStudents,
  notifyTestAssignment,
  notifyJobPosting,
  notifyJobUpdate,
  buildTestAssignedMessage,
  buildJobPostedMessage,
  buildJobUpdatedMessage,
};
