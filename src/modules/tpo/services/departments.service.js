const express = require("express");
const axios = require("axios");
const cors = require("cors");
const mongoDB = require("mongodb");
const mongoDb = require("mongodb");
const { ObjectId } = require("mongodb");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const { mainDBusers } = require("../../../shared/db/connection").getGlobalCollections();
const XLSX = require("xlsx");
const fs = require("fs");
const bcrypt = require("bcrypt");
const { sendVerificationEmail, sendBulkEmails, bulkTransporter } = require("../../../shared/utils/mailVerification");
const CryptoJS = require("crypto-js");
const config = require("../../../config");

async function generateEnrollmentId(date, tenantDB) {
  const { student } = connectTodb(tenantDB);
  if (!tenantDB) throw new Error("No tenant DB available");

  const year = date.getFullYear().toString().slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
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

  const seqString = String(nextSeq).padStart(6, "0");
  return prefix + seqString;
}

const app = express();
app.use(cors());
app.use(express.json());

app.use(authenticate);
app.use(selectTenantDB);

module.exports.createDepartment = async (req, res) => {
  const { departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { title, hodName } = req.body;

    const findDepartment = await departments.findOne({
      $and: [{ title }, { hodName }],
    });

    if (findDepartment)
      throw new Error("Department with this details already present");

    const insertedData = await departments.insertOne({
      ...req.body,
      createdAt: new Date().getTime(),
    });

    res
      .status(200)
      .json({ msg: "Department created successfully", data: insertedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAllDepartments = async (req, res) => {
  const { departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    let { limit = 20, cursor = null } = req.query;

    limit = parseInt(limit, 10);

    const pipeline = [];

    if (cursor && cursor !== "null") {
      pipeline.push({
        $match: {
          _id: { $lt: new ObjectId(cursor) },
        },
      });
    }

    pipeline.push({ $sort: { _id: -1 } });

    pipeline.push({ $limit: limit + 1 });

    const docs = await departments.aggregate(pipeline).toArray();

    let hasNext = false;
    let nextCursor = null;
    let data = docs;

    if (docs.length > limit) {
      hasNext = true;
      const nextDoc = docs[limit];
      nextCursor = nextDoc._id.toString();
      data = docs.slice(0, limit);
    }

    res.status(200).json({
      data,
      next: hasNext,
      nextCursor,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getOneDepartmentsWithId = async (req, res) => {
  const { departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const getOneDepatment = await departments.findOne({
      _id: new ObjectId(id),
    });

    if (!getOneDepatment)
      throw new Error("Please select valid department to get");

    res.status(200).json({ data: getOneDepatment });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getStudentsInDepartments = async (req, res) => {
  const { departments, student: users } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { departmentId } = req.params;
    console.log(departmentId);

    const findDepartment = await departments.findOne({
      _id: new ObjectId(departmentId),
    });

    if (!findDepartment) throw new Error("Please select valid department");

    const pipeLine = [
      {
        $match: {
          department: departmentId,
        },
      },
    ];
    const getStudentsWithDepartmentId = await users
      .aggregate(pipeLine)
      .toArray();

    res.status(200).json({
      data: getStudentsWithDepartmentId,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getStudentsByOrgAndDepartment = async (req, res) => {
  try {
    const { orgId, departmentId } = req.params;

    if (!orgId) {
      return res.status(400).json({ error: "Missing orgId" });
    }

    if (!departmentId) {
      return res.status(400).json({ error: "Missing departmentId" });
    }

    // Import necessary utilities
    const { getTenantDB } = require("../../../shared/db/connection");
    const { organisation } = require("../../../shared/db/connection").getGlobalCollections();
    const { connectTodb } = require("../../../shared/db/connection");
    const { ObjectId } = require("mongodb");

    // Verify organization exists
    const orgRecord = await organisation.findOne({ orgId });
    if (!orgRecord) {
      return res.status(404).json({
        error: `Organization "${orgId}" not found`,
      });
    }

    // Get tenant database
    const tenantDB = await getTenantDB(orgId);
    const { departments, student } = connectTodb(tenantDB);

    // Verify department exists
    const department = await departments.findOne({
      _id: new ObjectId(departmentId),
    });

    if (!department) {
      return res.status(404).json({
        error: "Department not found",
      });
    }

    // Fetch students in this department
    const students = await student
      .find({
        department: departmentId,
      })
      .toArray();

    res.status(200).json({
      success: true,
      orgId,
      orgName: orgRecord.name,
      department: {
        id: department._id,
        title: department.title,
        hodName: department.hodName,
      },
      students,
      totalStudents: students.length,
    });
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({
      success: false,
      err: error.message,
    });
  }
};

module.exports.getStudentsWithoutValidDepartment = async (req, res) => {
  const { departments, users } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const validDepartments = await departments.find({}).toArray();
    const validDepartmentIds = validDepartments.map((dep) =>
      dep._id.toString()
    );

    const pipeline = [
      {
        $match: {
          $or: [
            { department: { $exists: false } },
            { department: { $eq: null } },
            { department: { $nin: validDepartmentIds } },
          ],
        },
      },
    ];

    const studentsWithoutValidDepartment = await users
      .aggregate(pipeline)
      .toArray();

    res.status(200).json({
      data: studentsWithoutValidDepartment,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateDepartment = async (req, res) => {
  const { departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const getOneDepatment = await departments.findOne({
      _id: new ObjectId(id),
    });

    if (!getOneDepatment)
      throw new Error("Please select valid department to update");

    const updatedData = await departments.updateOne(
      { _id: getOneDepatment._id },
      {
        $set: { ...req.body, updatedAt: new Date().getTime() },
      }
    );

    res
      .status(200)
      .json({ msg: "Department updated Successfully", data: updatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deleteDepartment = async (req, res) => {
  const { student, departments } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;
    const covId = new mongoDB.ObjectId(id);

    const depatData = await departments.findOne({
      _id: covId,
    });
    if (!depatData) throw new Error("Department not found");
    const studentIds = depatData?.students?.map(
      (e) => new mongoDB.ObjectId(e)
    ) || [null];
    // if (studentIds.length === 0) {
    //   throw new Error("No students found in this department");
    // }
    const studentsData = await student
      .find({
        _id: { $in: studentIds },
      })
      .toArray();
    // if (studentsData.length === 0) {
    //   throw new Error("No students found in this department");
    // }
    await student.deleteMany({
      _id: { $in: studentIds },
    });

    const studentGIds = studentsData?.map(
      (e) => new mongoDB.ObjectId(e.globalId)
    );
    await mainDBusers.deleteMany({
      _id: { $in: studentGIds },
    });

    await departments.deleteOne({
      _id: new mongoDB.ObjectId(id),
    });

    res.status(200).send({
      msg: "Student deleted successfully",
      ...studentsData?.map((e) => e.userName),
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.bulkUploadStudentsToDepartment = async (req, res) => {
  const { departments, student } = connectTodb(req.tenantDB);
  if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });

  try {
    if (!req.file) {
      return res.status(400).json({ err: "Please upload a file" });
    }

    const { id } = req.params;
    const getOneDepatment = await departments.findOne({ _id: new ObjectId(id) });
    if (!getOneDepatment) throw new Error("Please select valid department to upload");

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawStudents = XLSX.utils.sheet_to_json(sheet);

    const normalizeKey = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, "").trim();

    const fieldMapping = {
      username: "userName", user_name: "userName", "user name": "userName", uname: "userName", userName: "userName",
      firstname: "firstName", first_name: "firstName", "first name": "firstName", fname: "firstName", firstName: "firstName",
      lastname: "lastName", last_name: "lastName", "last name": "lastName", lname: "lastName", lastName: "lastName",
      email: "email", emailaddress: "email", email_address: "email", "email address": "email", mail: "email", "E-Mail": "email", "E-mail": "email", "e-mail": "email",
      phone: "phone", phonenumber: "phone", phone_number: "phone", "phone number": "phone", mobile: "phone", contact: "phone",
      yearofpassing: "yearOfPassing", yearOfPassing: "yearOfPassing", year_of_passing: "yearOfPassing", "year of passing": "yearOfPassing", passingyear: "yearOfPassing", passing_year: "yearOfPassing", "passing year": "yearOfPassing", graduationyear: "yearOfPassing", graduation_year: "yearOfPassing", "graduation year": "yearOfPassing",
      college: "college", collegename: "college", college_name: "college", "college name": "college", institution: "college",
    };

    const mapStudentData = (rawStudent) => {
      const mappedStudent = {};
      Object.keys(rawStudent).forEach((key) => {
        const normalizedKey = normalizeKey(key);
        const schemaField = fieldMapping[normalizedKey];
        if (schemaField) mappedStudent[schemaField] = rawStudent[key];
      });
      return mappedStudent;
    };

    const students = rawStudents.map(mapStudentData);
    const successCount = [];
    const failedCount = [];
    const errors = [];
    const credentialsEmailsArray = [];
    const verificationEmailsArray = [];

    for (const [index, studentData] of students.entries()) {
      try {
        if (!studentData.email) {
          errors.push({ row: index + 2, email: "N/A", reason: "Missing email" });
          failedCount.push(index);
          continue;
        }

        const existingStudent = await student.findOne({ email: studentData.email });
        if (existingStudent) {
          errors.push({ row: index + 2, email: studentData.email, reason: "Already exists in tenant" });
          failedCount.push(index);
          continue;
        }

        const plainPassword = Math.random().toString(36).slice(-8);
        const salt = await bcrypt.genSalt();
        const hashedPassword = await bcrypt.hash(plainPassword, salt);

        let existingGlobalStudent = await mainDBusers.findOne({ email: studentData.email });
        let globalId;

        if (!existingGlobalStudent) {
          const globalData = await mainDBusers.insertOne({
            email: studentData.email,
            password: hashedPassword,
            orgId: req.orgId,
            type: studentData.type || "student",
            createdAt: new Date().getTime(),
            active: true,
          });
          globalId = globalData.insertedId.toString();
        } else {
          await mainDBusers.updateOne({ _id: existingGlobalStudent._id }, { $set: { orgId: req.orgId } });
          globalId = existingGlobalStudent._id.toString();
        }

        const enrollementId = await generateEnrollmentId(new Date(), req.tenantDB);

        const studentObj = {
          userName: studentData.userName,
          email: studentData.email,
          phone: studentData.phone,
          firstName: studentData.firstName,
          lastName: studentData.lastName,
          department: getOneDepatment._id.toString(),
          createdAt: new Date(),
          enrollementId: enrollementId,
          college: studentData.college,
          yearOfPassing: studentData.yearOfPassing,
          globalId: globalId,
          active: true,
          type: "student",
        };

        const insertResult = await student.insertOne(studentObj);
        const insertedStudentId = insertResult.insertedId.toString();

        await departments.updateOne(
          { _id: new ObjectId(id) },
          { $addToSet: { students: insertedStudentId } }
        );

        credentialsEmailsArray.push({
          from: process.env.support_mail || "admin@skillmedha.com",
          to: studentObj.email,
          subject: "Skill Medha Account Created",
          html: `
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Account Created</title>
          </head>
          <body style="font-family: Arial, sans-serif; color: #333;">
              <p>Hi ${studentObj.userName || studentObj.firstName || "there"},</p>
              <p>Welcome! Your account has been created successfully. Here is your temporary password:</p>
              <p style="font-size: 1.1em;"><strong>Password:</strong> ${plainPassword}</p>
              <p>For your security, we strongly recommend you change this password after your first login.</p>
              <a href="${process.env.STUDENT_PORTAL_URL || "https://student.skillmedha.com"}" style="display: inline-block; background-color: #25a3a6; color: #ffffff; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                  Login and Change Password
              </a>
              <p>Regards,<br>The Admin Team</p>
          </body>
          </html>`
        });

        const verificationToken = CryptoJS.AES.encrypt(
          JSON.stringify({
            email: studentObj.email,
            orgId: req.orgId
          }),
          config.auth.cryptoSecret
        ).toString();

        verificationEmailsArray.push({
          email: studentObj.email,
          name: studentObj.userName || studentObj.firstName || "Student",
          verificationToken: verificationToken,
          orgId: req.orgId,
        });

        successCount.push(index);
      } catch (err) {
        errors.push({ row: index + 2, email: studentData.email || "N/A", reason: err.message });
        failedCount.push(index);
      }
    }

    // Send emails in background sequentially and batched
    sendBulkEmails(credentialsEmailsArray, bulkTransporter).catch(console.error);
    verificationEmailsArray.forEach(payload => {
      sendVerificationEmail(
        {
          email: payload.email,
          name: payload.name,
          verificationToken: payload.verificationToken,
          orgId: payload.orgId
        },
        config.urls.studentVerify
      );
    });

    res.status(200).json({
      success: successCount.length,
      failed: failedCount.length,
      createdStudents: successCount.length,
      errors: errors,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  } finally {
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr) console.error("Failed to delete temp file:", unlinkErr);
      });
    }
  }
};
