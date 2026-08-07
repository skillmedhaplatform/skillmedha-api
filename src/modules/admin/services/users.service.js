require("dotenv").config();
const express = require("express");
const { json, urlencoded } = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const {
  mainDBusers,
  organisation,
  aiUsageCollection,
} = require("../../../shared/db/connection").getGlobalCollections();
const { getTenantDB } = require("../../../shared/db/connection");
const { archiveAndDeleteOne, archiveTenantDatabase } = require("../../../shared/utils/archive.service");
const logger = require("../../../shared/utils/logger");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { ObjectId } = require("mongodb");
const mongoDB = require("mongodb");
const nodemailer = require("nodemailer");
const { connectTodb } = require("../../../shared/db/connection");
const {
  getJobsByOrgPaginated,
  getUsersByOrgPaginated,
} = require("./company.service");

const app = express.Router();




const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.support_mail,
    pass: process.env.support_pass,
  },
});

function sanitizeName(name) {
  // Remove all non-alphabet characters and convert to lowercase
  let cleaned = name.replace(/[^a-zA-Z]/g, "").toLowerCase();

  // Limit to max 5 characters
  cleaned = cleaned.slice(0, 5);

  // Pad with '0' if less than 5 characters
  cleaned = cleaned.padEnd(5, "0");

  return cleaned;
}

// app.post("/login", async (req, res) => {
//   try {
//     const { email, password, type } = req.body;
//     const findUser = await mainDBusers.findOne({
//       $and: [{ email: email.toLowerCase() }, { type }],
//     });

//     if (!findUser?._id) throw new Error("User not registered");
//     if (!findUser?.active)
//       throw new Error("Account Deactivated Please contact site adminstrator");
//     const storedPassword = findUser.password;

//     const compare = await bcrypt.compare(password, storedPassword);
//     if (!compare) throw new Error("password incorrect");

//     const loginData = {
//       userID: findUser._id,
//       email: findUser.email,
//       userName: findUser.userName,
//       role: findUser.role || "",
//       orgId: findUser.orgId,
//     };

//     const token = jwt.sign(loginData, process.env.JWT_SECRET);

//     await mainDBusers.updateOne(
//       { _id: findUser._id },
//       { $set: { token: token } }
//     );

//     res
//       .status(200)
//       .send({ msg: "loggedin successfully", ...loginData, token: token });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// });
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const findUser = await mainDBusers.findOne({ email: email.toLowerCase() });

    if (!findUser?._id) throw new Error("User not registered");
    if (!findUser?.active)
      throw new Error("Account Deactivated Please contact site administrator");

    const compare = await bcrypt.compare(password, findUser.password);
    if (!compare) throw new Error("password incorrect");

    // ===== TENANT RECORD VERIFICATION =====
    // The mainDBusers entry alone isn't sufficient — the user must also exist
    // in their org's tenant DB (e.g. the "student" collection under orgId
    // codin_687106567ba5c99b1b899a5e), otherwise login must be rejected.
    if (findUser.orgId) {
      const org = await organisation.findOne({ orgId: findUser.orgId });
      if (org && org.active === false && findUser.type !== "admin") {
        throw new Error(
          "Your organization's account is currently deactivated. Please contact the administrator."
        );
      }

      const tenantDB = await getTenantDB(findUser.orgId);
      const { student, tpo, users } = connectTodb(tenantDB);

      const tenantCollection =
        findUser.type === "student"
          ? student
          : findUser.type === "college"
          ? tpo
          : findUser.type === "company" || findUser.type === "users"
          ? users
          : null;

      if (tenantCollection) {
        const tenantUser = await tenantCollection.findOne({
          email: findUser.email.toLowerCase(),
        });
        if (!tenantUser) {
          // Deactivate in mainDBusers so subsequent login attempts fail fast
          // on the `active` check above instead of re-querying the tenant DB.
          await mainDBusers.updateOne(
            { _id: findUser._id },
            { $set: { active: false } }
          );
          throw new Error(
            "Account Deactivated Please contact site administrator"
          );
        }
      }
    }

    // ===== LOGIN STREAK LOGIC =====
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let loginStreak = findUser.loginStreak || 0;
    let longestStreak = findUser.longestStreak || 0;

    if (findUser.lastLoginDate) {
      const lastLogin = new Date(findUser.lastLoginDate);
      lastLogin.setHours(0, 0, 0, 0);

      const diffDays = Math.floor(
        (today - lastLogin) / (1000 * 60 * 60 * 24)
      );

      if (diffDays === 1) {
        loginStreak += 1; // consecutive login
      } else if (diffDays > 1) {
        loginStreak = 1; // streak broken
      }
      // diffDays === 0 => same day login, don't increase
    } else {
      loginStreak = 1; // first login
    }

    longestStreak = Math.max(longestStreak, loginStreak);

    const loginData = {
      userID: findUser._id,
      email: findUser.email,
      userName: findUser.userName,
      role: findUser.role || "",
      type: findUser.type || "",
      orgId: findUser.orgId,
      loginStreak,
    };
console.log(loginData)
    const token = jwt.sign(loginData, process.env.JWT_SECRET);

    await mainDBusers.updateOne(
      { _id: findUser._id },
      {
        $set: {
          token,
          lastLoginDate: new Date(),
          loginStreak,
          longestStreak,
        },
      }
    );

    res.status(200).send({
      msg: "loggedin successfully",
      ...loginData,
      token,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});
