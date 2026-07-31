'use strict';

/**
 * Student Controller
 *
 * All business logic lives in the service file (student.service.js) which is
 * the original microservers/student/index.js without any changes.
 *
 * This controller file re-exports each handler function so routes can import
 * them cleanly without pulling in the Express app / listen calls.
 */

const mongoDB = require('mongodb');
const bcrypt = require('bcrypt');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const config = require('../../../config');
const { connectTodb } = require('../../../shared/db/connection');
const { getGlobalCollections } = require('../../../shared/db/connection');
const { getTenantDB } = require('../../../shared/db/connection');
const { parseIfJSON } = require('../../../shared/utils/helpers');
const { archiveAndDeleteOne, archiveAndDeleteMany } = require('../../../shared/utils/archive.service');
const mailVerification = require('../../../shared/utils/mailVerification');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: config.email.supportMail, pass: config.email.supportPass },
});

const secretToken = config.auth.cryptoSecret;

/* ──────────────────────────────────────────────────────────────
   generateEnrollmentId  (private helper — from original)
   ────────────────────────────────────────────────────────────── */
async function generateEnrollmentId(date = new Date(), tenantDB) {
  const { student } = connectTodb(tenantDB);
  if (!tenantDB) return 'No tenant DB available';
  const year = date.getFullYear().toString().slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const prefix = `${year}${month}`;
  const last = await student
    .find({ enrollementId: { $regex: `^${prefix}` } })
    .sort({ enrollementId: -1 })
    .limit(1)
    .toArray();
  let nextSeq = 1;
  if (last.length > 0) {
    const lastSeqNum = parseInt(last[0].enrollementId.slice(-6), 10);
    nextSeq = lastSeqNum + 1;
  }
  return prefix + String(nextSeq).padStart(6, '0');
}

/* ──────────────────────────────────────────────────────────────
   Handlers (identical logic to original, just named exports)
   ────────────────────────────────────────────────────────────── */

