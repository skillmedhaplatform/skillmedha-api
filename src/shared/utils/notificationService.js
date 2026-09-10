// services/notificationService.js
const axios = require("axios");
const { ObjectId } = require("mongodb");
const { connectTodb, getTenantDB } = require("../db/connection");

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

function buildTestResultPublishedMessage(testData) {
  return {
    title: "Test Results Published",
    body: `The results for the test "${testData.title}" are now available.`,
    data: {
      type: NOTIFICATION_TYPES.TEST_RESULT_PUBLISHED,
      testId: testData._id.toString(),
      testTitle: testData.title,
      action: {
        route: `/student/tests/${testData.title.replace(/ /g, '-')}/result`,
        params: { testId: testData._id.toString() },
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

async function notifyResultPublished(tenantId, studentIds, testData) {
  try {
    if (!studentIds || studentIds.length === 0) {
      return { success: false, message: "No students to notify" };
    }

    // 1) Push Real-time Socket/App Notification
    const message = buildTestResultPublishedMessage(testData);
    const result = await sendNotificationToStudents(
      tenantId,
      studentIds,
      message
    );

    // 2) Create Persistent TPO Notice Board Entry
    try {
      const db = await getTenantDB(tenantId);
      const dbCols = connectTodb(db);
      const noticeBoardCollection = dbCols.noticeBoard;
      const studentCollection = dbCols.student;

      if (noticeBoardCollection && studentCollection) {
        const testIdStr = testData._id.toString();
        // Check if notice for this test already exists
        let existingNotice = await noticeBoardCollection.findOne({ testId: testIdStr, type: "TEST_RESULT" });
        let noticeId;

        if (!existingNotice) {
          const noticeResult = await noticeBoardCollection.insertOne({
            title: `Test Results Published: ${testData.title}`,
            message: `The results for your test "<b>${testData.title}</b>" are now available.`,
            status: "active",
            createdAt: Date.now(),
            targetGroup: { code: "STU_CUSTOM" },
            source: "system",
            type: "TEST_RESULT",
            testId: testIdStr,
            actionUrl: `/student/tests/${testData.title.replace(/ /g, '-')}/result?testId=${testIdStr}`,
            actionText: "View Results"
          });
          noticeId = noticeResult.insertedId;
        } else {
          noticeId = existingNotice._id;
        }

        // Push noticeId to students
        const studentObjectIds = studentIds.map(id => new ObjectId(id));
        await studentCollection.updateMany(
          { _id: { $in: studentObjectIds } },
          { $addToSet: { noticeboard: noticeId.toString() } }
        );
      }
    } catch (dbError) {
      console.error("❌ Error persisting Result Notice Board entry:", dbError);
    }

    return {
      success: true,
      notificationType: NOTIFICATION_TYPES.TEST_RESULT_PUBLISHED,
      studentsNotified: result.success,
      ...result,
    };
  } catch (error) {
    console.error("❌ Error in notifyResultPublished:", error);
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
  notifyResultPublished,
  buildTestAssignedMessage,
  buildJobPostedMessage,
  buildJobUpdatedMessage,
  buildTestResultPublishedMessage,
};