app.post("/regiterMainDBUser", async (req, res) => {
  try {
    let { email, password, userName, orgId, type } = req.body;

    // Map 'skill' alias (sent by Google Form) to the actual special organization ID
    if (orgId === "skill") {
      orgId = "skill_68e9fa374c2e0b6f153a3135";
      req.body.orgId = orgId;
    }

    if (!email || !password || !userName || !orgId)
      throw new Error("Email,password, userName and orgId must be provided");

    const findRegUser = await mainDBusers.findOne({
      $and: [{ email }, { orgId }, { type }],
    });

    if (findRegUser) throw new Error("User already registered");

    const salt = await bcrypt.genSalt();

    const hash = await bcrypt.hash(password, salt);

    const db = await getTenantDB(orgId);
    const data = await mainDBusers.insertOne({
      ...req.body,
      email: email.toLowerCase(),
      type,
      password: hash,
      createdAt: new Date().getTime(),
      active: true,
    });
    switch (type) {
      case "college": {
        await db.collection("tpo").insertOne({
          email: email.toLowerCase(),
          password: hash,
          userName,
          orgId,
          type,
          globalId: data.insertedId.toString(),
          active: true,
        });
        break;
      }
      case "student": {
        await db.collection("student").insertOne({
          email: email.toLowerCase(),
          password: hash,
          userName,
          orgId,
          type,
          globalId: data.insertedId.toString(),
          active: true,
        });
        break;
      }
      case "company": {
        await db.collection("users").insertOne({
          email: email.toLowerCase(),
          password: hash,
          userName,
          orgId,
          type,
          globalId: data.insertedId.toString(),
          active: true,
        });
        break;
      }
      case "users": {
        await db.collection("users").insertOne({
          email: email.toLowerCase(),
          password: hash,
          userName,
          orgId,
          type,
          globalId: data.insertedId.toString(),
          active: true,
        });
        break;
      }
    }

    res.status(200).send({ msg: "registered successfully", data });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post("/registerOrg", async (req, res) => {
  try {
    const { email, orgName, taxInfo, type } = req.body;

    if (!email || !orgName || !type)
      throw new Error("Email , organisation Name Type and tax info required");

    const findUser = await organisation.findOne({
      $and: [{ email: email }, { orgName }, { taxInfo }],
    });

    if (findUser?._id) throw new Error("User already registered");
    // const salt = await bcrypt.genSalt();

    // const hash = await bcrypt.hash(password, salt);

    const data = await organisation.insertOne({
      ...req.body,
      active: true,
      // password: hash,
      createdAt: new Date().getTime(),
    });
    const orgId = `${sanitizeName(orgName)}_${data.insertedId.toString()}`;
    await organisation.updateOne({ _id: data.insertedId }, { $set: { orgId } });

    res.status(200).send({ msg: "registered successfully", data, orgId });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post(
  "/loginOrganisation",
  authenticate,
  selectTenantDB,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const findUser = await organisation.findOne({ email: email });

      if (!findUser?._id) throw new Error("Organisation not registered");
      if (!findUser?.active)
        throw new Error("Account Deactivated Please contact site adminstrator");
      const storedPassword = findUser.password;

      const compare = await bcrypt.compare(password, storedPassword);
      if (!compare) throw new Error("password incorrect");

      const loginData = {
        userID: findUser._id,
        email: findUser.email,
        userName: findUser.userName,
        role: findUser.role || "",
        orgId: findUser.orgId,
      };

      const token = jwt.sign(loginData, process.env.JWT_SECRET);

      await mainDBusers.updateOne(
        { _id: findUser._id },
        { $set: { token: token } }
      );

      res
        .status(200)
        .send({ msg: "loggedin successfully", ...loginData, token: token });
    } catch (error) {
      res.status(500).json({ err: error.message });
    }
  }
);

app.get("/getAllOrganisations", async (req, res) => {
  try {
    const { orgId } = req;
    const { type } = req.query;

    const query = {};
    if (type && typeof type === "string") {
      query.type = type;
    }

    const data = await organisation?.find(query).toArray();

    // Fetch counts for each organization
    const dataWithCounts = await Promise.all(
      data.map(async (org) => {
        let additionalData = {};

        try {
          // Get tenant database
          const tenantDB = await getTenantDB(org.orgId);

          if (org.type === "college") {
            // For colleges: get TPO and department counts
            const { tpo, departments } = connectTodb(tenantDB);

            const [tpoCount, departmentCount] = await Promise.all([
              tpo.countDocuments({}),
              departments.countDocuments({}),
            ]);

            additionalData = {
              tpoCount: tpoCount || 0,
              departmentCount: departmentCount || 0,
            };
          } else if (org.type === "company") {
            // For companies: get job count
            const jobsCollection = tenantDB.collection("job");
            const jobCount = await jobsCollection.countDocuments({});

            additionalData = {
              jobCount: jobCount || 0,
            };
          }

          // Get AI usage stats for all organization types
          const aiUsageStats = await aiUsageCollection
            .aggregate([
              {
                $match: { orgId: org.orgId },
              },
              {
                $group: {
                  _id: null,
                  totalRequests: { $sum: 1 },
                  totalCompletionTokens: { $sum: "$completionTokens" },
                  totalPromptTokens: { $sum: "$promptTokens" },
                  totalTokens: { $sum: "$totalTokens" },
                },
              },
            ])
            .toArray();

          // Add AI usage data
          additionalData.aiUsage =
            aiUsageStats.length > 0
              ? {
                totalRequests: aiUsageStats[0].totalRequests || 0,
                totalCompletionTokens:
                  aiUsageStats[0].totalCompletionTokens || 0,
                totalPromptTokens: aiUsageStats[0].totalPromptTokens || 0,
                totalTokens: aiUsageStats[0].totalTokens || 0,
              }
              : {
                totalRequests: 0,
                totalCompletionTokens: 0,
                totalPromptTokens: 0,
                totalTokens: 0,
              };
        } catch (error) {
          console.error(
            `Error fetching counts for org ${org.orgId}:`,
            error.message
          );
          // If error, set counts to 0
          if (org.type === "college") {
            additionalData = {
              tpoCount: 0,
              departmentCount: 0,
            };
          } else if (org.type === "company") {
            additionalData = {
              jobCount: 0,
            };
          }
          // Set AI usage to 0 on error
          additionalData.aiUsage = {
            totalRequests: 0,
            totalCompletionTokens: 0,
            totalPromptTokens: 0,
            totalTokens: 0,
          };
        }

        return {
          _id: org._id,
          orgName: org.orgName,
          orgId: org.orgId,
          type: org?.type,
          email: org?.email,
          createdAt: org?.createdAt,
          city: org?.city,
          state: org?.state,
          district: org?.district,
          active: org?.active,
          ...additionalData,
        };
      })
    );

    res.status(200).json({ data: dataWithCounts });
  } catch (error) {
    console.error("Error fetching organizations:", error);
    return res.status(500).json({ err: error.message });
  }
});

app.get(
  "/getTposInOrganisation",

  async (req, res) => {
    try {
      const { orgId } = req;

      // Optional: Get orgId from query params if you want to allow
      // authorized users to query different organizations
      const targetOrgId = req.query.orgId || orgId;

      // Get the tenant database for the organization
      const tenantDB = await getTenantDB(targetOrgId);

      // Access the tpo collection
      const { tpo } = connectTodb(tenantDB);

      // Find all TPOs in the organization
      const tpos = await tpo.find({ orgId: targetOrgId }).toArray();

      res.status(200).json({
        data: tpos,
        count: tpos.length,
      });
    } catch (error) {
      console.error("Error fetching TPOs:", error);
      res.status(500).json({ err: error.message });
    }
  }
);

app.post("/getAllDepartmentsFromOrgs", authenticate, async (req, res) => {
  const { orgId } = req;

  // Authorization check
  if (
    orgId !== "skill_688b1cce42c5e979f72d97d4" &&
    orgId !== "KSquare" &&
    (req?.role == "ADMIN" || req?.role == "MODERATOR" || req?.role == "VIEWER")
  ) {
    return res.status(403).json({ err: "User not authorized to access orgs" });
  }

  try {
    const { orgIds } = req.body;

    if (!orgIds?.length) {
      return res
        .status(400)
        .json({ err: "You must select organisations to add" });
    }

    // Use Promise.all for parallel execution
    const departmentPromises = orgIds.map(async (currentOrgId) => {
      try {
        const tenantDB = await getTenantDB(currentOrgId);

        const { departments } = connectTodb(tenantDB);
        const data = await departments.find({}).toArray();

        console.log(currentOrgId);
        return {
          orgId: currentOrgId,
          departments: data,
        };
      } catch (error) {
        // Handle individual org failures
        return {
          orgId: currentOrgId,
          departments: [],
          error: `Failed to fetch departments: ${error.message}`,
        };
      }
    });

    const departmentArr = await Promise.all(departmentPromises);

    res.status(200).json({ data: departmentArr });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
});

app.post(
  "/getStudentsFromOrgsDepartments",
  authenticate,

  async (req, res) => {
    const { orgId } = req;
    console.log(orgId);

    // Authorization check
    if (orgId !== "skill_688b1cce42c5e979f72d97d4" && orgId !== "KSquare") {
      return res
        .status(403)
        .json({ err: "User not authorized to access orgs" });
    }

    try {
      const { filters } = req.body;

      // Validate input format
      if (!filters?.length) {
        return res.status(400).json({
          err: "You must provide organization and department filters",
        });
      }

      // Validate each filter object
      for (const filter of filters) {
        if (!filter.orgId || !filter.departmentIds?.length) {
          return res.status(400).json({
            err: "Each filter must contain orgId and departmentIds array",
          });
        }
      }

      // Process each organization
      const studentPromises = filters.map(async (filter) => {
        try {
          const { orgId: targetOrgId, departmentIds } = filter;

          const tenantDB = await getTenantDB(targetOrgId);
          const { student, departments } = connectTodb(tenantDB);

          // Query students for this org and departments
          const query = {
            // orgId: targetOrgId,
            department: { $in: departmentIds },
          };

          const studentsData = await student.find(query).toArray();

          return {
            orgId: targetOrgId,
            departmentIds,
            students: studentsData,
            count: studentsData.length,
          };
        } catch (error) {
          return {
            orgId: filter.orgId,
            departmentIds: filter.departmentIds,
            students: [],
            count: 0,
            error: `Failed to fetch students: ${error.message}`,
          };
        }
      });

      const results = await Promise.all(studentPromises);

      res.status(200).json({
        data: results,
        totalOrgsProcessed: results.length,
      });
    } catch (error) {
      res.status(500).json({ err: error.message });
    }
  }
);

app.get(
  "/getOrganisation/:orgId?",

  async (req, res) => {
    try {
      const { orgId: authOrgId } = req;
      const { orgId: paramOrgId } = req.params;

      const targetOrgId = paramOrgId || authOrgId;

      if (!targetOrgId) {
        return res.status(400).json({ err: "Organization ID is required" });
      }

      let findOrg = await organisation.findOne({
        orgId: targetOrgId,
      });

      if (!findOrg) {
        try {
          findOrg = await organisation.findOne({
            _id: new ObjectId(targetOrgId),
          });
        } catch (err) {
          console.log("Not a valid ObjectId:", err.message);
        }
      }

      if (!findOrg) {
        return res.status(404).json({
          err: "Organization not found",
        });
      }

      res.status(200).json({ data: findOrg });
    } catch (error) {
      res.status(500).json({ err: error.message });
    }
  }
);

app.post("/resetUserPassword", async (req, res) => {
  try {
    if (!req.isAuth) throw new Error("User not authorized");
    const { oldPassword, newPassword } = req.body;

    const { userID } = req;

    if (!newPassword)
      return res.status(400).json({ message: "Passwords sould be provided" });

    const userDetails = await mainDBusers.findOne({
      _id: new ObjectId(userID),
    });

    if (!userDetails)
      return res
        .status(400)
        .json({ message: "Please select valid user to change password" });

    const compare = await bcrypt.compare(oldPassword, userDetails?.password);

    if (!compare) throw new Error("Incorrect Password");

    const salt = await bcrypt.genSalt();

    const hash = await bcrypt.hash(newPassword, salt);

    await mainDBusers.updateOne(
      { _id: userDetails._id },
      {
        $set: { password: hash },
      }
    );

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: "Invalid or expired token" });
  }
});

const sendMail = async (to, subject, text) => {
  await transporter.sendMail({
    from: process.env.support_mail,
    to,
    subject,
    text,
  });
};

const getPublicBaseUrl = (req) => {
  const configuredBaseUrl =
    process.env.RESET_PASSWORD_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.PUBLIC_BASE_URL;

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  // Behind a reverse proxy / tunnel (Azure Container Apps, ngrok, etc.) the
  // Host the client actually reached is in x-forwarded-host, not req.host —
  // without this, links would resolve to the proxy's internal address.
  const forwardedProto = req.get("x-forwarded-proto");
  const forwardedHost = req.get("x-forwarded-host");
  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host");

  return `${protocol}://${host}`;
};

app.post("/forgotStudentPassword", async (req, res) => {
  const { email, type } = req.body;

  if (!email || !type) {
    return res.status(400).json({ message: "email  is required" });
  }

  try {
    const userDetails = await mainDBusers.findOne({
      $and: [{ email }, { type }],
    });
    if (!userDetails)
      return res.status(404).json({ message: "User not found" });

    const token = jwt.sign(
      { id: userDetails._id, orgId: req.orgId },
      process.env.JWT_SECRET,
      {
        expiresIn: "15m",
      }
    );

    const resetUrl = `${getPublicBaseUrl(req)}/reset-password?token=${token}`;

    const message = `You requested a password reset. Click the link below:\n\n${resetUrl}`;

    await sendMail(userDetails.email, "Password Reset Request", message);

    res.json({ message: "Password reset email sent" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error sending email" });
  }
});

// Reset Password - Render HTML Form (GET)
app.get("/reset-password", async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.send(`
      <h1>Invalid or missing token</h1>
      <p>The password reset link is invalid or has expired.</p>
    `);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const userDetails = await mainDBusers.findOne({
      _id: new ObjectId(decoded.id),
    });

    if (!userDetails) {
      return res.send(`
        <h1>Invalid or expired token</h1>
        <p>The password reset link is invalid or has expired.</p>
      `);
    }

    // Render HTML Form
    res.send(`
      <h2>Reset Your Password</h2>
      <form method="POST" action="/reset-password?token=${token}" style="max-width: 400px; margin: auto;">
        <label>New Password:</label><br>
        <input type="password" name="newPassword" required style="width: 100%; padding: 8px; margin: 8px 0;"><br>
        <label>Confirm Password:</label><br>
        <input type="password" name="confirmPassword" required style="width: 100%; padding: 8px; margin: 8px 0;"><br>
        <button type="submit" style="margin-top: 10px; padding: 10px 20px;">Change Password</button>
      </form>
    `);
  } catch (error) {
    res.send(`
      <h1>Invalid or expired token</h1>
      <p>The password reset link is invalid or has expired.</p>
    `);
  }
});

// Reset Password - Handle Form Submission (POST)
app.post("/reset-password", async (req, res) => {
  const { token } = req.query;
  const { newPassword, confirmPassword } = req.body;

  if (!token) {
    return res.send(`
      <h1>Invalid or missing token</h1>
      <p>The password reset link is invalid or has expired.</p>
    `);
  }

  if (newPassword !== confirmPassword) {
    return res.send(`
      <h1>Passwords do not match</h1>
      <p>Please try again.</p>
      <a href="/reset-password?token=${token}">Go back</a>
    `);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const student = await mainDBusers.findOne({
      _id: new ObjectId(decoded.id),
    });

    if (!student) {
      return res.send(`
        <h1>Invalid or expired token</h1>
        <p>The password reset link is invalid or has expired.</p>
      `);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await mainDBusers.updateOne(
      { _id: new ObjectId(decoded.id) },
      {
        $set: { password: hashedPassword },
      }
    );
    const loginPage = `${process.env.STUDENT_PORTAL_URL}/login`;
    res.send(`
  <h1>Password Updated Successfully</h1>
  <p>You can now log in with your new password.</p>
  <meta http-equiv="refresh" content="3;url=${loginPage}">
  <p>Redirecting to <a href="${loginPage}">login page</a>...</p>
`);
  } catch (error) {
    res.send(`
      <h1>Invalid or expired token</h1>
      <p>The password reset link is invalid or has expired.</p>
    `);
  }
});

// app.get("/getOrganisationStats/:orgId", authenticate, async (req, res) => {
//   try {
//     const { orgId: requestOrgId } = req.params;

//     // Authorization check
//     const authorizedOrgs = ["skill_688b1cce42c5e979f72d97d4", "KSquare"];
//     const canAccessAnyOrg =
//       authorizedOrgs.includes(requestOrgId) ||
//       req?.role == "ADMIN" ||
//       req?.role == "MODERATOR" ||
//       req?.role == "VIEWER";

//     if (!canAccessAnyOrg) {
//       return res.status(403).json({
//         err: "User not authorized to access this organization",
//       });
//     }

//     // Find organization
//     let orgDetails = await organisation.findOne({
//       orgId: requestOrgId,
//     });

//     if (!orgDetails) {
//       try {
//         orgDetails = await organisation.findOne({
//           _id: new ObjectId(requestOrgId),
//         });
//       } catch (err) {
//         console.log("Not a valid ObjectId:", err.message);
//       }
//     }

//     if (!orgDetails) {
//       const allOrgs = await organisation
//         .find({})
//         .project({ orgId: 1, orgName: 1, type: 1 })
//         .toArray();
//       console.log("Available organizations:", allOrgs);

//       return res.status(404).json({
//         err: "Organization not found",
//         requestedOrgId: requestOrgId,
//         availableOrgs: allOrgs.map((o) => ({ orgId: o.orgId, type: o.type })),
//       });
//     }

//     console.log(
//       "Found organization:",
//       orgDetails.orgId,
//       "Type:",
//       orgDetails.type
//     );

//     const targetOrgId = orgDetails.orgId;
//     const orgType = orgDetails.type || "college";

//     // Get tenant database
//     const tenantDB = await getTenantDB(targetOrgId);

//     let statsData;

//     // ========== COMPANY ORGANIZATION ==========
//     if (orgType === "company") {
//       console.log("Fetching company organization stats...");

//       // Connect to company-specific collections
//       const usersCollection = tenantDB.collection("users");
//       const jobsCollection = tenantDB.collection("job");
//       const jobAssessmentsCollection = tenantDB.collection("jobAssessments");
//       const jobAssessmentProgressCollection = tenantDB.collection(
//         "jobAssessmentProgress"
//       );
//       const aiRespAtsCollection = tenantDB.collection("aiRespAts");
//       const proctoringSessions = tenantDB.collection("proctoringSessions");
//       const psychometricTestCollection = tenantDB.collection(
//         "psychometricTestCollection"
//       );

//       // Fetch counts in parallel
//       const [
//         totalUsers,
//         totalJobs,
//         totalAssessments,
//         activeJobs,
//         completedAssessments,
//         usersList,
//         jobsList,
//         jobStatsByStatus,
//         recentApplications,
//       ] = await Promise.all([
//         // User counts
//         usersCollection.countDocuments({}),

//         // Job counts
//         jobsCollection.countDocuments({}),

//         // Assessment counts
//         jobAssessmentsCollection.countDocuments({}),

//         // Active jobs
//         jobsCollection.countDocuments({ status: "active" }),

//         // Completed assessments
//         jobAssessmentProgressCollection.countDocuments({
//           status: "completed",
//         }),

//         // Get HR/Admin users (exclude passwords)
//         usersCollection
//           .find({ role: { $in: ["hr", "admin", "recruiter", "manager"] } })
//           .project({ password: 0, token: 0 })
//           .sort({ createdAt: -1 })
//           .toArray(),

//         // Get recent jobs
//         jobsCollection.find({}).sort({ createdAt: -1 }).limit(20).toArray(),

//         // Job statistics by status
//         jobsCollection
//           .aggregate([
//             {
//               $group: {
//                 _id: "$status",
//                 count: { $sum: 1 },
//               },
//             },
//           ])
//           .toArray(),

//         // Get recent applications/ATS responses
//         aiRespAtsCollection
//           .find({})
//           .sort({ createdAt: -1 })
//           .limit(10)
//           .toArray(),
//       ]);

//       // Get additional statistics
//       let draftJobs = 0;
//       let closedJobs = 0;
//       let totalApplications = 0;
//       let pendingAssessments = 0;

//       try {
//         [draftJobs, closedJobs, totalApplications, pendingAssessments] =
//           await Promise.all([
//             jobsCollection.countDocuments({ status: "draft" }),
//             jobsCollection.countDocuments({ status: "closed" }),
//             aiRespAtsCollection.countDocuments({}),
//             jobAssessmentProgressCollection.countDocuments({
//               status: "pending",
//             }),
//           ]);
//       } catch (err) {
//         console.log("Optional fields not available:", err.message);
//       }

//       // Process job stats
//       const jobStatusMap = {};
//       jobStatsByStatus.forEach((stat) => {
//         jobStatusMap[stat._id] = stat.count;
//       });

//       // Get job categories/departments if available
//       let jobCategories = [];
//       try {
//         jobCategories = await jobsCollection
//           .aggregate([
//             {
//               $group: {
//                 _id: "$category",
//                 count: { $sum: 1 },
//                 activeCount: {
//                   $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
//                 },
//               },
//             },
//           ])
//           .toArray();
//       } catch (err) {
//         console.log("Job categories not available:", err.message);
//       }

//       statsData = {
//         organization: {
//           _id: orgDetails._id,
//           orgId: orgDetails.orgId,
//           orgName: orgDetails.orgName,
//           email: orgDetails.email,
//           type: orgDetails.type,
//           taxInfo: orgDetails.taxInfo,
//           createdAt: orgDetails.createdAt,
//           industry: orgDetails.industry,
//           companySize: orgDetails.companySize,
//           website: orgDetails.website,
//           features: orgDetails.features,
//         },
//         counts: {
//           users: totalUsers,
//           jobs: totalJobs,
//           assessments: totalAssessments,
//           activeJobs: activeJobs || 0,
//           draftJobs: draftJobs || 0,
//           closedJobs: closedJobs || 0,
//           applications: totalApplications || 0,
//           completedAssessments: completedAssessments || 0,
//           pendingAssessments: pendingAssessments || 0,
//         },
//         hrDetails: usersList,
//         jobDetails: jobsList,
//         recentApplications: recentApplications,
//         statistics: {
//           jobsByStatus: jobStatsByStatus,
//           jobsByCategory: jobCategories,
//           activeJobRate:
//             totalJobs > 0
//               ? ((activeJobs / totalJobs) * 100).toFixed(2) + "%"
//               : "0%",
//           avgApplicationsPerJob:
//             totalJobs > 0 ? (totalApplications / totalJobs).toFixed(2) : "0",
//           assessmentCompletionRate:
//             totalAssessments > 0
//               ? ((completedAssessments / totalAssessments) * 100).toFixed(2) +
//                 "%"
//               : "0%",
//         },
//       };
//     } else {
//       // ========== COLLEGE/EDUCATIONAL ORGANIZATION ==========
//       console.log("Fetching educational organization stats...");

//       const { tpo, departments, student, users } = connectTodb(tenantDB);

//       const [
//         tpoCount,
//         departmentCount,
//         studentCount,
//         companyCount,
//         tpoList,
//         departmentList,
//         studentStats,
//       ] = await Promise.all([
//         tpo.countDocuments({}),
//         departments.countDocuments({}),
//         student.countDocuments({}),
//         users.countDocuments({ type: "company" }),

//         // Get TPO details
//         tpo.find({}).project({ password: 0, token: 0 }).toArray(),

//         // Get department details
//         departments.find({}).toArray(),

//         // Get student statistics by department
//         student
//           .aggregate([
//             {
//               $group: {
//                 _id: "$department",
//                 count: { $sum: 1 },
//               },
//             },
//           ])
//           .toArray(),
//       ]);

//       // Enrich department data with student counts
//       const departmentListWithCounts = departmentList.map((dept) => {
//         const stats = studentStats.find(
//           (s) => s._id && s._id.toString() === dept._id.toString()
//         );
//         return {
//           ...dept,
//           studentCount: stats ? stats.count : 0,
//         };
//       });

//       // Get additional student statistics
//       let activeStudents = 0;
//       let placedStudents = 0;

//       try {
//         [activeStudents, placedStudents] = await Promise.all([
//           student.countDocuments({ isActive: true }),
//           student.countDocuments({ placementStatus: "placed" }),
//         ]);
//       } catch (err) {
//         console.log("Optional student fields not available:", err.message);
//       }

//       statsData = {
//         organization: {
//           _id: orgDetails._id,
//           orgId: orgDetails.orgId,
//           orgName: orgDetails.orgName,
//           email: orgDetails.email,
//           type: orgDetails.type,
//           taxInfo: orgDetails.taxInfo,
//           createdAt: orgDetails.createdAt,
//           features: orgDetails.features,
//         },
//         counts: {
//           tpo: tpoCount,
//           departments: departmentCount,
//           students: studentCount,
//           companies: companyCount,
//           activeStudents: activeStudents || 0,
//           placedStudents: placedStudents || 0,
//         },
//         tpoDetails: tpoList,
//         departmentDetails: departmentListWithCounts,
//         statistics: {
//           studentsPerDepartment: studentStats,
//           placementRate:
//             studentCount > 0
//               ? ((placedStudents / studentCount) * 100).toFixed(2) + "%"
//               : "0%",
//         },
//       };
//     }

//     res.status(200).json({
//       success: true,
//       data: statsData,
//     });
//   } catch (error) {
//     console.error("Error fetching organization stats:", error);
//     res.status(500).json({
//       err: error.message,
//       stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
//     });
//   }
// });

app.get("/getOrganisationStats/:orgId", authenticate, async (req, res) => {
  try {
    const { orgId: requestOrgId } = req.params;

    // Authorization check
    const authorizedOrgs = ["skill_688b1cce42c5e979f72d97d4", "KSquare"];
    const canAccessAnyOrg =
      authorizedOrgs.includes(requestOrgId) ||
      req?.role == "ADMIN" ||
      req?.role == "MODERATOR" ||
      req?.role == "VIEWER";

    if (!canAccessAnyOrg) {
      return res.status(403).json({
        err: "User not authorized to access this organization",
      });
    }

    // Find organization
    let orgDetails = await organisation.findOne({
      orgId: requestOrgId,
    });

    if (!orgDetails) {
      try {
        orgDetails = await organisation.findOne({
          _id: new ObjectId(requestOrgId),
        });
      } catch (err) {
        console.log("Not a valid ObjectId:", err.message);
      }
    }

    if (!orgDetails) {
      const allOrgs = await organisation.find({}).toArray();
      console.log("Available organizations:", allOrgs);

      return res.status(404).json({
        err: "Organization not found",
        requestedOrgId: requestOrgId,
        availableOrgs: allOrgs.map((o) => ({ orgId: o.orgId, type: o.type })),
      });
    }

    console.log(
      "Found organization:",
      orgDetails.orgId,
      "Type:",
      orgDetails.type
    );

    const targetOrgId = orgDetails.orgId;
    const orgType = orgDetails.type || "college";

    // Get tenant database
    const tenantDB = await getTenantDB(targetOrgId);

    // Calculate date ranges for monthly comparison
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      0,
      23,
      59,
      59,
      999
    );

    let statsData;

    // ========== COMPANY ORGANIZATION ==========
    if (orgType === "company") {
      console.log("Fetching company organization stats...");

      // Connect to company-specific collections
      const usersCollection = tenantDB.collection("users");
      const jobsCollection = tenantDB.collection("job");
      const jobAssessmentsCollection = tenantDB.collection("jobAssessments");
      const jobAssessmentProgressCollection = tenantDB.collection(
        "jobAssessmentProgress"
      );
      const aiRespAtsCollection = tenantDB.collection("aiRespAts");
      const proctoringSessions = tenantDB.collection("proctoringSessions");
      const psychometricTestCollection = tenantDB.collection(
        "psychometricTestCollection"
      );

      // Fetch counts in parallel
      const [
        totalUsers,
        totalJobs,
        totalAssessments,
        activeJobs,
        completedAssessments,
        usersList,
        jobsList,
        jobStatsByStatus,
        recentApplications,
        draftJobs,
        closedJobs,
        totalApplications,
        pendingAssessments,
        // Monthly comparison counts
        usersLastMonth,
        jobsLastMonth,
        activeJobsLastMonth,
        applicationsLastMonth,
        // AI usage stats
        aiUsageStats,
        aiUsageLastMonth,
      ] = await Promise.all([
        // User counts
        usersCollection.countDocuments({}),

        // Job counts
        jobsCollection.countDocuments({}),

        // Assessment counts
        jobAssessmentsCollection.countDocuments({}),

        // Active jobs
        jobsCollection.countDocuments({ status: "active" }),

        // Completed assessments
        jobAssessmentProgressCollection.countDocuments({
          status: "completed",
        }),

        // Get HR/Admin users (exclude passwords)
        usersCollection
          .find({ role: { $in: ["hr", "admin", "recruiter", "manager"] } })
          .project({ password: 0, token: 0 })
          .sort({ createdAt: -1 })
          .toArray(),

        // Get recent jobs
        jobsCollection.find({}).sort({ createdAt: -1 }).limit(20).toArray(),

        // Job statistics by status
        jobsCollection
          .aggregate([
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        // Get recent applications/ATS responses
        aiRespAtsCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(10)
          .toArray(),

        jobsCollection.countDocuments({ status: "draft" }),
        jobsCollection.countDocuments({ status: "closed" }),
        aiRespAtsCollection.countDocuments({}),
        jobAssessmentProgressCollection.countDocuments({
          status: "pending",
        }),

        // Last month counts
        usersCollection.countDocuments({
          createdAt: { $lt: currentMonthStart },
        }),
        jobsCollection.countDocuments({
          createdAt: { $lt: currentMonthStart },
        }),
        jobsCollection.countDocuments({
          status: "active",
          createdAt: { $lt: currentMonthStart },
        }),
        aiRespAtsCollection.countDocuments({
          createdAt: { $lt: currentMonthStart },
        }),

        // AI usage current month
        aiUsageCollection
          .aggregate([
            {
              $match: { orgId: targetOrgId },
            },
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                totalCompletionTokens: { $sum: "$completionTokens" },
                totalPromptTokens: { $sum: "$promptTokens" },
                totalTokens: { $sum: "$totalTokens" },
              },
            },
          ])
          .toArray(),

        // AI usage last month
        aiUsageCollection
          .aggregate([
            {
              $match: {
                orgId: targetOrgId,
                createdAt: { $lt: currentMonthStart },
              },
            },
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                totalTokens: { $sum: "$totalTokens" },
              },
            },
          ])
          .toArray(),
      ]);

      // Calculate monthly change rates
      const calculateChangeRate = (current, previous) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return (((current - previous) / previous) * 100).toFixed(2);
      };

      // Process AI usage data
      const currentAiUsage =
        aiUsageStats.length > 0
          ? aiUsageStats[0]
          : {
            totalRequests: 0,
            totalCompletionTokens: 0,
            totalPromptTokens: 0,
            totalTokens: 0,
          };

      const lastMonthAiUsage =
        aiUsageLastMonth.length > 0
          ? aiUsageLastMonth[0]
          : {
            totalRequests: 0,
            totalTokens: 0,
          };

      // Get job categories/departments if available
      let jobCategories = [];
      try {
        jobCategories = await jobsCollection
          .aggregate([
            {
              $group: {
                _id: "$category",
                count: { $sum: 1 },
                activeCount: {
                  $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();
      } catch (err) {
        console.log("Job categories not available:", err.message);
      }

      // Process job stats
      const jobStatusMap = {};
      jobStatsByStatus.forEach((stat) => {
        jobStatusMap[stat._id] = stat.count;
      });

      statsData = {
        organization: {
          _id: orgDetails._id,
          orgId: orgDetails.orgId,
          orgName: orgDetails.orgName,
          email: orgDetails.email,
          type: orgDetails.type,
          taxInfo: orgDetails.taxInfo,
          createdAt: orgDetails.createdAt,
          industry: orgDetails.industry,
          companySize: orgDetails.companySize,
          website: orgDetails.website,
          features: orgDetails.features,
          aiTokenLimit: orgDetails.aiTokenLimit,
        },
        counts: {
          users: totalUsers,
          jobs: totalJobs,
          assessments: totalAssessments,
          activeJobs: activeJobs || 0,
          draftJobs: draftJobs || 0,
          closedJobs: closedJobs || 0,
          applications: totalApplications || 0,
          completedAssessments: completedAssessments || 0,
          pendingAssessments: pendingAssessments || 0,
        },
        aiUsage: {
          totalRequests: currentAiUsage.totalRequests,
          totalCompletionTokens: currentAiUsage.totalCompletionTokens,
          totalPromptTokens: currentAiUsage.totalPromptTokens,
          totalTokens: currentAiUsage.totalTokens,
        },
        monthlyChangeRate: {
          users: {
            current: totalUsers,
            previous: usersLastMonth,
            change: calculateChangeRate(totalUsers, usersLastMonth),
            changeValue: totalUsers - usersLastMonth,
          },
          jobs: {
            current: totalJobs,
            previous: jobsLastMonth,
            change: calculateChangeRate(totalJobs, jobsLastMonth),
            changeValue: totalJobs - jobsLastMonth,
          },
          activeJobs: {
            current: activeJobs,
            previous: activeJobsLastMonth,
            change: calculateChangeRate(activeJobs, activeJobsLastMonth),
            changeValue: activeJobs - activeJobsLastMonth,
          },
          applications: {
            current: totalApplications,
            previous: applicationsLastMonth,
            change: calculateChangeRate(
              totalApplications,
              applicationsLastMonth
            ),
            changeValue: totalApplications - applicationsLastMonth,
          },
          aiRequests: {
            current: currentAiUsage.totalRequests,
            previous: lastMonthAiUsage.totalRequests,
            change: calculateChangeRate(
              currentAiUsage.totalRequests,
              lastMonthAiUsage.totalRequests
            ),
            changeValue:
              currentAiUsage.totalRequests - lastMonthAiUsage.totalRequests,
          },
          aiTokens: {
            current: currentAiUsage.totalTokens,
            previous: lastMonthAiUsage.totalTokens,
            change: calculateChangeRate(
              currentAiUsage.totalTokens,
              lastMonthAiUsage.totalTokens
            ),
            changeValue:
              currentAiUsage.totalTokens - lastMonthAiUsage.totalTokens,
          },
        },
        hrDetails: usersList,
        jobDetails: jobsList,
        recentApplications: recentApplications,
        statistics: {
          jobsByStatus: jobStatsByStatus,
          jobsByCategory: jobCategories,
          activeJobRate:
            totalJobs > 0
              ? ((activeJobs / totalJobs) * 100).toFixed(2) + "%"
              : "0%",
          avgApplicationsPerJob:
            totalJobs > 0 ? (totalApplications / totalJobs).toFixed(2) : "0",
          assessmentCompletionRate:
            totalAssessments > 0
              ? ((completedAssessments / totalAssessments) * 100).toFixed(2) +
              "%"
              : "0%",
        },
      };
    } else {
      // ========== COLLEGE/EDUCATIONAL ORGANIZATION ==========
      console.log("Fetching educational organization stats...");

      const { tpo, departments, student, users } = connectTodb(tenantDB);

      const [
        tpoCount,
        departmentCount,
        studentCount,
        companyCount,
        tpoList,
        departmentList,
        studentStats,
        activeStudents,
        placedStudents,
        // Last month counts
        departmentCountLastMonth,
        studentCountLastMonth,
        activeStudentsLastMonth,
        placedStudentsLastMonth,
        // AI usage stats
        aiUsageStats,
        aiUsageLastMonth,
      ] = await Promise.all([
        tpo.countDocuments({}),
        departments.countDocuments({}),
        student.countDocuments({}),
        users.countDocuments({ type: "company" }),

        // Get TPO details
        tpo.find({}).project({ password: 0, token: 0 }).toArray(),

        // Get department details
        departments.find({}).toArray(),

        // Get student statistics by department
        student
          .aggregate([
            {
              $group: {
                _id: "$department",
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        // Current active and placed students
        student.countDocuments({ isActive: true }),
        student.countDocuments({ placementStatus: "placed" }),

        // Last month counts
        departments.countDocuments({
          createdAt: { $lt: currentMonthStart },
        }),
        student.countDocuments({
          createdAt: { $lt: currentMonthStart },
        }),
        student.countDocuments({
          isActive: true,
          createdAt: { $lt: currentMonthStart },
        }),
        student.countDocuments({
          placementStatus: "placed",
          placedAt: { $lt: currentMonthStart },
        }),

        // AI usage current month
        aiUsageCollection
          .aggregate([
            {
              $match: { orgId: targetOrgId },
            },
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                totalCompletionTokens: { $sum: "$completionTokens" },
                totalPromptTokens: { $sum: "$promptTokens" },
                totalTokens: { $sum: "$totalTokens" },
              },
            },
          ])
          .toArray(),

        // AI usage last month
        aiUsageCollection
          .aggregate([
            {
              $match: {
                orgId: targetOrgId,
                createdAt: { $lt: currentMonthStart },
              },
            },
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                totalTokens: { $sum: "$totalTokens" },
              },
            },
          ])
          .toArray(),
      ]);

      // Calculate monthly change rates
      const calculateChangeRate = (current, previous) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return (((current - previous) / previous) * 100).toFixed(2);
      };

      // Process AI usage data
      const currentAiUsage =
        aiUsageStats.length > 0
          ? aiUsageStats[0]
          : {
            totalRequests: 0,
            totalCompletionTokens: 0,
            totalPromptTokens: 0,
            totalTokens: 0,
          };

      const lastMonthAiUsage =
        aiUsageLastMonth.length > 0
          ? aiUsageLastMonth[0]
          : {
            totalRequests: 0,
            totalTokens: 0,
          };

      // Enrich department data with student counts
      const departmentListWithCounts = departmentList.map((dept) => {
        const stats = studentStats.find(
          (s) => s._id && s._id.toString() === dept._id.toString()
        );
        return {
          ...dept,
          studentCount: stats ? stats.count : 0,
        };
      });

      statsData = {
        organization: {
          _id: orgDetails._id,
          orgId: orgDetails.orgId,
          orgName: orgDetails.orgName,
          email: orgDetails.email,
          type: orgDetails.type,
          taxInfo: orgDetails.taxInfo,
          createdAt: orgDetails.createdAt,
          features: orgDetails.features,
          aiTokenLimit: orgDetails.aiTokenLimit,
        },
        counts: {
          tpo: tpoCount,
          departments: departmentCount,
          students: studentCount,
          companies: companyCount,
          activeStudents: activeStudents || 0,
          placedStudents: placedStudents || 0,
        },
        aiUsage: {
          totalRequests: currentAiUsage.totalRequests,
          totalCompletionTokens: currentAiUsage.totalCompletionTokens,
          totalPromptTokens: currentAiUsage.totalPromptTokens,
          totalTokens: currentAiUsage.totalTokens,
        },
        monthlyChangeRate: {
          departments: {
            current: departmentCount,
            previous: departmentCountLastMonth,
            change: calculateChangeRate(
              departmentCount,
              departmentCountLastMonth
            ),
            changeValue: departmentCount - departmentCountLastMonth,
          },
          students: {
            current: studentCount,
            previous: studentCountLastMonth,
            change: calculateChangeRate(studentCount, studentCountLastMonth),
            changeValue: studentCount - studentCountLastMonth,
          },
          activeStudents: {
            current: activeStudents,
            previous: activeStudentsLastMonth,
            change: calculateChangeRate(
              activeStudents,
              activeStudentsLastMonth
            ),
            changeValue: activeStudents - activeStudentsLastMonth,
          },
          placedStudents: {
            current: placedStudents,
            previous: placedStudentsLastMonth,
            change: calculateChangeRate(
              placedStudents,
              placedStudentsLastMonth
            ),
            changeValue: placedStudents - placedStudentsLastMonth,
          },
          aiRequests: {
            current: currentAiUsage.totalRequests,
            previous: lastMonthAiUsage.totalRequests,
            change: calculateChangeRate(
              currentAiUsage.totalRequests,
              lastMonthAiUsage.totalRequests
            ),
            changeValue:
              currentAiUsage.totalRequests - lastMonthAiUsage.totalRequests,
          },
          aiTokens: {
            current: currentAiUsage.totalTokens,
            previous: lastMonthAiUsage.totalTokens,
            change: calculateChangeRate(
              currentAiUsage.totalTokens,
              lastMonthAiUsage.totalTokens
            ),
            changeValue:
              currentAiUsage.totalTokens - lastMonthAiUsage.totalTokens,
          },
        },
        tpoDetails: tpoList,
        departmentDetails: departmentListWithCounts,
        statistics: {
          studentsPerDepartment: studentStats,
          placementRate:
            studentCount > 0
              ? ((placedStudents / studentCount) * 100).toFixed(2) + "%"
              : "0%",
        },
      };
    }

    res.status(200).json({
      success: true,
      data: statsData,
    });
  } catch (error) {
    console.error("Error fetching organization stats:", error);
    res.status(500).json({
      err: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

app.patch("/updateOrganisationFeatures/:orgId", async (req, res) => {
  try {
    const { orgId: requestOrgId } = req.params;
    let { orgId: authOrgId } = req;
    authOrgId = req.query?.orgId;
    const { features } = req.body;

    if (!features || typeof features !== "object") {
      return res.status(400).json({
        err: "Features object is required",
      });
    }
    console.log(authOrgId, requestOrgId);

    // Authorization check
    const authorizedOrgs = ["skill_688b1cce42c5e979f72d97d4", "KSquare"];
    const canAccessAnyOrg = authorizedOrgs.includes(authOrgId);

    if (!canAccessAnyOrg && authOrgId !== requestOrgId) {
      return res.status(403).json({
        err: "User not authorized to update this organization",
      });
    }

    // Find organization first
    let orgDetails = await organisation.findOne({ orgId: requestOrgId });

    if (!orgDetails) {
      try {
        orgDetails = await organisation.findOne({
          _id: new ObjectId(requestOrgId),
        });
      } catch (err) {
        console.log("Not a valid ObjectId:", err.message);
      }
    }

    if (!orgDetails) {
      return res.status(404).json({
        err: "Organization not found",
      });
    }

    // Merge existing features with new features
    const updatedFeatures = {
      ...(orgDetails.features || {}),
      ...features,
    };

    // Update organization
    await organisation.updateOne(
      { _id: orgDetails._id },
      { $set: { features: updatedFeatures } }
    );

    res.status(200).json({
      msg: "Organization features updated successfully",
      data: {
        _id: orgDetails._id,
        orgId: orgDetails.orgId,
        orgName: orgDetails.orgName,
        features: updatedFeatures,
      },
    });
  } catch (error) {
    console.error("Error updating organization features:", error);
    res.status(500).json({ err: error.message });
  }
});

app.get("/organizations/:orgId/jobs/paginated", async (req, res) =>
  getJobsByOrgPaginated(req, res)
);

app.get("/organizations/:orgId/users/paginated", async (req, res) =>
  getUsersByOrgPaginated(req, res)
);

app.post("/updateOrganization/:orgId", authenticate, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { role } = req;

    // Authorization check
    if (role !== "ADMIN") {
      return res.status(403).json({
        err: "User not authorized to update organisation",
      });
    }

    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        err: "No data provided for update",
      });
    }

    // Query by orgId field (NOT _id)
    const orgData = await organisation.findOne({ orgId: orgId });
    console.log("Found organization:", orgData);

    if (!orgData) {
      return res.status(404).json({
        err: "Organization not found",
      });
    }

    // Update using the actual _id from found document
    const result = await organisation.updateOne(
      { _id: orgData._id },
      { $set: { ...req.body } }
    );

    if (result.modifiedCount === 0) {
      return res.status(200).json({
        msg: "No changes made to organization",
      });
    }

    res.status(200).json({
      msg: "Organization details updated successfully",
      modifiedCount: result.modifiedCount,
      orgId: orgData.orgId,
    });
  } catch (error) {
    console.error("Error updating organization:", error);
    res.status(500).json({
      err: "Internal server error",
      message: error.message,
    });
  }
});

app.get(
  "/getStudentsDepartmentAndOrg/:orgId/:departmentId",
  async (req, res) => {
    try {
      const { orgId, departmentId } = req.params;

      // Extract pagination and search query params with defaults
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const search = req.query.search?.toString().trim() || "";

      if (page < 1 || limit < 1) {
        return res
          .status(400)
          .json({ err: "page and limit must be positive integers" });
      }

      // Validate parameters
      if (!orgId || !departmentId) {
        return res
          .status(400)
          .json({ err: "Both orgId and departmentId are required" });
      }

      // Get tenant database for the organization
      const tenantDB = await getTenantDB(orgId);
      if (!tenantDB) {
        return res.status(404).json({ err: "Organization not found" });
      }

      const { student, departments } = connectTodb(tenantDB);

      // Verify department exists
      let departmentData;
      try {
        departmentData = await departments.findOne({
          _id: new ObjectId(departmentId),
        });
      } catch (err) {
        // If departmentId is not valid ObjectId, attempt as string
        departmentData = await departments.findOne({ _id: departmentId });
      }

      if (!departmentData) {
        return res
          .status(404)
          .json({ err: "Department not found in this organization" });
      }

      // Build query with search filter
      const query = {
        department: departmentId,
      };

      // Add search filter for email and username/firstName
      if (search) {
        query.$or = [
          { email: { $regex: search, $options: "i" } },
          { userName: { $regex: search, $options: "i" } },
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
        ];
      }

      const skip = (page - 1) * limit;

      // Parallel queries for performance
      const [totalCount, studentsData, orgAiUsageStats] = await Promise.all([
        // Total count for this query
        student.countDocuments(query),

        // Paginated student data
        student
          .find(query)
          .skip(skip)
          .limit(limit)
          .sort({ createdAt: -1 })
          .toArray(),

        // Organization-level AI usage stats
        aiUsageCollection
          .aggregate([
            {
              $match: { orgId: orgId },
            },
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                totalCompletionTokens: { $sum: "$completionTokens" },
                totalPromptTokens: { $sum: "$promptTokens" },
                totalTokens: { $sum: "$totalTokens" },
              },
            },
          ])
          .toArray(),
      ]);

      // Get AI usage per student
      let studentsWithAIUsage = studentsData;

      if (studentsData.length > 0) {
        // Extract student user IDs
        const studentUserIds = studentsData
          .map((s) => s._id?.toString())
          .filter(Boolean);
        const studentGlobalIds = studentsData
          .map((s) => s.globalId?.toString())
          .filter(Boolean);

        // Get AI usage for each student
        const studentAIUsage = await aiUsageCollection
          .aggregate([
            {
              $match: {
                orgId: orgId,
                userId: { $in: studentGlobalIds },
              },
            },
            {
              $group: {
                _id: "$userId",
                totalRequests: { $sum: 1 },
                totalCompletionTokens: { $sum: "$completionTokens" },
                totalPromptTokens: { $sum: "$promptTokens" },
                totalTokens: { $sum: "$totalTokens" },
              },
            },
          ])
          .toArray();

        // Create a map for quick lookup
        const aiUsageMap = {};
        studentAIUsage.forEach((usage) => {
          aiUsageMap[usage._id] = {
            totalRequests: usage.totalRequests || 0,
            totalCompletionTokens: usage.totalCompletionTokens || 0,
            totalPromptTokens: usage.totalPromptTokens || 0,
            totalTokens: usage.totalTokens || 0,
          };
        });

        // Attach AI usage to each student
        studentsWithAIUsage = studentsData.map((student) => ({
          ...student,
          aiUsage: aiUsageMap[student.globalId?.toString()] || {
            totalRequests: 0,
            totalCompletionTokens: 0,
            totalPromptTokens: 0,
            totalTokens: 0,
          },
        }));
      }

      // Process organization-level AI usage data
      const organizationAiUsage =
        orgAiUsageStats.length > 0
          ? {
            totalRequests: orgAiUsageStats[0].totalRequests || 0,
            totalCompletionTokens:
              orgAiUsageStats[0].totalCompletionTokens || 0,
            totalPromptTokens: orgAiUsageStats[0].totalPromptTokens || 0,
            totalTokens: orgAiUsageStats[0].totalTokens || 0,
          }
          : {
            totalRequests: 0,
            totalCompletionTokens: 0,
            totalPromptTokens: 0,
            totalTokens: 0,
          };

      res.status(200).json({
        success: true,
        data: {
          orgId,
          departmentId,
          departmentData,
          students: studentsWithAIUsage,
          count: studentsWithAIUsage.length,
          totalCount,
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit),
          search: search || null,
          organizationAiUsage,
        },
      });
    } catch (error) {
      console.error("Error fetching students:", error);
      res.status(500).json({ err: error.message });
    }
  }
);

// Update organization AI token limit
app.put("/updateOrganisationAILimit/:orgId", authenticate, async (req, res) => {
  try {
    const { orgId: requestOrgId } = req.params;
    const { aiTokenLimit } = req.body;

    // Authorization check
    const authorizedOrgs = ["skill_688b1cce42c5e979f72d97d4", "KSquare"];
    const canAccessAnyOrg =
      authorizedOrgs.includes(requestOrgId) ||
      req?.role == "ADMIN" ||
      req?.role == "MODERATOR";

    if (!canAccessAnyOrg) {
      return res.status(403).json({
        err: "User not authorized to update this organization",
      });
    }

    // Validate input
    if (aiTokenLimit === undefined || aiTokenLimit === null) {
      return res.status(400).json({
        err: "aiTokenLimit is required",
      });
    }

    if (typeof aiTokenLimit !== "number" || aiTokenLimit < 0) {
      return res.status(400).json({
        err: "aiTokenLimit must be a positive number",
      });
    }

    // Find and update organization
    const updateResult = await organisation.updateOne(
      { orgId: requestOrgId },
      { $set: { aiTokenLimit: aiTokenLimit } }
    );

    if (updateResult.matchedCount === 0) {
      // Try with ObjectId if orgId didn't match
      try {
        const objectIdResult = await organisation.updateOne(
          { _id: new ObjectId(requestOrgId) },
          { $set: { aiTokenLimit: aiTokenLimit } }
        );

        if (objectIdResult.matchedCount === 0) {
          return res.status(404).json({
            err: "Organization not found",
          });
        }
      } catch (err) {
        return res.status(404).json({
          err: "Organization not found",
        });
      }
    }

    res.status(200).json({
      success: true,
      message: "AI token limit updated successfully",
      data: {
        orgId: requestOrgId,
        aiTokenLimit: aiTokenLimit,
      },
    });
  } catch (error) {
    console.error("Error updating AI token limit:", error);
    res.status(500).json({
      err: error.message,
    });
  }
});

app.put("/toggleOrganizationStatus/:orgId", authenticate, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { active } = req.body;
    const { role } = req;

    if (role !== "ADMIN") {
      return res.status(403).json({
        err: "User not authorized to update organisation",
      });
    }

    const orgData = await organisation.findOne({ orgId: orgId });
    if (!orgData) {
      return res.status(404).json({
        err: "Organization not found",
      });
    }

    const result = await organisation.updateOne(
      { orgId: orgId },
      { $set: { active: active } }
    );

    if (result.modifiedCount === 0 && orgData.active === active) {
      return res.status(200).json({
        msg: "Organization status is already up to date",
      });
    }

    res.status(200).json({
      msg: `Organization successfully ${active ? 'activated' : 'deactivated'}`,
      active: active
    });
  } catch (error) {
    console.error("Error toggling organization status:", error);
    res.status(500).json({
      err: "Internal server error",
      message: error.message,
    });
  }
});