async function getStudent(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const findStudent = await student.findOne({ globalId: req.userId });
    if (!findStudent) throw new Error('Student not found');
    res.status(200).json({ data: findStudent });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getAllStudents(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const allStudents = await student.find({}).toArray();
    res.status(200).json({ data: allStudents });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getStudentCreds(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { email } = req.query;
    const findStudent = await student.findOne({ email });
    if (!findStudent) throw new Error('Student not found');
    res.status(200).json({ data: findStudent });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getSingleStudent(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { studentId } = req.params;
    const findStudent = await student.findOne({ globalId: studentId });
    if (!findStudent) throw new Error('Please select valid student');
    res.status(200).json({ data: findStudent });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function registerStudent(req, res) {
  const { student: studentCollection } = connectTodb
    ? (() => { try { return connectTodb(req.tenantDB || null); } catch (_) { return {}; } })()
    : {};
  const { mainDBusers, organisation } = getGlobalCollections();
  try {
    const {
      email, password, firstName, lastName, phone, orgId: bodyOrgId,
      userName, type, departmentId,
    } = req.body;
    const orgIdToUse = req.orgId || bodyOrgId;

    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);

    const verificationToken = CryptoJS.AES.encrypt(
      JSON.stringify({ email, orgId: orgIdToUse }),
      secretToken
    ).toString();

    const globalResult = await mainDBusers.insertOne({
      email, firstName, lastName, phone,
      password: hash, type: type || 'student', active: false,
      orgId: orgIdToUse, verificationToken,
    });

    await mailVerification.sendVerificationEmail(
      { email, name: firstName, verificationToken, orgId: orgIdToUse },
      config.urls.studentVerify
    );

    res.status(200).json({ success: true, message: 'Verification email sent' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function verifyStudent(req, res) {
  const { mainDBusers } = getGlobalCollections();
  try {
    const { token, orgId } = req.query;
    const bytes = CryptoJS.AES.decrypt(token, secretToken);
    const decoded = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
    if (!decoded.email) throw new Error('Invalid token');

    await mainDBusers.updateOne(
      { email: decoded.email },
      { $set: { active: true, verificationToken: null } }
    );
    res.status(200).json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function loginStudent(req, res) {
  const { student } = connectTodb(req.tenantDB);
  const { mainDBusers } = getGlobalCollections();
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { email, password } = req.body;
    const globalUser = await mainDBusers.findOne({ email });
    if (!globalUser) throw new Error('Student not registered');
    if (!globalUser.active) throw new Error('Please verify your email first');

    const isMatch = await bcrypt.compare(password, globalUser.password);
    if (!isMatch) throw new Error('Invalid credentials');

    const tenantStudent = await student.findOne({ email });

    const token = jwt.sign(
      {
        userId: globalUser._id.toString(),
        email: globalUser.email,
        orgId: req.orgId,
        role: 'STUDENT',
      },
      config.auth.jwtSecret
    );

    res.status(200).json({ success: true, token, data: tenantStudent || globalUser });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function updateStudent(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const update = req.body;
    await student.updateOne({ globalId: req.userId }, { $set: update });
    res.status(200).json({ success: true, message: 'Student updated' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function updateStudentWithId(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { studentId } = req.params;
    const findStudent = await student.findOne({ globalId: studentId });
    if (!findStudent?._id) throw new Error('Student not found to update');
    const update = req.body;
    const { email, globalId } = req.body;
    await student.updateOne({ globalId: studentId }, { $set: update });
    if (email) {
      const { mainDBusers } = getGlobalCollections();
      await mainDBusers.updateOne({ email: findStudent.email }, { $set: { email } });
    }
    res.status(200).json({ success: true, message: 'Student updated' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function deleteStudent(req, res) {
  const { student, departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { userID } = req.params;
    const archiveResult = await archiveAndDeleteOne(student, { globalId: userID }, {
      deletedBy: req.userId || req.userID || null,
      reason: req.body.reason || null,
    });
    if (archiveResult.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    res.status(200).json({ success: true, message: 'Student deleted' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function deleteAllStudent(req, res) {
  const { student, departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { deptId } = req.params;
    const covId = new mongoDB.ObjectId(deptId);
    const depatData = await departments.findOne({ _id: covId });
    if (!depatData) throw new Error('Department not found');
    const studentIds = depatData.students.map((e) => new mongoDB.ObjectId(e));
    const archiveResult = await archiveAndDeleteMany(student, { _id: { $in: studentIds } }, {
      deletedBy: req.userId || req.userID || null,
      reason: req.body.reason || null,
    });
    res.status(200).json({ success: true, message: 'Students deleted', deleted: archiveResult.deletedCount });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function createStudentAccount(req, res) {
  const { student, departments } = connectTodb(req.tenantDB);
  const { mainDBusers } = getGlobalCollections();
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    require('fs').appendFileSync('create_student_log.txt', "CREATE STUDENT ACCOUNT BODY: " + JSON.stringify(req.body) + "\n");
    const { email, password, userName, type, ...rest } = req.body;
    const findStudent = await student.findOne({ $or: [{ email }, { userName }] });
    if (findStudent) throw new Error('Student with this mail or phone or userName is already registered');
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);
    const enrollmentId = await generateEnrollmentId(new Date(), req.tenantDB);
    const globalStudent = await mainDBusers.findOne({ email });
    const globalId = globalStudent ? globalStudent._id.toString() : null;
    const result = await student.insertOne({
      ...rest,
      email, password: hash, userName, type: type || 'student',
      enrollementId: enrollmentId, globalId, active: true,
    });

    if (rest.department) {
      await departments.updateOne(
        { _id: new mongoDB.ObjectId(rest.department) },
        { $push: { students: result.insertedId.toString() } }
      );
    }

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function changeStudentEmail(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    if (!req.isAuth) throw new Error('User not authorized');
    const { oldEmail, newEmail } = req.body;
    await student.updateOne({ email: oldEmail }, { $set: { email: newEmail } });
    res.status(200).json({ success: true, message: 'Email changed' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function deleteAllStudentsFromOrg(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    await student.deleteMany({});
    res.status(200).json({ success: true, message: 'All students deleted' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getBatches(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const batchList = await student.distinct('batch');
    const yearList = await student.distinct('yearOfPassing');
    
    const combined = Array.from(
      new Set([
        ...(Array.isArray(batchList) ? batchList : []),
        ...(Array.isArray(yearList) ? yearList : [])
      ].map(y => (y ? String(y).trim() : '')))
    ).filter(y => y !== '' && y !== 'null' && y !== 'undefined');

    const formatted = combined.map(y => ({ yearOfPassing: y }));
    res.status(200).json({ data: formatted });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function studentsByIDs(req, res) {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { ids } = req.body;
    const objectIds = ids.map((id) => {
      try { return new mongoDB.ObjectId(id); } catch (_) { return id; }
    });
    const students = await student.find({ _id: { $in: objectIds } }).toArray();
    res.status(200).json({ data: students });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getAllStudentsAgg(req, res) {
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  const { student } = connectTodb(req.tenantDB);
  try {
    const pipeline = [];
    const students = await student.aggregate(pipeline).toArray();
    res.status(200).json({ data: students });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getPartnerColleges(req, res) {
  const { colleges } = getGlobalCollections();
  try {
    const data = await colleges.find({}).toArray();
    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getAllStudentsFromAllClgs(req, res) {
  const { mainDBusers } = getGlobalCollections();
  try {
    const students = await mainDBusers.find({ type: 'student' }).toArray();
    res.status(200).json({ data: students });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getStudentByGlobalIdAndOrgId(req, res) {
  try {
    const { globalId, sourceOrgId, orgId, includeJobs = false } = req.query;
    const finalOrgId = orgId || sourceOrgId;

    if (!globalId || !finalOrgId) {
      return res.status(400).json({
        success: false,
        error: "Both globalId and orgId are required",
      });
    }

    const tenantDB = await getTenantDB(finalOrgId);

    if (!tenantDB) {
      return res.status(404).json({
        success: false,
        error: "Organization not found or database not available",
      });
    }

    const { student, job, assignedJob } = connectTodb(tenantDB);
    const { organisation } = getGlobalCollections();

    const findStudent = await student.findOne({ globalId });

    if (!findStudent) {
      return res.status(404).json({
        success: false,
        error: "Student not found",
      });
    }

    let allJobProfiles = [];

    if (includeJobs === "true" || includeJobs === true) {
      const appliedJobObjects = Array.isArray(findStudent.appliedJobs)
        ? findStudent.appliedJobs
        : [];

      if (appliedJobObjects.length > 0) {
        const appliedJobIds = appliedJobObjects.map((jobObj) => jobObj.id);

        const objectIds = appliedJobIds
          .filter((id) => typeof id === "string" && id.match(/^[0-9a-fA-F]{24}$/))
          .map((id) => new mongoDB.ObjectId(id));

        if (objectIds.length > 0) {
          const localJobPipeline = [
            { $match: { _id: { $in: objectIds } } },
            {
              $project: {
                _id: 1, interviewStatusByApplicant: 1, profileName: 1, companyName: 1,
                jobDescription: 1, requirements: 1, location: 1, salary: 1, jobType: 1,
                experience: 1, skills: 1, postedDate: 1, applicationDeadline: 1,
                type: { $literal: "local" },
              },
            },
          ];

          const localJobs = await job.aggregate(localJobPipeline).toArray();

          const localJobsWithStatus = localJobs.map((localJob) => {
            const appliedJobObj = appliedJobObjects.find((obj) => obj.id === localJob._id.toString());
            return {
              ...localJob,
              applicationStatus: appliedJobObj?.status || "applied",
              appliedDate: appliedJobObj?.appliedDate || null,
              isAssignedJob: false,
            };
          });

          allJobProfiles = [...allJobProfiles, ...localJobsWithStatus];
        }

        const assignedJobsFromApplied = appliedJobObjects.filter((jobObj) => jobObj.isAssignedJob);

        if (assignedJobsFromApplied.length > 0) {
          const assignedJobPromises = assignedJobsFromApplied.map(async (jobObj) => {
            try {
              const assignedJobDoc = await assignedJob.findOne({ jobId: jobObj.id });
              if (assignedJobDoc) {
                const companyTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
                const { job: companyJobCollection } = connectTodb(companyTenantDB);
                const companyJob = await companyJobCollection.findOne({ _id: new mongoDB.ObjectId(jobObj.id) });

                if (companyJob) {
                  return {
                    ...companyJob,
                    type: "assigned",
                    companyOrgId: assignedJobDoc.companyOrgId,
                    applicationStatus: jobObj?.status || "applied",
                    appliedDate: jobObj?.appliedDate || null,
                    isAssignedJob: true,
                  };
                }
              }
            } catch (error) {
              console.error(`Error fetching assigned job ${jobObj.id}:`, error.message);
            }
            return null;
          });

          const assignedJobs = await Promise.all(assignedJobPromises);
          const validAssignedJobs = assignedJobs.filter((j) => j !== null);
          allJobProfiles = [...allJobProfiles, ...validAssignedJobs];
        }
      }
    }

    const organizationDetails = await organisation.findOne({ orgId: finalOrgId });

    const response = {
      success: true,
      data: {
        student: {
          ...findStudent,
          appliedJobs: (includeJobs === "true" || includeJobs === true) ? allJobProfiles : findStudent.appliedJobs,
        },
        organization: organizationDetails ? {
          orgId: organizationDetails.orgId,
          orgName: organizationDetails.orgName,
          type: organizationDetails.type,
        } : null,
      },
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching student by globalId and sourceOrgId:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
}

async function getStudentProgress(req, res) {
  const { job, student: studentCol, progress } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    if (!req.isAuth) throw new Error('User not authenticated');
    const studentData = await studentCol.findOne({ globalId: req.userId });
    const progressData = await progress.find({ studentId: req.userId }).toArray();
    res.status(200).json({ data: { student: studentData, progress: progressData } });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function saveStudentNotes(req, res) {
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const note = { ...req.body, studentId: req.userId, createdAt: new Date() };
    const result = await studentNotes.insertOne(note);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getStudentNotes(req, res) {
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const notes = await studentNotes.find({ studentId: req.userId }).toArray();
    res.status(200).json({ data: notes });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function updateStudentNote(req, res) {
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const { noteId } = req.params;
    await studentNotes.updateOne(
      { _id: new mongoDB.ObjectId(noteId) },
      { $set: req.body }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function deleteStudentNote(req, res) {
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const { noteId } = req.params;
    const archiveResult = await archiveAndDeleteOne(studentNotes, { _id: new mongoDB.ObjectId(noteId) }, {
      deletedBy: req.userId || req.userID || null,
      reason: req.body.reason || null,
    });
    if (archiveResult.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Note not found' });
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

async function getDashboardStats(req, res) {
  const { student, noticeBoard } = connectTodb(req.tenantDB);
  const { internshipsCollection } = getGlobalCollections();
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const foundStudent = await student.findOne({ globalId: req.userId });
    if (!foundStudent) return res.status(404).json({ err: 'Student not found' });

    const noticeBoardIds = (foundStudent.noticeboard ?? [])
      .map(e => new mongoDB.ObjectId(e));

    const [
      coursesCount,
      internshipsCount,
      notificationsCount,
      recentNotifications,
    ] = await Promise.all([
      internshipsCollection.countDocuments({ type: 'course' }),
      internshipsCollection.countDocuments({ type: 'internship' }),
      noticeBoardIds.length > 0
        ? noticeBoard.countDocuments({ _id: { $in: noticeBoardIds } })
        : Promise.resolve(0),
      noticeBoardIds.length > 0
        ? noticeBoard.find({ _id: { $in: noticeBoardIds } })
            .sort({ createdAt: -1 }).limit(5).toArray()
        : Promise.resolve([]),
    ]);

    res.status(200).json({
      coursesCount,
      internshipsCount,
      notificationsCount,
      recentNotifications,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
}

module.exports = {
  getStudent,
  getAllStudents,
  getStudentCreds,
  getSingleStudent,
  registerStudent,
  verifyStudent,
  loginStudent,
  updateStudent,
  updateStudentWithId,
  deleteStudent,
  deleteAllStudent,
  createStudentAccount,
  changeStudentEmail,
  deleteAllStudentsFromOrg,
  getBatches,
  studentsByIDs,
  getAllStudentsAgg,
  getPartnerColleges,
  getAllStudentsFromAllClgs,
  getStudentByGlobalIdAndOrgId,
  getStudentProgress,
  saveStudentNotes,
  getStudentNotes,
  updateStudentNote,
  deleteStudentNote,
  getDashboardStats,
};
