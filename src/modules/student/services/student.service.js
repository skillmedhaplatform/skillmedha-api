require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});
const express = require("express");
const { json, urlencoded } = require("express");
const mongoDB = require("mongodb");
const bcrypt = require("bcryptjs");
const CryptoJS = require("crypto-js");
// const { student, job } = require("../../../shared/db/connection").getGlobalCollections();
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const { archiveAndDeleteOne, archiveAndDeleteMany } = require("../../../shared/utils/archive.service");

const nodemailer = require("nodemailer");
const auth = require("../../../shared/middleware/auth.middleware");
const { mainDBusers, organisation } = require("../../../shared/db/connection").getGlobalCollections();
const { getTenantDB } = require("../../../shared/db/connection");
const { parseIfJSON } = require("../../../shared/utils/helpers");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.support_mail,
    pass: process.env.support_pass,
  },
});

const app = express.Router();
const port = 2004;



// app.use(authenticate);
// app.use(selectTenantDB);
// app.use(auth);
const secretToken = process.env.CRYPTOSECRET;

async function generateEnrollmentId(date = new Date(), tenantDB) {
  const { student } = connectTodb(tenantDB);
  if (tenantDB) return "No tenant DB available";
  const year = date.getFullYear().toString().slice(-2); // "25"
  const month = String(date.getMonth() + 1).padStart(2, "0"); // "05"
  const prefix = `${year}${month}`; // "2505"

  // 1) find only this month's students, sort by enrollementId desc
  const last = await student
    .find({ enrollementId: { $regex: `^${prefix}` } })
    .sort({ enrollementId: -1 })
    .limit(1)
    .toArray();

  // 2) determine next sequence
  let nextSeq = 1;
  if (last.length > 0) {
    // take the last 6 chars of the string and parse to number
    const lastSeqNum = parseInt(last[0].enrollementId.slice(-6), 10);
    nextSeq = lastSeqNum + 1;
  }

  // 3) pad to 6 digits and return full 10-char ID
  const seqString = String(nextSeq).padStart(6, "0");
  return prefix + seqString; // e.g. "2505000001", then "2505000002", etc.
}

function sendVerificationEmail(
  { email, name, verificationToken, orgId },
  redirectUrl,
) {
  const link = `${process.env.STUDENT_VERIFY_URL}/verify?token=${verificationToken}&orgId=${orgId}`;

  const html = `
    <!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Verify Your Email – Skill Medha</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        background-color: #f4f6f8;
        margin: 0;
        padding: 0;
        color: #333;
      }
      .container {
        max-width: 600px;
        margin: 40px auto;
        background-color: #ffffff;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
        overflow: hidden;
      }
      .header {
        background-color: #00796b;
        color: #ffffff;
        padding: 20px;
        text-align: center;
      }
      .header h1 {
        margin: 0;
        font-size: 24px;
      }
      .content {
        padding: 30px;
      }
      .content h2 {
        color: #333333;
        font-size: 20px;
      }
      .verify-button {
        display: inline-block;
        margin-top: 20px;
        padding: 12px 24px;
        background-color: #009688;
        color: #ffffff;
        text-decoration: none;
        border-radius: 6px;
        font-weight: bold;
      }
      .footer {
        margin-top: 40px;
        font-size: 12px;
        color: #888;
        text-align: center;
        padding: 20px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>Welcome to Skill Medha LMS</h1>
      </div>
      <div class="content">
        <h2>Hello ${name},</h2>
        <p>
          Thank you for registering on the Skill Medha Learning Management System.
          To complete your registration, please verify your email address by
          clicking the button below:
        </p>
        <a href="${link}" class="verify-button" style="color:#fff">Verify Email</a>
        <p style="margin-top: 20px;">
          If the button doesn't work, you can also copy and paste the following
          link into your browser:
        </p>
        <p style="word-break: break-all;">${link}</p>
        <p>Thank you,<br />Skill Medha Team</p>
      </div>
      <div class="footer">
        © 2025 Skill Medha. All rights reserved.<br />
        Need help? Contact us at support@skillmedha.com
      </div>
    </div>
  </body>
</html>

  `;

  var mailOptions = {
    from: process.env.support_mail,
    to: email,
    subject: "Account Creation",
    html: html,
  };
  return transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      console.log({
        status: true,
        respMesg: error,
      });
    } else {
      console.log({
        status: true,
        respMesg: "Email Sent Successfully",
      });
    }
  });
}