app.delete("/deleteOrginaztion/:orgId", authenticate, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { role, isAdmin } = req;
    console.log(isAdmin);

    // Authorization check
    if (role !== "ADMIN") {
      return res.status(403).json({
        err: "User not authorized to update organisation",
      });
    }

    // Query by orgId field (NOT _id)
    const orgData = await organisation.findOne({ orgId: orgId });
    console.log("Found organization:", orgData);

    if (!orgData) {
      return res.status(404).json({
        err: "Organization not found",
      });
    }

    // Archive the organization record before deactivating it
    await archiveAndDeleteOne(organisation, { _id: orgData._id }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
      softDelete: true,
    });

    // Archive tenant database and drop it if it exists
    let tenantArchiveResult = null;
    try {
      const tenantDb = await getTenantDB(orgData.orgId);
      if (tenantDb) {
        logger.info('[Delete Org] Starting tenant database archival', {
          orgId: orgData.orgId,
          userId: req.userID,
        });

        tenantArchiveResult = await archiveTenantDatabase(tenantDb, orgData.orgId, {
          archivedBy: req.userID || null,
          reason: req.body.reason || null,
        });
        
        logger.info('[Delete Org] Tenant database archived', {
          orgId: orgData.orgId,
          databaseExisted: tenantArchiveResult.databaseExisted,
          collectionsArchived: tenantArchiveResult.collectionsArchived,
          totalDocumentsCopied: tenantArchiveResult.totalDocumentsCopied,
          databaseDropped: tenantArchiveResult.databaseDropped,
          archiveResult: tenantArchiveResult,
        });
      } else {
        logger.warn('[Delete Org] Tenant database not found for organization', {
          orgId: orgData.orgId,
        });
      }
    } catch (tenantArchiveError) {
      logger.error('[Delete Org] CRITICAL - Tenant database archival failed - database NOT dropped', {
        orgId: orgData.orgId,
        error: tenantArchiveError.message,
        errorStack: tenantArchiveError.stack,
      });
      // Return error - do not proceed with org deactivation
      return res.status(500).json({
        err: "Failed to archive organization database",
        message: tenantArchiveError.message,
        orgId: orgData.orgId,
        note: "Database has NOT been dropped. Please investigate and retry.",
      });
    }

    // Update using the actual _id from found document
    const result = await organisation.updateOne(
      { _id: orgData._id },
      { $set: { active: false } }
    );
    const usersRed = await mainDBusers.updateOne(
      { orgId: orgData.orgId },
      { $set: { active: false } }
    );

    if (result.modifiedCount === 0) {
      return res.status(200).json({
        msg: "No changes made to organization",
      });
    }

    res.status(200).json({
      msg: "Organization deleted successfully",
      modifiedCount: result.modifiedCount,
      orgId: orgData.orgId,
      tenantDatabaseArchive: tenantArchiveResult,
    });
  } catch (error) {
    console.error("Error updating organization:", error);
    res.status(500).json({
      err: "Internal server error",
      message: error.message,
    });
  }
});

