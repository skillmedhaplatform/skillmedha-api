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
  const year  = date.getFullYear().toString().slice(-2);
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
router.get('/getStudentCreds', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const email = req.query.email || req.email;
    let findStudent = await student.findOne({ email });
    if (!findStudent) {
      const { mainDBusers } = getCollections();
      findStudent = await mainDBusers.findOne({ email });
    }
    if (!findStudent) throw new Error('Student not found');
    res.status(200).json({ data: { ...findStudent, orgDetails: { orgId: req.orgId } } });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getSingleStudent/:studentId */
router.get('/getSingleStudent/:studentId', authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { studentId } = req.params;
    const findStudent = await student.findOne({ globalId: studentId });
    if (!findStudent) throw new Error('Please select valid student');
    res.status(200).json({ data: { ...findStudent, orgDetails: { orgId: req.orgId } } });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* POST /createStudentAccount */
router.post('/createStudentAccount', authenticate, selectTenantDB, async (req, res) => {
  const { student, departments } = connectTodb(req.tenantDB);
  const { mainDBusers } = getCollections();
  if (!req.tenantDB) return res.status(500).json({ error: 'No tenant DB available' });
  try {
    const { email, password, userName, type, ...rest } = req.body;
    const findStudent = await student.findOne({ $or: [{ email }, { userName }] });
    if (findStudent) throw new Error('Student with this mail or phone or userName is already registered');
    const enrollmentId = await generateEnrollmentId(new Date(), req.tenantDB);
    const findGlobalStudent = await mainDBusers.findOne({ email });
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash(password, salt);
    
    let globalId = findGlobalStudent ? findGlobalStudent._id.toString() : null;
    if (!findGlobalStudent) {
      const globalResult = await mainDBusers.insertOne({
        email: email.toLowerCase(),
        password: hash,
        userName,
        firstName: rest.firstName,
        lastName: rest.lastName,
        phone: rest.phone,
        type: type || 'student',
        active: true,
        orgId: req.orgId
      });
      globalId = globalResult.insertedId.toString();
    }

    const result = await student.insertOne({
      ...rest,
      email: email.toLowerCase(), password: hash, userName, type: type || 'student',
      enrollementId: enrollmentId, globalId, active: true,
    });
    
    if (rest.department) {
      await departments.updateOne(
        { _id: new mongoDB.ObjectId(rest.department) },
        { $push: { students: result.insertedId.toString() } }
      );
    }
    
    res.status(200).json({ success: true, data: result });
  } catch (error) { res.status(500).json({ err: error.message }); }
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
    const { token } = req.query;
    const bytes = CryptoJS.AES.decrypt(token, secretToken);
    const decoded = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
    if (!decoded.email) throw new Error('Invalid token');
    await mainDBusers.updateOne({ email: decoded.email }, { $set: { active: true, verificationToken: null } });
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
    
    res.status(200).json({ success: true, token, data: tenantStudent || globalUser });
  } catch (error) { res.status(500).json({ err: error.message }); }
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
    const objectIds = ids.map((id) => { try { return new mongoDB.ObjectId(id); } catch(_) { return id; } });
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
  const { colleges } = getCollections();
  try {
    const data = await colleges.find({}).toArray();
    res.status(200).json({ data });
  } catch (error) { res.status(500).json({ err: error.message }); }
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
    const { globalId, orgId } = req.query;
    const tenantDB = await getTenantDB(orgId);
    const { student } = connectTodb(tenantDB);
    const findStudent = await student.findOne({ globalId });
    res.status(200).json({ data: findStudent });
  } catch (error) { res.status(500).json({ err: error.message }); }
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
router.post('/saveStudentNotes', authenticate, async (req, res) => {
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const note = { ...req.body, studentId: req.userId, createdAt: new Date() };
    const result = await studentNotes.insertOne(note);
    res.status(200).json({ success: true, data: result });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* GET /getStudentNotes */
router.get('/getStudentNotes', authenticate, async (req, res) => {
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const notes = await studentNotes.find({ studentId: req.userId }).toArray();
    res.status(200).json({ data: notes });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* PUT /updateStudentNote/:noteId */
router.put('/updateStudentNote/:noteId', authenticate, async (req, res) => {
  const { studentNotes } = connectTodb(req.tenantDB);
  try {
    const { noteId } = req.params;
    await studentNotes.updateOne({ _id: new mongoDB.ObjectId(noteId) }, { $set: req.body });
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ err: error.message }); }
});

/* DELETE /deleteStudentNote/:noteId */
router.delete('/deleteStudentNote/:noteId', authenticate, async (req, res) => {
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
  } catch (error) { res.status(500).json({ err: error.message }); }
});

module.exports = router;