app.get("/", authenticate, selectTenantDB, async (req, res) => {
  try {
    res.send(process.env.CRYPTOSECRET);
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.get("/getAllStudents", authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { limit = 10, cursor = null } = req.query;
    const parsedLimit = parseInt(limit, 10);

    const pipeline = [];

    if (cursor && cursor !== "null") {
      pipeline.push({
        $match: { _id: { $gt: new mongoDB.ObjectId(cursor) } },
      });
    }

    pipeline.push({ $sort: { _id: 1 } });
    pipeline.push({ $limit: parsedLimit + 1 });

    const students = await student.aggregate(pipeline).toArray();

    const hasNext = students.length > parsedLimit;

    if (hasNext) {
      students.pop();
    }

    const nextCursor = hasNext ? students[students.length - 1]._id : null;

    res.status(200).json({
      data: students,
      hasNext,
      nextCursor,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.get("/getStudentCreds", authenticate, selectTenantDB, async (req, res) => {
  const { job, student, assignedJob } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    if (!req.isAuth) {
      return res.status(401).json("User not Authorized");
    }

    const studentId = req.userID;

    const findStudent = await student.findOne({
      globalId: studentId,
    });

    if (!findStudent) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Get applied jobs array with all original fields
    const appliedJobObjects = Array.isArray(findStudent.appliedJobs)
      ? findStudent.appliedJobs
      : [];

    let enhancedAppliedJobs = [];

    if (appliedJobObjects.length > 0) {
      // Process each applied job to get full job details and ATS results
      for (const appliedJobObj of appliedJobObjects) {
        try {
          let jobDetails = null;
          let atsResult = null;

          // Check if it's an assigned job or local job
          if (appliedJobObj.isAssignedJob) {
            // Handle assigned jobs
            const assignedJobDoc = await assignedJob.findOne({
              jobId: appliedJobObj.id,
            });
            if (assignedJobDoc) {
              const companyTenantDB = await getTenantDB(
                assignedJobDoc.companyOrgId,
              );
              const { job: companyJobCollection, aiRespAts: companyAiRespAts } =
                connectTodb(companyTenantDB);

              jobDetails = await companyJobCollection.findOne({
                _id: new mongoDB.ObjectId(appliedJobObj.id),
              });

              if (jobDetails) {
                jobDetails = {
                  ...jobDetails,
                  type: "assigned",
                  companyOrgId: assignedJobDoc.companyOrgId,
                  isAssignedJob: true,
                };
              }

              // Get ATS result from company's database
              if (appliedJobObj.atsResponseId) {
                try {
                  atsResult = await companyAiRespAts.findOne({
                    _id: new mongoDB.ObjectId(appliedJobObj.atsResponseId),
                  });
                } catch (error) {
                  console.error(
                    `Error fetching ATS result from company DB:`,
                    error.message,
                  );
                }
              }
            }
          } else {
            // Handle local jobs
            const localJobIdStr = appliedJobObj.id ? appliedJobObj.id.toString() : "";
            if (
              localJobIdStr.length === 24 &&
              localJobIdStr.match(/^[0-9a-fA-F]{24}$/)
            ) {
              jobDetails = await job.findOne({
                _id: new mongoDB.ObjectId(localJobIdStr),
              });

              if (jobDetails) {
                jobDetails = {
                  ...jobDetails,
                  type: "local",
                  isAssignedJob: false,
                };
              }

              // Get ATS result from local database
              if (appliedJobObj.atsResponseId) {
                try {
                  const { aiRespAts: localAiRespAts } = connectTodb(
                    req.tenantDB,
                  );
                  atsResult = await localAiRespAts.findOne({
                    _id: new mongoDB.ObjectId(appliedJobObj.atsResponseId),
                  });
                } catch (error) {
                  console.error(
                    `Error fetching ATS result from local DB:`,
                    error.message,
                  );
                }
              }
            }
          }

          // Create enhanced applied job object
          const enhancedAppliedJob = {
            id: appliedJobObj.id,
            createdAt: appliedJobObj.createdAt,
            atsResponseId: appliedJobObj.atsResponseId,
            status: appliedJobObj.status,
            assessments: appliedJobObj.assessments || [],
            isAssignedJob: appliedJobObj.isAssignedJob || false,
            interviewDetails: appliedJobObj.interviewDetails || null,
            interviewScheduled: appliedJobObj.interviewScheduled || false,
            // Add any other fields from original appliedJob object
            ...appliedJobObj,
            // Replace/add the full job details
            jobDetails: jobDetails || null,
            // Add ATS results
            atsResult: atsResult ? atsResult.atsResult : null,
          };

          enhancedAppliedJobs.push(enhancedAppliedJob);
        } catch (error) {
          console.error(
            `Error fetching details for ${appliedJobObj.id}:`,
            error.message,
          );
          // Keep original object if fetching fails
          enhancedAppliedJobs.push({
            ...appliedJobObj,
            jobDetails: null,
            atsResult: null,
          });
        }
      }
    }

    const orgDetails = await organisation.findOne({
      _id: new mongoDB.ObjectId(req.orgId?.split("_")?.[1]),
    });

    // Return student data with enhanced appliedJobs
    const fs = require('fs');
    fs.writeFileSync('/tmp/appliedJobs.json', JSON.stringify(enhancedAppliedJobs, null, 2));
    res.status(200).json({
      data: {
        ...findStudent,
        appliedJobs: enhancedAppliedJobs,
        orgDetails,
      },
    });
  } catch (error) {
    console.error("Error in getStudentCreds:", error);
    res.status(500).json({ err: error.message });
  }
});

app.get(
  "/getSingleStudent/:studentId",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { student } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      const { studentId } = req.params;

      const findStudent = await student.findOne({
        globalId: studentId,
      });

      if (!findStudent) throw new Error("Please select valid student");

      res.status(200).json({ data: findStudent });
    } catch (error) {
      res.status(500).json({ err: error.message });
    }
  },
);

app.post(
  "/createStudentAccount",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { student, departments } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      const { email, password, userName, type } = req.body;

      const findStudent = await student.findOne({
        $or: [{ email: email }, { userName: userName }],
      });

      if (findStudent)
        throw new Error(
          "Student with this mail or phone or userName is already registered",
        );

      const enrollmentId = await generateEnrollmentId(
        new Date().getTime(),
        req.tenantDB,
      );
      const findGlobalStudent = await mainDBusers.findOne({
        $or: [{ email: email }, { userName: userName }],
      });

      const salt = await bcrypt.genSalt();

      const hash = await bcrypt.hash(password, salt);
      let globalData = findGlobalStudent || {};
      if (!findGlobalStudent) {
        globalData = await mainDBusers.insertOne({
          email: req.body.email,
          password: hash,
          orgId: req.orgId,
          type: req.body.type || "student",
          createdAt: new Date().getTime(),
          active: true,
        });
      } else {
        await mainDBusers.updateOne(
          { _id: findGlobalStudent._id },
          { $set: { orgId: req.orgId } },
        );
      }
      const payload = { ...req.body };
      delete payload.password;
      payload.globalId = findGlobalStudent
        ? findGlobalStudent._id.toString()
        : globalData.insertedId.toString();
      const createStudent = await student.insertOne({
        ...payload,
        enrollmentId,
        createdAt: new Date().toLocaleString(),
        active: true,
      });

      if (req.body.department) {
        await departments.updateOne(
          {
            _id: new mongoDB.ObjectId(req.body.department),
          },
          {
            $addToSet: {
              students: createStudent.insertedId.toString(),
            },
          },
        );
      }
      const loginData = {
        userID: createStudent.insertedId.toString(),
        email: email,
      };
      const token = CryptoJS.AES.encrypt(
        JSON.stringify(loginData),
        secretToken,
      ).toString();

      await sendVerificationEmail({
        email,
        name: userName,
        verificationToken: createStudent.insertedId.toString(),
        orgId: req.orgId,
      });
      res.status(200).send({
        msg: "Student Account Created Successfully",
        data: createStudent,

        token,
      });
    } catch (error) {
      var mailOptions = {
        from: process.env.support_mail,
        to: req.body.email,
        subject: "Account Creation",
        html: `<!DOCTYPE html>
<html lang="en" style="margin:0; padding:0;">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Account Creation Failed</title>
</head>
<body style="margin:0; padding:0; width:100%;">
  <!-- Outer table to reset default spacing in email clients -->
  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="margin:0; padding:0;"
  >
    <tr>
      <td align="center" valign="top">
        <!-- Centered inner table that will auto‐size to content -->
        <table
          width="600"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="margin:0; padding:0; height:auto;"
        >
          <tr>
            <td
              style="
                padding:1rem;
                box-sizing:border-box;
                font-family:'Montserrat',sans-serif;
                background-color:#f8d7da;
                height:auto;
              "
            >
              <!-- Logo -->
              <div
                class="logo"
                style="width:100%; text-align:center; margin-bottom:1rem;"
              >
                <img
                  src="https://res.cloudinary.com/dug3awue8/image/upload/v1744624355/Skill_Medha_Logo_en9o4t.png"
                  alt="Skill Medha Logo"
                  style="display:block; margin:0 auto; height:3rem;"
                />
              </div>

              <!-- Title -->
              <div
                class="title"
                style="
                  text-align:center;
                  font-weight:700;
                  font-size:1.5rem;
                  margin-bottom:1rem;
                  color:#721c24;
                "
              >
                Account Creation Failed
              </div>

              <!-- Body content -->
              <div
                class="content"
                style="font-size:1rem; line-height:1.5; color:#333333;"
              >
                <p style="margin:0 0 1rem;">
                  Hello,
                </p>
                <p style="margin:0 0 1rem;">
                  We’re sorry, but we were unable to create your Skill Medha account at this time.
                </p>
                <p style="margin:0 0 1rem;">
                  This might be due to:
                </p>
                <ul style="margin:0 0 1rem; padding-left:1.25rem;">
                  <li>Network or server issues</li>
                  <li>Invalid or incomplete information</li>
                  <li>An unexpected error on our end</li>
                </ul>
                <p style="margin:0 0 1rem;">
                  Please try again by <a href="https://skillmedha.com/signup" style="color:#0066cc; text-decoration:none;">clicking here</a>. If the problem persists, contact our support team at <a href="mailto:support@skillmedha.com" style="color:#0066cc; text-decoration:none;">support@skillmedha.com</a>.
                </p>
                <p style="margin:0;">
                  Thank you for your patience,<br />
                  The Skill Medha Team
                </p>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>

                `,
      };

      transporter.sendMail(mailOptions, function (error, info) {
        if (error) {
          console.log({
            status: true,
            respMesg: error,
          });
        } else {
          console.log({
            status: true,
            respMesg: "Email Sent Successfully",
          });
        }
      });
      console.log(error);

      res.status(500).send({ err: error.message });
    }
  },
);

// enrollementId
app.post("/registerStudent", async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { email, password, userName, type } = req.body;

    const findStudent = await student.findOne({
      $or: [{ email: email }, { userName: userName }],
    });

    if (findStudent)
      throw new Error(
        "Student with this mail or phone or userName is already registered",
      );

    const enrollmentId = await generateEnrollmentId(
      new Date().getTime(),
      req.tenantDB,
    );
    const findGlobalStudent = await mainDBusers.findOne({
      $or: [{ email: email }, { userName: userName }],
    });

    const salt = await bcrypt.genSalt();

    const hash = await bcrypt.hash(password, salt);
    let globalData = findGlobalStudent || {};
    if (!findGlobalStudent) {
      globalData = await mainDBusers.insertOne({
        email: req.body.email,
        password: hash,
        orgId: req.orgId,
        type: req.body.type || "student",
        createdAt: new Date().getTime(),
        active: true,
      });
    } else {
      await mainDBusers.updateOne(
        { _id: findGlobalStudent._id },
        { $set: { orgId: req.orgId } },
      );
    }
    const payload = { ...req.body };
    delete payload.password;
    payload.globalId = findGlobalStudent
      ? findGlobalStudent._id.toString()
      : globalData.insertedId.toString();
    const createStudent = await student.insertOne({
      ...payload,
      enrollmentId,
      createdAt: new Date().toLocaleString(),
      active: true,
    });

    const loginData = {
      userID: createStudent.insertedId.toString(),
      email: email,
    };
    const tokenData = {
      userID: createStudent.insertedId.toString(),
      email: email,
      userName: req.body.userName || "",
      role: "student",
      orgId: req.orgId,
    };

    const token = jwt.sign(tokenData, process.env.JWT_SECRET);
    await sendVerificationEmail({
      email,
      name: userName,
      verificationToken: createStudent.insertedId.toString(),
      orgId: req.orgId,
    });

    res.status(200).json({ msg: "Verification mail sent successfully" });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.get("/verify", async (req, res) => {
  const { orgId } = req.query;

  const db = await getTenantDB(orgId);

  const { student } = connectTodb(db);
  // console.log(student);
  if (!student)
    return res.status(500).json({ error: "No tenant DB available" });
  const { token } = req.query;
  if (!token) {
    return res.status(400).send("No token provided.");
  }

  const result = await student.findOneAndUpdate(
    {
      $or: [{ _id: new mongoDB.ObjectId(token) }, { globalId: token }],
    },
    {
      $set: { verified: true },
    },
  );

  if (!result?._id) {
    return res.status(400).send("Invalid or expired token.");
  }

  // send a little HTML page that shows confirmation,
  // waits 3 seconds, then redirects
  const destination = process.env.STUDENT_PORTAL_URL;
  res.send(`
    <!DOCTYPE html><html><head>
      <title>Email Verified</title>
      <meta http-equiv="refresh" content="3;url=${destination}">
      <script>setTimeout(()=>window.location='${destination}',3000)</script>
    </head><body>
      <h1>✅ Email Verified!</h1>
      <p>Redirecting you to <a href="${destination}">${destination}</a>…</p>
    </body></html>
  `);
});

app.post(
  "/resendVerifyEmail",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { student } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      if (!req.isAuth) throw new Error("User not authorized");
      const studentId = req.userID;
      const findStudent = await student.findOne({
        globalId: studentId,
      });
      if (!findStudent?._id) throw new Error("Student not found to update");
      if (findStudent.verified) {
        return res.status(400).json({ error: "Email already verified" });
      }
      const token = CryptoJS.AES.encrypt(
        JSON.stringify({
          userID: findStudent._id.toString(),
          name: findStudent.userName,
          email: findStudent.email,
          orgId: req.orgId,
        }),
        secretToken,
      ).toString();
      await sendVerificationEmail({
        email: findStudent.email,
        name: findStudent.userName,
        verificationToken: req.userID,
        orgId: req.orgId,
      });
      res.status(200).json({ msg: "Verification email sent successfully" });
    } catch (error) {
      res.status(500).json({ err: error.message });
    }
  },
);

