'use strict';

/**
 * Student Service Adapter
 *
 * The original skillmedha_server/microservers/student/index.js is a standalone
 * Express app. This adapter:
 *   1. Replaces the old require paths with the new shared/* paths
 *   2. Exports the Express `app` as a Router (no listen call)
 *
 * All business logic is IDENTICAL to the original — only imports and
 * the final app.listen() call are changed.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../../.env') });

const express = require('express');
const { json, urlencoded } = require('express');
const mongoDB = require('mongodb');
const bcrypt = require('bcrypt');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const nodemailer = require('nodemailer');

// ─── Shared imports (new paths) ───────────────────────────────────────────────
const { mandatory: authenticate } = require('../../../shared/middleware/auth.middleware');
const { selectTenantDB } = require('../../../shared/middleware/selectTenantDB.middleware');
const { connectTodb, getGlobalCollections, getTenantDB } = require('../../../shared/db/connection');
const studentCtrl = require('../controllers/student.controller');
const { parseIfJSON } = require('../../../shared/utils/helpers');
const { archiveAndDeleteOne, archiveAndDeleteMany } = require('../../../shared/utils/archive.service');
const config = require('../../../config');

// ─── Global collections ───────────────────────────────────────────────────────
const getCollections = () => getGlobalCollections();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: config.email.supportMail, pass: config.email.supportPass },
});

const secretToken = config.auth.cryptoSecret;

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function generateEnrollmentId(date = new Date(), tenantDB) {
  if (!tenantDB) return 'No tenant DB available';
  const { student } = connectTodb(tenantDB);
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

function sendVerificationEmail({ email, name, verificationToken, orgId }, redirectUrl) {
  const link = `${config.urls.studentVerify}/verify?token=${verificationToken}&orgId=${orgId}`;
  const html = `<!DOCTYPE html><html><body><p>Hi ${name}, click <a href="${link}">here</a> to verify your email.</p></body></html>`;
  return transporter.sendMail({
    from: config.email.noreplyMail,
    to: email,
    subject: 'Verify Your Email – Skill Medha',
    html,
  });
}

// ─── Router (replaces standalone Express app) ────────────────────────────────
const router = express.Router();

/* GET / */
router.get('/', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const findStudent = await student.findOne({ globalId: req.userId });
    if (!findStudent) throw new Error('Student not found');
    res.status(200).json({ data: findStudent });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getAllStudents */
router.get('/getAllStudents', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const allStudents = await student.find({}).toArray();
    res.status(200).json({ data: allStudents });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getStudentCreds */
router.get('/getStudentCreds', authenticate, selectTenantDB, studentCtrl.getStudentCreds);

/* GET /getSingleStudent/:studentId */
router.get('/getSingleStudent/:studentId', authenticate, selectTenantDB, studentCtrl.getSingleStudent);

/* POST /createStudentAccount */
router.post('/createStudentAccount', authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  const { student, departments } = connectTodb(req.tenantDB);
  const { mainDBusers } = getCollections();
  try {
    const { email, password, userName, type, ...rest } = req.body;

    const findStudent = await student.findOne({ $or: [{ email }, { userName }] });
    if (findStudent) throw new Error('Student with this mail or phone or userName is already registered');

    const enrollmentId = await generateEnrollmentId(new Date(), req.tenantDB);
    const findGlobalStudent = await mainDBusers.findOne({ email });
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);

    let globalId = null;

    if (findGlobalStudent) {
      // Already exists — just reactivate
      globalId = findGlobalStudent._id.toString();
      await mainDBusers.updateOne(
        { _id: findGlobalStudent._id },
        { $set: { active: true } }
      );
    } else {
      // New user — insert into main DB
      const globalResult = await mainDBusers.insertOne({
        email: email.toLowerCase(),
        password: hash,
        userName,
        firstName: rest.firstName,
        lastName: rest.lastName,
        phone: rest.phone,
        type: type || 'student',
        active: true,
        createdAt: new Date().getTime(),
        orgId: req.orgId
      });
      globalId = globalResult.insertedId.toString();
    }

    const result = await student.insertOne({
      ...rest,
      email: email.toLowerCase(), password: hash, userName, type: type || 'student',
      enrollementId: enrollmentId, globalId, active: true,
      createdAt: new Date().toLocaleString(),
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
});

/* POST /registerStudent */
router.post('/registerStudent', async (req, res) => {
  const { mainDBusers } = getCollections();
  try {
    const { email, password, firstName, lastName, phone, orgId: bodyOrgId } = req.body;
    let orgIdToUse = req.orgId || bodyOrgId;

    // Map 'skill' alias to actual special organization ID
    if (orgIdToUse === "skill") {
      orgIdToUse = "skill_68e9fa374c2e0b6f153a3135";
    }

    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);
    const verificationToken = CryptoJS.AES.encrypt(
      JSON.stringify({ email, orgId: orgIdToUse }), secretToken
    ).toString();
    await mainDBusers.insertOne({
      email, firstName, lastName, phone, password: hash,
      type: 'student', active: false, orgId: orgIdToUse, verificationToken,
    });
    await sendVerificationEmail({ email, name: firstName, verificationToken, orgId: orgIdToUse });
    res.status(200).json({ success: true, message: 'Verification email sent' });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /verify */
router.get('/verify', async (req, res) => {
  const { mainDBusers } = getCollections();
  try {
    const { token, orgId } = req.query;
    const bytes = CryptoJS.AES.decrypt(token, secretToken);
    const decoded = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
    if (!decoded.email) throw new Error('Invalid token');

    await mainDBusers.updateOne({ email: decoded.email }, { $set: { active: true, verificationToken: null } });

    if (decoded.orgId || orgId) {
      const targetOrgId = decoded.orgId || orgId;
      const tenantDB = await getTenantDB(targetOrgId);
      const { student } = connectTodb(tenantDB);
      await student.updateOne({ email: decoded.email }, { $set: { verified: true, active: true } });
    }

    res.status(200).json({ success: true, message: 'Email verified successfully' });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /loginStudent  (also aliased as /studentLogin for frontend compatibility) */
router.post(['/loginStudent', '/studentLogin'], async (req, res) => {
  const { mainDBusers } = getCollections();
  try {
    const { email, password } = req.body;
    const globalUser = await mainDBusers.findOne({ email });
    if (!globalUser) throw new Error('Student not registered');
    if (!globalUser.active) throw new Error('Please verify your email first');
    const isMatch = await bcrypt.compare(password, globalUser.password);
    if (!isMatch) throw new Error('Invalid credentials');

    let tenantStudent = null;
    if (globalUser.orgId) {
      const tenantDB = await getTenantDB(globalUser.orgId);
      const { student } = connectTodb(tenantDB);
      tenantStudent = await student.findOne({ email });
    }

    const token = jwt.sign(
      { userId: globalUser._id.toString(), email: globalUser.email, orgId: globalUser.orgId, role: 'STUDENT' },
      config.auth.jwtSecret
    );

    const responseData = tenantStudent || globalUser;
    responseData.verified = globalUser.active;
    responseData.active = globalUser.active;

    res.status(200).json({ success: true, token, data: responseData });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /resendVerifyEmail */
router.post('/resendVerifyEmail', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  const { mainDBusers } = getCollections();

  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });

  try {
    if (!req.isAuth) return res.status(401).json({ error: 'User not authorized' });

    const findStudent = await student.findOne({ globalId: req.userId });
    if (!findStudent) return res.status(404).json({ error: 'Student not found' });

    const globalUser = await mainDBusers.findOne({ email: findStudent.email });
    if (!globalUser) return res.status(404).json({ error: 'Global student record not found' });

    if (globalUser.active) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    const verificationToken = CryptoJS.AES.encrypt(
      JSON.stringify({ email: findStudent.email, orgId: req.orgId }),
      config.auth.cryptoSecret
    ).toString();

    await mainDBusers.updateOne(
      { email: findStudent.email },
      { $set: { verificationToken } }
    );

    await sendVerificationEmail(
      {
        email: findStudent.email,
        name: findStudent.userName || findStudent.firstName || 'Student',
        verificationToken,
        orgId: req.orgId,
      },
      config.urls.studentVerify
    );

    res.status(200).json({ success: true, message: 'Verification email sent successfully', msg: 'Verification email sent successfully' });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

/* POST /updateStudent */
router.post('/updateStudent', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    await student.updateOne({ globalId: req.userId }, { $set: req.body });
    res.status(200).json({ success: true, message: 'Student updated' });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /updateStudentWithId/:studentId */
router.post('/updateStudentWithId/:studentId', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  const { mainDBusers } = getCollections();
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { studentId } = req.params;
    const findStudent = await student.findOne({ globalId: studentId });
    if (!findStudent?._id) throw new Error('Student not found to update');
    const update = req.body;
    await student.updateOne({ globalId: studentId }, { $set: update });
    if (update.email) {
      await mainDBusers.updateOne({ email: findStudent.email }, { $set: { email: update.email } });
    }
    res.status(200).json({ success: true, message: 'Student updated' });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /deleteStudent/:userID */
router.post('/deleteStudent/:userID', authenticate, selectTenantDB, async (req, res) => {
    const { mainDBusers } = getCollections();

  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { userID } = req.params;
    let query = { globalId: userID };
    if (userID === 'null') {
      query = { globalId: null };
    } else if (userID && userID.length === 24) {
      query = { $or: [{ globalId: userID }, { _id: new mongoDB.ObjectId(userID) }] };
    }
    const archiveResult = await archiveAndDeleteOne(student, query, {
      deletedBy: req.userId || req.userID || null,
      reason: req.body.reason || null,
    });
    if (archiveResult.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const studentEmail = archiveResult.deletedDocument?.email;
    if (!studentEmail) throw new Error('Deleted student has no email — cannot update departments or main users');
    await mainDBusers.updateOne(
      { email: studentEmail },
      { $set: { active: false } }
    );
    res.status(200).json({ success: true, message: 'Student deleted' });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /deleteAllStudent/:deptId */
router.post('/deleteAllStudent/:deptId', authenticate, selectTenantDB, async (req, res) => {
  const { student, departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { deptId } = req.params;
    const covId = new mongoDB.ObjectId(deptId);
    const depatData = await departments.findOne({ _id: covId });
    if (!depatData) throw new Error('Department not found');
    const studentIds = depatData.students.map((e) => new mongoDB.ObjectId(e));
    const studentsData = await student.find({ _id: { $in: studentIds } }).toArray();
    const archiveResult = await archiveAndDeleteMany(student, { _id: { $in: studentIds } }, {
      deletedBy: req.userId || req.userID || null,
      reason: req.body.reason || null,
    });
    res.status(200).json({ success: true, deleted: archiveResult.deletedCount });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /changeStudentEmail */
router.post('/changeStudentEmail', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    if (!req.isAuth) throw new Error('User not authorized');
    const { oldEmail, newEmail } = req.body;
    await student.updateOne({ email: oldEmail }, { $set: { email: newEmail } });
    res.status(200).json({ success: true, message: 'Email changed' });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /deleteAllStudentsFromOrg */
router.post('/deleteAllStudentsFromOrg', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const AllStudents = await student.find({}).toArray();
    await student.deleteMany({});
    res.status(200).json({ success: true, deleted: AllStudents.length });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /batches */
router.get('/batches', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const batches = await student.distinct('batch');
    res.status(200).json({ data: batches });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /studentsByIDs */
router.post('/studentsByIDs', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { ids } = req.body;
    const objectIds = ids.map((id) => { try { return new mongoDB.ObjectId(id); } catch (_) { return id; } });
    const students = await student.find({ _id: { $in: objectIds } }).toArray();
    res.status(200).json({ data: students });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getAllStudentsAgg */
router.get('/getAllStudentsAgg', authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  const { student } = connectTodb(req.tenantDB);
  try {
    const students = await student.aggregate([]).toArray();
    res.status(200).json({ data: students });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /partnerColleges */
router.get('/partnerColleges', async (req, res) => {
  const { organisation } = getCollections();
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "name",
      sortOrder = "desc",
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    if (pageNum < 1) return res.status(400).json({ error: "Page must be greater than 0" });
    if (limitNum < 10) return res.status(400).json({ error: "Limit must be at least 10" });
    if (limitNum > 100) return res.status(400).json({ error: "Limit cannot exceed 100" });

    const skip = (pageNum - 1) * limitNum;
    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    const [partnerColleges, totalCount] = await Promise.all([
      organisation
        .find({ type: "college" })
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      organisation.countDocuments({ type: "college" }),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.status(200).json({
      success: true,
      data: partnerColleges,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalCount,
        limit: limitNum,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? pageNum + 1 : null,
        prevPage: hasPrevPage ? pageNum - 1 : null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* GET /getAllStudentsFromAllClgs */
router.get('/getAllStudentsFromAllClgs', async (req, res) => {
  const { mainDBusers } = getCollections();
  try {
    const students = await mainDBusers.find({ type: 'student' }).toArray();
    res.status(200).json({ data: students });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getStudentByGlobalIdAndOrgId */
router.get('/getStudentByGlobalIdAndOrgId', async (req, res) => {
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
});

/* GET /getStudentProgress */
router.get('/getStudentProgress', authenticate, selectTenantDB, async (req, res) => {
  const { job, student: studentCol, progress } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    if (!req.isAuth) throw new Error('User not authenticated');
    const studentData = await studentCol.findOne({ globalId: req.userId });
    const progressData = await progress.find({ studentId: req.userId }).toArray();
    res.status(200).json({ data: { student: studentData, progress: progressData } });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /saveStudentNotes */
/* POST /saveStudentNotes */
/* POST /saveStudentNotes */
router.post('/saveStudentNotes', authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const { courseid, topicid, topicTitle, sectionid, sectionTitle, videoTimestamp, notesdescription } = req.body;

    if (!courseid || !topicid || !notesdescription) {
      return res.status(400).json({ err: 'courseid, topicid, and notesdescription are required' });
    }

    const note = {
      courseid,
      topicid,
      topicTitle: topicTitle || '',
      sectionid: sectionid || '',
      sectionTitle: sectionTitle || '',
      videoTimestamp: videoTimestamp || '0:00',
      notesdescription,
      studentId: req.userID,
      createdAt: new Date(),
    };

    const result = await studentNotes.insertOne(note);
    res.status(200).json({ success: true, data: { ...note, _id: result.insertedId } });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getStudentNotes */
router.get('/getStudentNotes', authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const { courseid, topicid } = req.query;

    const filter = { studentId: req.userID };
    if (courseid) filter.courseid = courseid;
    if (topicid) filter.topicid = topicid;

    const notes = await studentNotes.find(filter).sort({ createdAt: -1 }).toArray();
    res.status(200).json({ success: true, data: notes });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* PUT /updateStudentNote/:noteId */
router.put('/updateStudentNote/:noteId', authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const { noteId } = req.params;
    const { notesdescription } = req.body;

    if (!notesdescription) {
      return res.status(400).json({ err: 'notesdescription is required' });
    }

    const result = await studentNotes.updateOne(
      { _id: new mongoDB.ObjectId(noteId), studentId: req.userID }, // scope to owner
      { $set: { notesdescription, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Note not found' });
    }

    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* DELETE /deleteStudentNote/:noteId */
router.delete('/deleteStudentNote/:noteId', authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const { noteId } = req.params;
    const archiveResult = await archiveAndDeleteOne(
      studentNotes,
      { _id: new mongoDB.ObjectId(noteId), studentId: req.userID }, // scope to owner
      {
        deletedBy: req.userID || null,
        reason: req.body?.reason || null,
      }
    );
    if (archiveResult.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Note not found' });
    }
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getStudentNotes */


module.exports = router;