app.put("/toggleHrStatus/:hrId", authenticate, async (req, res) => {
  try {
    const { hrId } = req.params;
    const { active } = req.body;
    const { role } = req;

    if (role !== "ADMIN") {
      return res.status(403).json({
        err: "User not authorized to update HR status",
      });
    }

    const findUser = await mainDBusers.findOne({
      _id: new mongoDB.ObjectId(hrId),
    });

    if (!findUser) throw new Error("User not registered");

    const result = await mainDBusers.updateOne(
      { _id: new mongoDB.ObjectId(hrId) },
      { $set: { active: active } }
    );

    if (findUser.orgId) {
      const db = await getTenantDB(findUser.orgId, 5);
      const usersCollection = db.collection('users');
      await usersCollection.updateOne(
        { globalId: hrId },
        { $set: { active: active } }
      );
    }

    res.status(200).json({
      msg: `HR successfully ${active ? 'activated' : 'deactivated'}`,
      active: active
    });
  } catch (error) {
    console.error("Error toggling HR status:", error);
    res.status(500).json({
      err: error.message,
    });
  }
});

app.post("/getUsersFromIds", authenticate, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: "Invalid ids array" });
    }

    const objectIds = ids
      .filter((id) => mongoDB.ObjectId.isValid(id))
      .map((id) => new mongoDB.ObjectId(id));

    const users = await mainDBusers.find({
      _id: { $in: objectIds }
    }).project({ userName: 1, firstName: 1, lastName: 1, name: 1, email: 1, role: 1, type: 1 }).toArray();

    res.status(200).json({
      data: users
    });
  } catch (error) {
    console.error("Error fetching users by ids:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