app.post("/loginStudent", authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { email, password } = req.body;

    const findStudent = await student.findOne({ email: email });

    if (!findStudent?._id) throw new Error("Student not registered");

    const storedPassword = findStudent.password;

    const compare = await bcrypt.compare(password, storedPassword);
    if (!compare) throw new Error("password incorrect");

    const loginData = {
      userID: findStudent._id,
      email: findStudent.email,
    };

    const token = CryptoJS.AES.encrypt(
      JSON.stringify(loginData),
      secretToken,
    ).toString();

    const updatedLoginCount = (findStudent.loginCount || 1) + 1;

    await student.updateOne(
      { _id: findStudent._id },
      { $set: { token: token, loginCount: updatedLoginCount } },
    );

    res
      .status(200)
      .send({ msg: "loggedin successfully", ...loginData, token: token, loginCount: updatedLoginCount });
  } catch (error) {
    res.status(500).send({ err: error.message });
  }
});

app.post("/updateStudent", authenticate, selectTenantDB, async (req, res) => {
  const { student } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    if (!req.isAuth) throw new Error("User not authorized");
    const studentId = req.userID;

    const covId = new mongoDB.ObjectId(studentId);

    const findStudent = await student.findOne({ globalId: studentId });

    if (!findStudent?._id) throw new Error("Student not found to update");

    let update = req.body;
    const { email, globalId } = req.body;
    if (email) {
      const checkEmail = await mainDBusers.findOne({ email });
      if (checkEmail) throw new Error("Email already Registered");
      update.verified = false;
      await mainDBusers.findOneAndUpdate(
        { _id: new mongoDB.ObjectId(globalId) },
        {
          $set: {
            email,
          },
        },
      );
    }

    const updatedStudent = await student.updateOne(
      { _id: findStudent?._id },
      { $set: update },
    );
    sendVerificationEmail({
      email,
      name: findStudent?.userName,
      verificationToken: findStudent._id.toString(),
      orgId: req.orgId,
    });
    res
      .status(200)
      .send({ msg: "Student updated successfully", ...updatedStudent });
  } catch (error) {
    res.status(500).send({ err: error.message });
  }
});

app.post(
  "/updateStudentWithId/:studentId",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { student } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      const { studentId } = req.params;

      const covId = new mongoDB.ObjectId(studentId);

      const findStudent = await student.findOne({ globalId: studentId });

      if (!findStudent?._id) throw new Error("Student not found to update");

      let update = req.body;
      const { email, globalId } = req.body;
      if (email) {
        const checkEmail = await mainDBusers.findOne({ email });
        if (checkEmail) throw new Error("Email already Registered");
        update.verified = false;
        await mainDBusers.findOneAndUpdate(
          { _id: new mongoDB.ObjectId(globalId) },
          {
            $set: {
              email,
            },
          },
        );
      }

      const updatedStudent = await student.updateOne(
        { _id: findStudent?._id },
        { $set: update },
      );
      sendVerificationEmail({
        email,
        name: findStudent?.userName,
        verificationToken: findStudent._id.toString(),
        orgId: req.orgId,
      });

      res
        .status(200)
        .send({ msg: "Student updated successfully", ...updatedStudent });
    } catch (error) {
      res.status(500).send({ err: error.message });
    }
  },
);

// app.post(
//   "/deleteStudent/:userID",
//   authenticate,
//   selectTenantDB,
//   async (req, res) => {
//     const { student, departments } = connectTodb(req.tenantDB);
//     if (!req.tenantDB)
//       return res.status(500).json({ error: "No tenant DB available" });
//     try {
//       const { userID } = req.params;
//       const { departmentId } = req.body;
//       const covId = new mongoDB.ObjectId(userID);

//       const findStudent = await student.findOne({ globalId: userID });

//       if (!findStudent?._id) throw new Error("Student not found to delete");

//       const archiveResult = await archiveAndDeleteOne(student, { _id: findStudent?._id }, {
//         deletedBy: req.userID || null,
//         reason: req.body.reason || null,
//       });

//       if (archiveResult.deletedCount === 0) {
//         throw new Error('Failed to delete student after archival');
//       }

//       await archiveAndDeleteOne(mainDBusers, { _id: new mongoDB.ObjectId(userID) }, {
//         deletedBy: req.userID || null,
//         reason: req.body.reason || null,
//       });

//       await departments.updateOne(
//         { _id: new mongoDB.ObjectId(departmentId) },
//         {
//           $pull: { students: findStudent._id.toString() },
//         },
//       );
//       const { mainDBusers } = getGlobalCollections();
//       await mainDBusers.updateOne(
//         { _id: deletedStudent.mainUserId },
//         { $set: { active: false } }
//       );
//       res
//         .status(200)
//         .send({ msg: "Student deleted successfully", data: archiveResult.deletedDocument });
//     } catch (error) {
//       res.status(500).send({ err: error.message });
//     }
//   },
// );
app.post(
  "/deleteStudent/:userID",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    if (!req.tenantDB) return res.status(500).json({ error: "No tenant DB available" });
    const { student, departments } = connectTodb(req.tenantDB);
    const { mainDBusers } = getGlobalCollections();
    console.log('here getiing')
    try {
      const { userID } = req.params;
      const { departmentId } = req.body;

      // Find student in tenant DB
      const findStudent = await student.findOne({ globalId: userID });
      if (!findStudent) return res.status(404).json({ success: false, message: "Student not found" });

      // Use email as common key across collections
      const studentEmail = findStudent.email;

      // Archive + delete from tenant students collection
      const archiveResult = await archiveAndDeleteOne(student, { _id: findStudent._id }, {
        deletedBy: req.userID || null,
        reason: req.body.reason || null,
      });

      if (archiveResult.deletedCount === 0) {
        throw new Error('Failed to delete student after archival');
      }

      // Remove student from department using email
      await departments.updateOne(
        { _id: new mongoDB.ObjectId(departmentId) },
        { $pull: { students: studentEmail } }
      );

      // Set active: false in main users DB using email
      await mainDBusers.updateOne(
        { email: studentEmail },
        { $set: { active: false } }
      );

      res.status(200).json({ success: true, message: "Student deleted successfully", data: archiveResult.deletedDocument });
    } catch (error) {
      res.status(500).json({ err: error.message });
    }
  }
);
app.post(
  "/deleteAllStudent/:deptId",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { student, departments } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      const { deptId } = req.params;
      const covId = new mongoDB.ObjectId(deptId);

      const depatData = await departments.findOne({
        _id: covId,
      });
      if (!depatData) throw new Error("Department not found");
      const studentIds = depatData.students.map((e) => new mongoDB.ObjectId(e));
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
      await archiveAndDeleteMany(student, { _id: { $in: studentIds } }, {
        deletedBy: req.userID || null,
        reason: req.body.reason || null,
      });

      const studentGIds = studentsData?.map(
        (e) => new mongoDB.ObjectId(e.globalId),
      );
      await archiveAndDeleteMany(mainDBusers, { _id: { $in: studentGIds } }, {
        deletedBy: req.userID || null,
        reason: req.body.reason || null,
      });

      await departments.updateOne(
        { _id: new mongoDB.ObjectId(deptId) },
        {
          $set: { students: [] },
        },
      );

      res.status(200).send({
        msg: "Student deleted successfully",
        ...studentsData?.map((e) => e.userName),
      });
    } catch (error) {
      res.status(500).send({ err: error.message });
    }
  },
);

app.post(
  "/changeStudentEmail",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { student } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      if (!req.isAuth) throw new Error("User not authorized");

      const { studentId } = req.params;

      const { email } = req.body;

      const findStudent = await student.findOne({
        _id: new mongoDB.ObjectId(studentId),
      });

      if (!findStudent?._id) throw new Error("Student not found to update");

      const findSTudentFromMainDB = await mainDBusers.findOne({ email: email });

      if (findSTudentFromMainDB)
        throw new Error(
          "Student with this e-mail already registered please try different mail",
        );

      const updatedStudent = await student.updateOne(
        { _id: findStudent?._id },
        { $set: { email: email } },
      );

      await mainDBusers.updateOne(
        {
          _id: new mongoDB.ObjectId(findStudent.globalId),
        },
        {
          $set: { email: email },
        },
      );

      await sendVerificationEmail({
        email,
        name: findStudent.userName,
        verificationToken: findStudent._id.toString(),
        orgId: findStudent.orgId,
      });
      res
        .status(200)
        .send({ msg: "Student mail updated successfully", ...updatedStudent });
    } catch (error) {
      res.status(500).send({ err: error.message });
    }
  },
);

app.post(
  "/deleteAllStudentsFromOrg",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { student, departments } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      const AllStudents = await student.find({}).toArray();

      const studentIds = AllStudents?.map((e) => {
        return e._id;
      });
      const studentGIds = AllStudents?.map((e) => {
        return new mongoDB.ObjectId(e.globalId);
      });

      const departmentIds = AllStudents?.map((e) => {
        return e.globalId;
      });
      const updateDeparment = studentIds.map((e) =>
        departments.findOneAndUpdate(
          { students: e.toString() },
          {
            $pull: { students: e.toString() },
          },
        ),
      );
      const updatedDept = await Promise.all(updateDeparment);
      const deleteFromMDB = await mainDBusers.deleteMany({
        _id: {
          $in: studentGIds,
        },
      });
      const deleteFromSDB = await student.deleteMany({
        _id: {
          $in: studentIds,
        },
      });

      res.send({ msg: "Students deleted" });
    } catch (error) {
      console.log(error);
      res.send(error.message);
    }
  },
);

app.get("/batches", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  const { student } = connectTodb(req.tenantDB);

  // Example: filter by department and/or verified
  const filter = {};
  if (req.query.department) {
    filter.department = req.query.department;
  }
  // Add other filters as desired
  // e.g., year: if (req.query.year) { filter.yearOfPassing = req.query.year }

  try {
    const batches = await student
      .aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$yearOfPassing",
            studentIds: { $addToSet: { $toString: "$_id" } },
          },
        },
        {
          $project: {
            _id: 0,
            yearOfPassing: "$_id",
            studentIds: 1,
            department: 1,
          },
        },
        { $sort: { yearOfPassing: 1 } },
      ])
      .toArray();
    res.json(batches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/studentsByIDs", authenticate, selectTenantDB, async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  const { student } = connectTodb(req.tenantDB);

  // You can send the array as { studentIds: ["id1", "id2", ...] } in POST body
  const { studentIds } = req.body;

  if (!studentIds || !Array.isArray(studentIds)) {
    return res
      .status(400)
      .json({ error: "studentIds (array) required in body" });
  }

  try {
    // Convert string IDs to ObjectId
    const ids = studentIds.map((id) => new mongoDB.ObjectId(id));

    // Fetch the matching students
    const students = await student.find({ _id: { $in: ids } }).toArray();

    res.json(students);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(
  "/getAllStudentsAgg",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      if (!req.tenantDB)
        return res.status(500).json({ error: "No tenant DB available" });
      const { student } = connectTodb(req.tenantDB);
      const pipeline = [];
      let filter = {};
      if (req.query?.deparment) {
        filter = {
          department: req.query?.deparment,
        };
      }
      if (req.query?.batch) {
        filter = {
          ...filter,
          yearOfPassing: req.query?.batch,
        };
      }
      pipeline.push({ $match: filter });
      pipeline.push({
        $project: {
          _id: 1,
          firstName: 1,
          lastName: 1,
          userName: 1,
          email: 1,
        },
      });
      const allStudents = await student.aggregate(pipeline).toArray();
      res.status(200).json(allStudents);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

app.get("/partnerColleges", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "name",
      sortOrder = "desc",
    } = req.query;

    // Validate and parse pagination parameters
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    // Validate page number
    if (pageNum < 1) {
      return res.status(400).json({
        error: "Page must be greater than 0",
      });
    }

    // Enforce minimum limit of 10
    if (limitNum < 10) {
      return res.status(400).json({
        error: "Limit must be at least 10",
      });
    }

    // Optional: Set maximum limit to prevent abuse
    if (limitNum > 100) {
      return res.status(400).json({
        error: "Limit cannot exceed 100",
      });
    }

    // Calculate skip value for pagination
    const skip = (pageNum - 1) * limitNum;

    // Build sort object
    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    // Execute queries in parallel for better performance
    const [partnerColleges, totalCount] = await Promise.all([
      organisation
        .find({ type: "college" })
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      organisation.countDocuments({ type: "college" }),
    ]);

    // Calculate pagination metadata
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
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/getAllStudentsFromAllClgs", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10, // Reduced default for better performance
      sortBy = "firstName", // Changed to match your data structure
      sortOrder = "asc",
      search = "",
      department = "",
      yearOfPassing = "",
      status = "",
      collegeId = "",
      hasInternship = false,
      hasResume = false,
      degree = "",
      grade = 0,
      skill = "",
    } = req.query;

    // Validate pagination parameters
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    if (pageNum < 1) {
      return res.status(400).json({
        error: "Page must be greater than 0",
      });
    }

    if (limitNum < 1 || limitNum > 50) {
      // Reduced max limit
      return res.status(400).json({
        error: "Limit must be between 1 and 50",
      });
    }

    // Helper function with error handling
    function parseIfJSON(value) {
      if (!value) return [];
      try {
        return typeof value === "string" ? JSON.parse(value) : value;
      } catch (error) {
        console.warn(`Invalid JSON format for parameter: ${value}`);
        return [];
      }
    }

    // Validate grade parameter
    const gradeValue = grade ? parseFloat(grade) : 0;
    if (grade && (isNaN(gradeValue) || gradeValue < 0 || gradeValue > 10)) {
      return res.status(400).json({
        error: "Grade must be a valid number between 0 and 10",
      });
    }

    let clgFilter = { type: "college" };
    if (collegeId) {
      clgFilter._id = new mongoDB.ObjectId(collegeId);
    }

    // Get all partner colleges
    const partnerColleges = await organisation.find(clgFilter).toArray();

    if (partnerColleges.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: {
          currentPage: pageNum,
          totalPages: 0,
          totalCount: 0,
          limit: limitNum,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });
    }

    const orgIds = partnerColleges.map((e) => e.orgId);

    // Get all tenant databases in parallel
    const partnerDbs = await Promise.all(
      orgIds.map(async (orgId) => {
        try {
          return await getTenantDB(orgId);
        } catch (error) {
          console.error(`Error getting database for orgId ${orgId}:`, error);
          return null;
        }
      }),
    );

    const validDbs = partnerDbs.filter((db) => db !== null);
    const studentCollections = validDbs.map((db) => connectTodb(db).student);

    // Build query object
    const buildQuery = () => {
      const query = {};
      const exprConditions = [];

      // Basic filters
      if (search) {
        query.$or = [
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { userName: { $regex: search, $options: "i" } },
        ];
      }

      if (department) {
        query.department = department;
      }

      if (yearOfPassing) {
        query.yearOfPassing = yearOfPassing.toString();
      }

      if (status) {
        query.status = status;
      }

      // Complex filters using $expr
      if (hasInternship === "true" || hasInternship === true) {
        exprConditions.push({
          $and: [
            { $ne: ["$experiences", null] },
            { $isArray: "$experiences" },
            { $gt: [{ $size: "$experiences" }, 0] },
            // Check for valid experiences with meaningful duration
            {
              $anyElementTrue: {
                $map: {
                  input: "$experiences",
                  as: "exp",
                  in: {
                    $and: [
                      { $ne: ["$$exp.company", null] },
                      { $ne: ["$$exp.company", ""] },
                      { $ne: ["$$exp.role", null] },
                      { $ne: ["$$exp.role", ""] },
                      { $ne: ["$$exp.startDate", null] },
                      { $ne: ["$$exp.startDate", ""] },
                      { $ne: ["$$exp.endDate", null] },
                      { $ne: ["$$exp.endDate", ""] },
                      // Optional: Add minimum duration check (e.g., at least 1 month)
                      // You could add date comparison logic here if needed
                    ],
                  },
                },
              },
            },
          ],
        });
      }

      if (hasResume === "true" || hasResume === true) {
        // exprConditions.push({
        //   // $or: [{ $ne: ["$resumeDoc", null] }],
        //   resumeDoc: { $exists: 1 },
        // });
        query.resumeDoc = { $exists: 1 };
      }

      // Degree and grade filters
      if (degree) {
        const selectedDegreeTypes = parseIfJSON(degree);
        if (selectedDegreeTypes.length > 0) {
          const degreeConditions = [
            { $ne: ["$educationDetails", null] },
            { $isArray: "$educationDetails" },
            { $gt: [{ $size: "$educationDetails" }, 0] },
          ];

          const degreeMatchConditions = [
            { $in: ["$$degree.type", selectedDegreeTypes] },
          ];

          if (grade && gradeValue > 0) {
            degreeMatchConditions.push({
              $gte: [
                {
                  $cond: {
                    if: { $eq: ["$$degree.gradingSystem", "cgpa"] },
                    then: {
                      $cond: {
                        if: { $type: "$$degree.grade" },
                        then: { $toDouble: "$$degree.grade" },
                        else: 0,
                      },
                    },
                    else: {
                      $cond: {
                        if: { $type: "$$degree.grade" },
                        then: {
                          $divide: [{ $toDouble: "$$degree.grade" }, 10],
                        },
                        else: 0,
                      },
                    },
                  },
                },
                gradeValue,
              ],
            });
          }

          const degreeMatch = {
            $anyElementTrue: {
              $map: {
                input: "$educationDetails",
                as: "degree",
                in: { $and: degreeMatchConditions },
              },
            },
          };

          exprConditions.push({ $and: [...degreeConditions, degreeMatch] });
        }
      }

      // Skills filter
      if (skill) {
        const selectedSkills = parseIfJSON(skill);
        if (selectedSkills.length > 0) {
          exprConditions.push({
            $and: [
              { $ne: ["$technical", null] },
              { $isArray: "$technical" },
              {
                $gt: [
                  {
                    $size: {
                      $setIntersection: [
                        {
                          $map: {
                            input: selectedSkills,
                            as: "skill",
                            in: { $toLower: "$$skill" },
                          },
                        },
                        {
                          $map: {
                            input: "$technical",
                            as: "skill",
                            in: { $toLower: "$$skill" },
                          },
                        },
                      ],
                    },
                  },
                  0,
                ],
              },
            ],
          });
        }
      }

      if (exprConditions.length > 0) {
        query.$expr =
          exprConditions.length === 1
            ? exprConditions[0]
            : { $and: exprConditions };
      }

      return query;
    };

    const query = buildQuery();
    const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    // 🔧 FIXED: Proper pagination approach
    // First, get ALL matching students from all colleges (without pagination)
    // Then apply pagination at the application level for accurate results

    const collegeQueries = studentCollections.map(
      async (studentColl, index) => {
        try {
          const orgId = orgIds[index];
          const college = partnerColleges.find((c) => c.orgId === orgId);

          // Get ALL matching students (no pagination at DB level)
          const [students, count] = await Promise.all([
            studentColl.find(query).sort(sort).toArray(),
            studentColl.countDocuments(query),
          ]);

          const studentsWithCollege = students.map((student) => ({
            ...student,
            college: {
              orgId: college.orgId,
              name: college.orgName || college.orgId,
              type: college.type,
            },
          }));

          return {
            students: studentsWithCollege,
            count: count,
          };
        } catch (error) {
          console.error(
            `Error querying students for collection ${index}:`,
            error,
          );
          return { students: [], count: 0 };
        }
      },
    );

    const collegeResults = await Promise.all(collegeQueries);

    // Combine all results
    let allStudents = collegeResults.flatMap((result) => result.students);
    const totalCount = collegeResults.reduce(
      (sum, result) => sum + result.count,
      0,
    );

    // Apply final sorting on combined results
    allStudents.sort((a, b) => {
      const aValue = a[sortBy];
      const bValue = b[sortBy];

      if (aValue === undefined && bValue === undefined) return 0;
      if (aValue === undefined) return 1;
      if (bValue === undefined) return -1;

      if (typeof aValue === "string" && typeof bValue === "string") {
        const comparison = aValue.localeCompare(bValue);
        return sortOrder === "asc" ? comparison : -comparison;
      }

      if (aValue < bValue) return sortOrder === "asc" ? -1 : 1;
      if (aValue > bValue) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    // 🔧 FIXED: Apply pagination ONLY at application level
    const skip = (pageNum - 1) * limitNum;
    const paginatedStudents = allStudents.slice(skip, skip + limitNum);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    // College breakdown
    const collegeBreakdown = {};
    allStudents.forEach((student) => {
      const orgId = student.college.orgId;
      if (!collegeBreakdown[orgId]) {
        collegeBreakdown[orgId] = {
          name: student.college.name,
          count: 0,
        };
      }
      collegeBreakdown[orgId].count++;
    });

    res.status(200).json({
      success: true,
      data: paginatedStudents,
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
      collegeBreakdown,
      appliedFilters: {
        search,
        department,
        yearOfPassing,
        status,
        sortBy,
        sortOrder,
        degree,
        grade,
        skill,
        hasInternship,
        hasResume,
        collegeId,
      },
    });
  } catch (error) {
    console.error("Error fetching students from all colleges:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

app.get("/getStudentByGlobalIdAndOrgId", async (req, res) => {
  try {
    const { globalId, sourceOrgId, includeJobs = false } = req.query;

    // Validate required parameters
    if (!globalId || !sourceOrgId) {
      return res.status(400).json({
        success: false,
        error: "Both globalId and sourceOrgId are required",
      });
    }

    // Get the tenant database for the source organization
    const tenantDB = await getTenantDB(sourceOrgId);

    if (!tenantDB) {
      return res.status(404).json({
        success: false,
        error: "Organization not found or database not available",
      });
    }

    // Connect to the tenant database
    const { student, job, assignedJob } = connectTodb(tenantDB);

    // Find the student by globalId
    const findStudent = await student.findOne({
      globalId: globalId,
    });

    if (!findStudent) {
      return res.status(404).json({
        success: false,
        error: "Student not found",
      });
    }

    let allJobProfiles = [];

    // Include jobs information if requested - FIXED: Use === for comparison
    if (includeJobs === "true" || includeJobs === true) {
      const appliedJobObjects = Array.isArray(findStudent.appliedJobs)
        ? findStudent.appliedJobs
        : [];

      if (appliedJobObjects.length > 0) {
        // Handle local applied jobs
        const appliedJobIds = appliedJobObjects.map((jobObj) => jobObj.id);

        const objectIds = appliedJobIds
          .filter(
            (id) => typeof id === "string" && id.match(/^[0-9a-fA-F]{24}$/),
          )
          .map((id) => new mongoDB.ObjectId(id));

        if (objectIds.length > 0) {
          const localJobPipeline = [
            {
              $match: {
                _id: { $in: objectIds },
              },
            },
            {
              $project: {
                _id: 1,
                interviewStatusByApplicant: 1,
                profileName: 1,
                companyName: 1,
                jobDescription: 1,
                requirements: 1,
                location: 1,
                salary: 1,
                jobType: 1,
                experience: 1,
                skills: 1,
                postedDate: 1,
                applicationDeadline: 1,
                // Add any other job fields you need
                type: { $literal: "local" },
              },
            },
          ];

          const localJobs = await job.aggregate(localJobPipeline).toArray();

          // Map local jobs with application status from appliedJobs array
          const localJobsWithStatus = localJobs.map((localJob) => {
            const appliedJobObj = appliedJobObjects.find(
              (obj) => obj.id === localJob._id.toString(),
            );
            return {
              ...localJob,
              applicationStatus: appliedJobObj?.status || "applied",
              appliedDate: appliedJobObj?.appliedDate || null,
              isAssignedJob: false,
            };
          });

          allJobProfiles = [...allJobProfiles, ...localJobsWithStatus];
        }

        // Handle assigned jobs
        const assignedJobsFromApplied = appliedJobObjects.filter(
          (jobObj) => jobObj.isAssignedJob,
        );

        if (assignedJobsFromApplied.length > 0) {
          const assignedJobPromises = assignedJobsFromApplied.map(
            async (jobObj) => {
              try {
                const assignedJobDoc = await assignedJob.findOne({
                  jobId: jobObj.id,
                });

                if (assignedJobDoc) {
                  const companyTenantDB = await getTenantDB(
                    assignedJobDoc.companyOrgId,
                  );
                  const { job: companyJobCollection } =
                    connectTodb(companyTenantDB);

                  const companyJob = await companyJobCollection.findOne({
                    _id: new mongoDB.ObjectId(jobObj.id),
                  });

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
                console.error(
                  `Error fetching assigned job ${jobObj.id}:`,
                  error.message,
                );
              }
              return null;
            },
          );

          const assignedJobs = await Promise.all(assignedJobPromises);
          const validAssignedJobs = assignedJobs.filter((job) => job !== null);
          allJobProfiles = [...allJobProfiles, ...validAssignedJobs];
        }
      }
    }

    // Get organization details
    const organizationDetails = await organisation.findOne({
      orgId: sourceOrgId,
    });

    // Prepare response - FIXED: Return full job objects in appliedJobs
    const response = {
      success: true,
      data: {
        student: {
          ...findStudent,
          // Replace the appliedJobs array with full job objects when includeJobs is true
          appliedJobs:
            includeJobs === "true" || includeJobs === true
              ? allJobProfiles
              : findStudent.appliedJobs, // Keep original if not including jobs
        },
        organization: organizationDetails
          ? {
            orgId: organizationDetails.orgId,
            orgName: organizationDetails.orgName,
            type: organizationDetails.type,
          }
          : null,
      },
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching student by globalId and sourceOrgId:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Something went wrong",
    });
  }
});

app.get(
  "/getStudentProgress",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    const { job, student, progress } = connectTodb(req.tenantDB);
    if (!req.tenantDB)
      return res.status(500).json({ error: "No tenant DB available" });
    try {
      if (!req.isAuth) {
        return res.status(401).json("User not Authorized");
      }

      const studentId = req.userID;
      const findStudent = await student.findOne({
        globalId: studentId,
      });
      if (!findStudent) throw new Error("Student not found");
      const { progress: progressIds } = findStudent;
      const progressPromise = progressIds?.map((e) =>
        progress.findOne({ _id: mongoDB.ObjectId(e) }),
      );
      const progressData = await Promise.all(progressPromise);
      res.status(200).json(progressData);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Internal server error",
        message:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Something went wrong",
      });
    }
  },
);

app.post("/saveStudentNotes", authenticate, async (req, res) => {
  try {
    if (!req.isAuth) throw new Error("User not authorized");

    const kSquareDB = await getTenantDB("KSquare");
    const { studentNotes } = connectTodb(kSquareDB);

    const userid = req.userID;
    const {
      courseid,
      topicid,
      topicTitle,
      sectionid,
      sectionTitle,
      videoTimestamp,
      notesdescription,
    } = req.body;

    if (!courseid || !topicid || !notesdescription) {
      return res.status(400).json({
        error: "courseid, topicid and notesdescription are required",
      });
    }

    const now = new Date();
    const newNote = {
      userid,
      courseid,
      topicid,
      topicTitle: topicTitle || "",
      sectionid: sectionid || "",
      sectionTitle: sectionTitle || "",
      videoTimestamp: videoTimestamp || "0:00",
      notesdescription,
      createdAt: now,
      updatedAt: now,
    };

    const result = await studentNotes.insertOne(newNote);

    res.status(201).json({
      success: true,
      msg: "Student note saved successfully",
      data: { ...newNote, _id: result.insertedId },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.get("/getStudentNotes", authenticate, async (req, res) => {
  try {
    if (!req.isAuth) throw new Error("User not authorized");

    const kSquareDB = await getTenantDB("KSquare");
    const { studentNotes } = connectTodb(kSquareDB);

    const userid = req.userID;
    const { courseid, topicid } = req.query;

    if (!courseid) {
      return res.status(400).json({ error: "courseid is required" });
    }

    const filter = { userid, courseid };
    if (topicid) filter.topicid = topicid;

    const notes = await studentNotes
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      data: notes,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.put("/updateStudentNote/:noteId", authenticate, async (req, res) => {
  const { ObjectId } = require("mongodb");

  try {
    if (!req.isAuth) throw new Error("User not authorized");

    const kSquareDB = await getTenantDB("KSquare");
    const { studentNotes } = connectTodb(kSquareDB);

    const userid = req.userID;
    const { noteId } = req.params;
    const { notesdescription } = req.body;

    if (!notesdescription) {
      return res.status(400).json({ error: "notesdescription is required" });
    }

    const result = await studentNotes.findOneAndUpdate(
      { _id: new ObjectId(noteId), userid },
      { $set: { notesdescription, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    if (!result) {
      return res.status(404).json({ error: "Note not found" });
    }

    res.status(200).json({
      success: true,
      msg: "Note updated successfully",
      data: result,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.delete("/deleteStudentNote/:noteId", authenticate, async (req, res) => {
  const { ObjectId } = require("mongodb");

  try {
    if (!req.isAuth) throw new Error("User not authorized");

    const kSquareDB = await getTenantDB("KSquare");
    const { studentNotes } = connectTodb(kSquareDB);

    const userid = req.userID;
    const { noteId } = req.params;

    const result = await studentNotes.deleteOne({
      _id: new ObjectId(noteId),
      userid,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Note not found" });
    }

    res.status(200).json({
      success: true,
      msg: "Note deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});


module.exports = app;
