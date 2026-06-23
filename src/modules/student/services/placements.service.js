const express = require("express");
const axios = require("axios");
const cors = require("cors");

const { ObjectId } = require("mongodb");
const { pipeline } = require("nodemailer/lib/xoauth2");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const mongoDB = require("mongodb");
const {
  questions,
  skillsCollection,
  organisation,
} = require("../../../shared/db/connection").getGlobalCollections();
const { getTenantDB } = require("../../../shared/db/connection");
const nodemailer = require("nodemailer");
const {
  notifyJobPosting,
  notifyJobUpdate,
} = require("../../../shared/utils/eventBus");

const app = express();
app.use(cors());
app.use(express.json());

app.use(authenticate);
app.use(selectTenantDB);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.support_mail,
    pass: process.env.support_pass,
  },
  maxConnections: 5,
  maxMessages: 50,
  rateLimit: 10,
});

module.exports.createJobProfile = async (req, res) => {
  const { placements } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const createdData = await placements.insertOne({
      ...req.body,
      createdAt: new Date().getTime(),
      jobs: [],
    });

    res
      .status(200)
      .json({ msg: "Job profile created successfully", data: createdData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateJobProfile = async (req, res) => {
  const { placements } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { profileId } = req.params;

    const covId = new ObjectId(profileId);

    const findJobProfile = await placements.findOne({ _id: covId });

    if (!findJobProfile)
      throw new Error("Please select valid job profile to update");

    const updatedData = await placements.updateOne(
      { _id: findJobProfile._id },
      {
        $set: { ...req.body, updatedAt: new Date().getTime() },
      }
    );

    res
      .status(200)
      .json({ msg: "Job profile updated successfully", data: updatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deleteJobProfile = async (req, res) => {
  const { placements } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { profileId } = req.params;

    const covId = new ObjectId(profileId);

    const findJobProfile = await placements.findOne({ _id: covId });

    if (!findJobProfile)
      throw new Error("Please select valid job profile to delete");

    const deletedData = await placements.deleteOne({
      _id: findJobProfile._id,
    });

    res
      .status(200)
      .json({ msg: "Job profile deleted successfully", ...deletedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getOneJobProfile = async (req, res) => {
  const { placements } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { profileId } = req.params;

    const covId = new ObjectId(profileId);

    const findJobProfile = await placements.findOne({ _id: covId });

    if (!findJobProfile) throw new Error("Selected job profile not found");

    res.status(200).json({
      data: findJobProfile,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAllJobProfiles = async (req, res) => {
  const { placements, job } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    let { cursor = null, limit = 20 } = req.query;
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

    const docs = await placements.aggregate(pipeline).toArray();

    const getCompaniesLikedToJobProfile = await Promise.all(
      docs.map(async (e) => {
        return {
          ...e,
          companies: await job
            .find({
              profileId: e._id.toString(),
            })
            .toArray(),
        };
      })
    );

    let hasNext = false;
    let nextCursor = null;
    let data = getCompaniesLikedToJobProfile;

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

// module.exports.createAJob = async (req, res) => {
//   const { placements, job } = connectTodb(req.tenantDB);
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });

//   try {
//     const { orgId } = req;
//     const { profileId } = req.params;
//     const payload = { ...req.body };
//     const { colleges } = req.body; // colleges array containing orgIds

//     let CovProId = profileId;
//     let findProfile = {};

//     if (payload.type !== "company") {
//       CovProId = new ObjectId(profileId);
//       findProfile = await placements.findOne({ _id: CovProId });

//       if (!findProfile) throw new Error("Please select valid profile");
//     }

//     if (payload.type == "company") payload.status = "draft";

//     const creatingData = await job.insertOne({
//       ...req.body,
//       profileId,
//       status: "pending",
//       orgId,
//       createdAt: new Date().getTime(),
//     });

//     if (payload.type !== "company") {
//       await placements.updateOne(
//         { _id: CovProId },
//         {
//           $addToSet: {
//             jobs: {
//               id: creatingData?.insertedId?.toString(),
//               startDate: req.body.startDate,
//               endDate: req.body.endDate,
//             },
//           },
//         }
//       );
//     }

//     // Create assignedJob documents in each college's tenant DB
//     if (colleges && Array.isArray(colleges) && colleges.length > 0) {
//       for (const collegeOrgId of colleges) {
//         try {
//           const mainTenantDB = await getTenantDB(collegeOrgId);
//           const { assignedJob } = connectTodb(mainTenantDB);

//           await assignedJob.insertOne({
//             companyOrgId: orgId,
//             currOrgId: collegeOrgId,
//             jobId: creatingData.insertedId.toString(),
//             createdAt: new Date().getTime(),
//           });
//         } catch (dbError) {
//           console.error(
//             `Failed to create assignedJob for college ${collegeOrgId}:`,
//             dbError.message
//           );
//           // Continue with other colleges even if one fails
//         }
//       }
//     }

//     res.status(200).json({ msg: "Job Created Successfully", ...creatingData });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// };

module.exports.createAJob = async (req, res) => {
  const { placements, job } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    const { orgId } = req;
    const { profileId } = req.params;
    const payload = { ...req.body };
    const { colleges, access } = req.body;

    let CovProId = profileId;
    let findProfile = {};

    if (payload.type !== "company") {
      CovProId = new ObjectId(profileId);
      findProfile = await placements.findOne({ _id: CovProId });

      if (!findProfile) throw new Error("Please select valid profile");
    }

    if (payload.type == "company") payload.status = "draft";

    const creatingData = await job.insertOne({
      ...req.body,
      profileId,
      status: "active",
      orgId,
      createdAt: new Date().getTime(),
    });

    if (payload.type !== "company") {
      await placements.updateOne(
        { _id: CovProId },
        {
          $addToSet: {
            jobs: {
              id: creatingData?.insertedId?.toString(),
              startDate: req.body.startDate,
              endDate: req.body.endDate,
            },
          },
        }
      );

      // SEND NEW JOB NOTIFICATION
      if (access) {
        const jobNotificationData = {
          _id: creatingData.insertedId,
          title: req.body.jobTitle || req.body.role,
          role: req.body.role || req.body.jobTitle,
          companyName: req.body.companyName,
          company: req.body.companyName,
          location: req.body.location,
          ctc: req.body.ctc || req.body.salary,
          salary: req.body.salary || req.body.ctc,
          lastDate: req.body.lastDate || req.body.deadline,
          deadline: req.body.deadline || req.body.lastDate,
        };

        notifyJobPosting(orgId, req.tenantDB, jobNotificationData, access)
          .then((result) => {
            console.log(
              `✅ New job notification sent to students in org ${orgId}:`,
              result
            );
          })
          .catch((err) => {
            console.error(
              `❌ New job notification failed for org ${orgId}:`,
              err
            );
          });
      }
    }

    // Create assignedJob documents in each college's tenant DB
    if (colleges && Array.isArray(colleges) && colleges.length > 0) {
      for (const collegeOrgId of colleges) {
        try {
          const mainTenantDB = await getTenantDB(collegeOrgId);
          const { assignedJob } = connectTodb(mainTenantDB);

          await assignedJob.insertOne({
            companyOrgId: orgId,
            currOrgId: collegeOrgId,
            jobId: creatingData.insertedId.toString(),
            createdAt: new Date().getTime(),
          });
        } catch (dbError) {
          console.error(
            `Failed to create assignedJob for college ${collegeOrgId}:`,
            dbError.message
          );
        }
      }
    }

    res.status(200).json({ msg: "Job Created Successfully", ...creatingData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.setJobStatus = async (req, res) => {
  const { job } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { jobId, status } = req.query;

    const findJob = await job.findOne({ _id: new ObjectId(jobId) });

    if (!findJob)
      throw new Error("Please select a valid job to set as " + status);

    const updatedJob = await job.updateOne(
      { _id: findJob._id },
      {
        $set: {
          status: status,
        },
      }
    );

    res
      .status(200)
      .json({ msg: "Job status updated successfully", data: updatedJob });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// module.exports.updateAJob = async (req, res) => {
//   const { job } = connectTodb(req.tenantDB);
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });

//   try {
//     const { jobId } = req.params;

//     const findJob = await job.findOne({
//       _id: new ObjectId(jobId),
//     });

//     if (!findJob) throw new Error("Please select a valid job");

//     const updatedData = await job.updateOne(
//       { _id: findJob._id },
//       {
//         $set: {
//           ...req.body,
//           updatedAt: new Date().getTime(),
//         },
//       }
//     );

//     // Assigning part: update or upsert in assignedJob for each college
//     const { colleges } = req.body;
//     const orgId = req.orgId; // assuming orgId is available on req

//     if (colleges && Array.isArray(colleges) && colleges.length > 0) {
//       for (const collegeOrgId of colleges) {
//         try {
//           const mainTenantDB = await getTenantDB(collegeOrgId);
//           const { assignedJob } = connectTodb(mainTenantDB);

//           // Upsert document in assignedJob collection
//           await assignedJob.updateOne(
//             { jobId: jobId }, // Match by jobId
//             {
//               $set: {
//                 companyOrgId: orgId,
//                 currOrgId: collegeOrgId,
//                 jobId: jobId,
//                 updatedAt: new Date().getTime(),
//               },
//             },
//             { upsert: true }
//           );
//         } catch (dbError) {
//           console.error(
//             `Failed to update assignedJob for college ${collegeOrgId}:`,
//             dbError.message
//           );
//         }
//       }
//     }

//     res
//       .status(200)
//       .json({ msg: "Job Details Updated successfully", data: updatedData });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// };

module.exports.updateAJob = async (req, res) => {
  const { job } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    const { jobId } = req.params;
    const { colleges, access } = req.body;
    const orgId = req.orgId;

    const findJob = await job.findOne({
      _id: new ObjectId(jobId),
    });

    if (!findJob) throw new Error("Please select a valid job");

    const updatedData = await job.updateOne(
      { _id: findJob._id },
      {
        $set: {
          ...req.body,
          updatedAt: new Date().getTime(),
        },
      }
    );

    // Get updated job data for notification
    const updatedJob = await job.findOne({ _id: findJob._id });

    // SEND JOB UPDATE NOTIFICATION (TPO side)
    if (findJob?.type !== "company" || !findJob?.type) {
      if (findJob?.access || access) {
        const jobNotificationData = {
          _id: findJob._id,
          title: updatedJob?.jobTitle || updatedJob?.role,
          role: updatedJob?.role || updatedJob?.jobTitle,
          companyName: updatedJob.companyName,
          company: updatedJob.companyName,
          location: updatedJob.location,
          ctc: updatedJob.ctc || updatedJob.salary,
          salary: updatedJob.salary || updatedJob.ctc,
          lastDate: updatedJob.lastDate || updatedJob.deadline,
          deadline: updatedJob.deadline || updatedJob.lastDate,
        };

        notifyJobUpdate(
          orgId,
          req.tenantDB,
          jobNotificationData,
          access || findJob?.access
        )
          .then((result) => {
            console.log(
              `✅ Job update notification sent to students in org ${orgId}:`,
              result
            );
          })
          .catch((err) => {
            console.error(
              `❌ Job update notification failed for org ${orgId}:`,
              err
            );
          });
      }
    }

    // Update assignedJob for each college
    if (colleges && Array.isArray(colleges) && colleges.length > 0) {
      for (const collegeOrgId of colleges) {
        try {
          const mainTenantDB = await getTenantDB(collegeOrgId);
          const { assignedJob } = connectTodb(mainTenantDB);

          await assignedJob.updateOne(
            { jobId: jobId },
            {
              $set: {
                companyOrgId: orgId,
                currOrgId: collegeOrgId,
                jobId: jobId,
                updatedAt: new Date().getTime(),
              },
            },
            { upsert: true }
          );
        } catch (dbError) {
          console.error(
            `Failed to update assignedJob for college ${collegeOrgId}:`,
            dbError.message
          );
        }
      }
    }

    res
      .status(200)
      .json({ msg: "Job Details Updated successfully", data: updatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

const convertToMid = (id) => {
  try {
    return new ObjectId(id);
  } catch (error) {
    return id;
  }
};

// module.exports.getOneJob = async (req, res) => {
//   const { job, student } = connectTodb(req.tenantDB);
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });
//   try {
//     const { jobId } = req.params;

//     const findJob = await job.findOne({
//       _id: convertToMid(jobId),
//     });

//     if (!findJob) throw new Error("Please select a valid job");

//     let studentData = [];
//     if (findJob.applicants && findJob.applicants.length > 0) {
//       studentData = await Promise.all(
//         findJob.applicants.map(async (e) => {
//           return await student.findOne({
//             _id: new ObjectId(e),
//           });
//         })
//       );
//     }

//     res.status(200).json({
//       data: {
//         ...findJob,
//         applicants: studentData?.map((e) => {
//           const payload = {
//             enrollementId: e?.enrollementId,
//             firstName: e?.firstName,
//             lastName: e?.lastName,
//             middleName: e?.middleName,
//             userName: e?.userName,
//             email: e?.email,
//             _id: e?._id,
//             department: e?.department || "",
//           };
//           return payload;
//         }),
//       },
//     });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// };

module.exports.getOneJob = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { job, student, assignedJob } = connectTodb(req.tenantDB);

  try {
    const { jobId } = req.params;
    if (jobId === "undefined" || jobId === "null" || !jobId) {
      return res.status(200).json({ error: "Invalid job ID", data: null });
    }
    const { orgId } = req;

    let findJob = null;
    let isAssignedJob = false;

    // Try local jobs first
    findJob = await job.findOne({
      _id: convertToMid(jobId),
    });

    // If not found locally, check assignedJob collection
    if (!findJob) {
      const assignedJobDoc = await assignedJob.findOne({ jobId });
      if (assignedJobDoc) {
        const mainTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
        const { job: companyJob } = connectTodb(mainTenantDB);
        findJob = await companyJob.findOne({
          _id: new ObjectId(jobId),
        });
        isAssignedJob = true;
      }
    }

    if (!findJob) throw new Error("Please select a valid job");

    // Get colleges array from the found job document
    const { colleges = [] } = findJob;

    // Fetch student data from all organizations
    let studentData = [];
    if (findJob.applicants && findJob.applicants.length > 0) {
      // Get students from local DB first
      const localStudents = await student
        .find({
          _id: { $in: findJob.applicants.map((id) => new ObjectId(id)) },
        })
        .toArray();

      const localStudentIds = localStudents.map((s) => s._id.toString());
      studentData.push(...localStudents);

      // Find remaining applicant IDs not found locally
      let remainingApplicantIds = findJob.applicants.filter(
        (id) => !localStudentIds.includes(id)
      );

      // Search for remaining students in colleges organizations
      for (const collegeOrgId of colleges) {
        if (remainingApplicantIds.length === 0) break;

        try {
          const collegeOrgIdDb = await getTenantDB(collegeOrgId);
          const { student: extStudentCollection } = connectTodb(collegeOrgIdDb);
          const extStudents = await extStudentCollection
            .find({
              _id: { $in: remainingApplicantIds.map((id) => new ObjectId(id)) },
            })
            .toArray();

          if (extStudents.length > 0) {
            studentData.push(...extStudents);

            // Remove found student IDs from remaining list
            const foundIds = extStudents.map((s) => s._id.toString());
            remainingApplicantIds = remainingApplicantIds.filter(
              (id) => !foundIds.includes(id)
            );
          }
        } catch (error) {
          console.error(
            `Failed to fetch students from org ${collegeOrgId}:`,
            error.message
          );
        }
      }
    }

    res.status(200).json({
      data: {
        ...findJob,
        isAssignedJob,
        applicants: studentData.filter(Boolean).map((e) => ({
          enrollementId: e?.enrollementId,
          firstName: e?.firstName,
          lastName: e?.lastName,
          middleName: e?.middleName,
          userName: e?.userName,
          email: e?.email,
          _id: e?._id,
          department: e?.department || "",
        })),
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// module.exports.getAllJobsBasedOnplacements = async (req, res) => {
//   const { job } = connectTodb(req.tenantDB);
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });
//   try {
//     let { limit, cursor, profileId } = req.query;
//     limit = parseInt(limit, 10);

//     // 1. Validate inputs
//     if (!ObjectId.isValid(profileId)) {
//       return res.status(400).json({ err: "Invalid profileId" });
//     }
//     if (isNaN(limit) || limit <= 0) {
//       return res.status(400).json({ err: "limit must be a positive integer" });
//     }
//     const profileObjectId = new ObjectId(profileId);

//     // 2. Build the base match stage
//     const baseMatch = { profileId };

//     // 3. Build the aggregation for your page of docs
//     const docsPipeline = [
//       { $match: baseMatch },
//       // apply cursor filtering if given
//       ...(cursor && cursor !== "null"
//         ? [{ $match: { _id: { $gt: new ObjectId(cursor) } } }]
//         : []),
//       { $sort: { _id: 1 } },
//       { $limit: limit + 1 }, // grab one extra doc for hasNext
//       { $project: { __v: 0 } }, // strip out anything you don’t want
//     ];
//     const docs = await job.aggregate(docsPipeline).toArray();

//     // 4. Build the aggregation to count all matching docs
//     const countPipeline = [{ $match: baseMatch }, { $count: "count" }];

//     const countResult = await job.aggregate(countPipeline).toArray();
//     const totalLength = countResult[0]?.count || 0;

//     // 5. Compute pagination metadata
//     const hasNext = docs.length > limit;
//     const data = hasNext ? docs.slice(0, limit) : docs;
//     const nextCursor = hasNext ? data[data.length - 1]._id : null;

//     // 6. Return the response
//     return res.status(200).json({
//       success: true,
//       hasNext,
//       nextCursor,
//       totalLength,
//       data,
//     });
//   } catch (error) {
//     console.error("Error in getAllJobsBasedOnplacements:", error);
//     return res.status(500).json({ err: error.message });
//   }
// };

module.exports.getAllJobsBasedOnplacements = async (req, res) => {
  const { job, assignedJob } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    let { limit, cursor, profileId } = req.query;
    limit = parseInt(limit, 10);

    if (!ObjectId.isValid(profileId)) {
      return res.status(400).json({ err: "Invalid profileId" });
    }
    if (isNaN(limit) || limit <= 0) {
      return res.status(400).json({ err: "limit must be a positive integer" });
    }

    // Get local jobs
    const baseMatch = { profileId };
    const docsPipeline = [
      { $match: baseMatch },
      ...(cursor && cursor !== "null"
        ? [{ $match: { _id: { $gt: new ObjectId(cursor) } } }]
        : []),
      { $sort: { _id: 1 } },
      { $limit: limit + 1 },
      { $project: { __v: 0 } },
    ];

    const localJobs = await job.aggregate(docsPipeline).toArray();

    // Get assigned jobs and fetch actual job details
    const assignedJobs = await assignedJob.find({}).toArray();
    const assignedJobDetails = [];

    for (const assignedJobDoc of assignedJobs) {
      try {
        const mainTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
        const { job: companyJob } = connectTodb(mainTenantDB);
        const jobDetail = await companyJob.findOne({
          _id: new ObjectId(assignedJobDoc.jobId),
          profileId,
        });
        if (jobDetail) {
          assignedJobDetails.push({
            ...jobDetail,
            isAssignedJob: true,
            companyOrgId: assignedJobDoc.companyOrgId,
          });
        }
      } catch (error) {
        console.error(
          `Error fetching assigned job ${assignedJobDoc.jobId}:`,
          error
        );
      }
    }

    // Combine and sort all jobs
    const allJobs = [
      ...localJobs.map((job) => ({ ...job, isAssignedJob: false })),
      ...assignedJobDetails,
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const hasNext = allJobs.length > limit;
    const data = hasNext ? allJobs.slice(0, limit) : allJobs;
    const nextCursor = hasNext ? data[data.length - 1]._id : null;

    return res.status(200).json({
      success: true,
      hasNext,
      nextCursor,
      totalLength: allJobs.length,
      data,
    });
  } catch (error) {
    console.error("Error in getAllJobsBasedOnplacements:", error);
    return res.status(500).json({ err: error.message });
  }
};

// module.exports.getAllJobs = async (req, res) => {
//   const { job, assignedJob } = connectTodb(req.tenantDB);
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });

//   try {
//     let { page = 1, limit = 20, sort = null, ...filters } = req.query;

//     page = parseInt(page, 10);
//     limit = parseInt(limit, 10);

//     if (isNaN(page) || page < 1) page = 1;
//     if (isNaN(limit) || limit < 1) limit = 20;

//     // Get local jobs
//     const matchStage = {};
//     for (let key in filters) {
//       if (filters[key] === "") continue;
//       matchStage[key] = { $regex: filters[key], $options: "i" };
//     }

//     const localJobs = await job.find(matchStage).toArray();

//     // Try to get assigned jobs, but handle case where collection doesn't exist
//     let assignedJobs = [];
//     try {
//       assignedJobs = await assignedJob.find({}).toArray();
//     } catch (error) {
//       // assignedJob collection doesn't exist or is inaccessible
//       console.warn('assignedJob collection not found or inaccessible:', error.message);
//       assignedJobs = [];
//     }

//     const assignedJobDetails = [];

//     for (const assignedJobDoc of assignedJobs) {
//       try {
//         const mainTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
//         const { job: companyJob } = connectTodb(mainTenantDB);
//         const jobDetail = await companyJob.findOne({
//           _id: new ObjectId(assignedJobDoc.jobId),
//         });
//         if (jobDetail) {
//           // Apply filters to assigned jobs too
//           let matchesFilter = true;
//           for (let key in filters) {
//             if (filters[key] !== "" && jobDetail[key]) {
//               const regex = new RegExp(filters[key], "i");
//               if (!regex.test(jobDetail[key])) {
//                 matchesFilter = false;
//                 break;
//               }
//             }
//           }
//           if (matchesFilter) {
//             assignedJobDetails.push({
//               ...jobDetail,
//               isAssignedJob: true,
//               companyOrgId: assignedJobDoc.companyOrgId,
//             });
//           }
//         }
//       } catch (error) {
//         console.error(
//           `Error fetching assigned job ${assignedJobDoc.jobId}:`,
//           error.message
//         );
//       }
//     }

//     // Combine all jobs
//     const allJobs = [
//       ...localJobs.map((job) => ({ ...job, isAssignedJob: false })),
//       ...assignedJobDetails,
//     ];

//     // Sort
//     const sortField = sort || "_id";
//     allJobs.sort((a, b) => {
//       if (sortField === "_id") {
//         return new Date(b.createdAt) - new Date(a.createdAt);
//       }
//       return b[sortField] > a[sortField] ? 1 : -1;
//     });

//     // Pagination
//     const skip = (page - 1) * limit;
//     const paginatedJobs = allJobs.slice(skip, skip + limit);

//     const totalDocs = allJobs.length;
//     const totalPages = Math.ceil(totalDocs / limit);

//     res.status(200).json({
//       data: paginatedJobs,
//       pagination: {
//         totalDocs,
//         totalPages,
//         currentPage: page,
//         limit,
//       },
//     });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ err: error.message });
//   }
// };

// module.exports.getAllJobs = async (req, res) => {
//   const { job, assignedJob } = connectTodb(req.tenantDB);
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });

//   try {
//     let {
//       page = 1,
//       limit = 20,
//       sort = null,
//       search = "",
//       cursor = null,
//       ...filters
//     } = req.query;

//     page = parseInt(page, 10);
//     limit = parseInt(limit, 10);

//     if (isNaN(page) || page < 1) page = 1;
//     if (isNaN(limit) || limit < 1) limit = 20;

//     // Get local jobs
//     const matchStage = {};
//     if (search && search.trim() !== "") {
//       matchStage.$or = [
//         { companyName: { $regex: search.trim(), $options: "i" } },
//         { jobTitle: { $regex: search.trim(), $options: "i" } },
//         { city: { $regex: search.trim(), $options: "i" } },
//         { street: { $regex: search.trim(), $options: "i" } },
//         { jobType: { $regex: search.trim(), $options: "i" } },
//         { coordinatorName: { $regex: search.trim(), $options: "i" } },
//       ];
//     }
//     for (let key in filters) {
//       if (filters[key] === "") continue;
//       matchStage[key] = { $regex: filters[key], $options: "i" };
//     }

//     const localJobs = await job.find(matchStage).toArray();

//     // Get assigned jobs
//     let assignedJobs = [];
//     try {
//       assignedJobs = await assignedJob.find({}).toArray();
//     } catch (error) {
//       console.warn(
//         "assignedJob collection not found or inaccessible:",
//         error.message
//       );
//       assignedJobs = [];
//     }

//     const assignedJobDetails = [];

//     for (const assignedJobDoc of assignedJobs) {
//       try {
//         const mainTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
//         const { job: companyJob } = connectTodb(mainTenantDB);
//         const jobDetail = await companyJob.findOne({
//           _id: new ObjectId(assignedJobDoc.jobId),
//         });
//         if (jobDetail) {
//           // Apply filters to assigned jobs too
//           let matchesFilter = true;
//           for (let key in filters) {
//             if (filters[key] !== "" && jobDetail[key]) {
//               const regex = new RegExp(filters[key], "i");
//               if (!regex.test(jobDetail[key])) {
//                 matchesFilter = false;
//                 break;
//               }
//             }
//           }
//           if (matchesFilter) {
//             assignedJobDetails.push({
//               ...jobDetail,
//               isAssignedJob: true,
//               companyOrgId: assignedJobDoc.companyOrgId,
//             });
//           }
//         }
//       } catch (error) {
//         console.error(
//           `Error fetching assigned job ${assignedJobDoc.jobId}:`,
//           error.message
//         );
//       }
//     }

//     // Combine all jobs
//     const allJobs = [
//       ...localJobs.map((job) => ({ ...job, isAssignedJob: false })),
//       ...assignedJobDetails,
//     ];

//     // Collect all unique organization IDs from jobs
//     const orgIds = new Set();

//     for (const jobItem of allJobs) {
//       // Add organization IDs from colleges array
//       if (jobItem.colleges && Array.isArray(jobItem.colleges)) {
//         jobItem.colleges.forEach((collegeId) => orgIds.add(collegeId));
//       }
//       // Add companyOrgId for assigned jobs
//       if (jobItem.companyOrgId) {
//         orgIds.add(jobItem.companyOrgId);
//       }
//     }

//     // Fetch organization details from global database
//     let orgDetailsMap = {};
//     if (orgIds.size > 0) {
//       try {
//         // Convert orgIds to match your orgId format (string-based search)
//         const orgIdArray = [...orgIds];
//         const organizationDetails = await organisation
//           .find({
//             orgId: { $in: orgIdArray },
//           })
//           .toArray();

//         // Create a map of orgId to organization details
//         organizationDetails.forEach((org) => {
//           orgDetailsMap[org.orgId] = {
//             name: org.orgName || "Unknown Organization",
//             type: org.type || "college",
//             email: org.email,
//             taxInfo: org.taxInfo,
//           };
//         });
//       } catch (error) {
//         console.error("Error fetching organization details:", error.message);
//       }
//     }

//     // Add college names to jobs
//     const jobsWithCollegeNames = allJobs.map((jobItem) => {
//       const jobWithColleges = { ...jobItem };

//       if (jobItem.colleges && Array.isArray(jobItem.colleges)) {
//         jobWithColleges.collegesDetails = jobItem.colleges.map((collegeId) => ({
//           orgId: collegeId,
//           name: orgDetailsMap[collegeId]?.name || "Unknown College",
//           type: orgDetailsMap[collegeId]?.type || "college",
//           email: orgDetailsMap[collegeId]?.email,
//         }));
//       }

//       // Add company organization details for assigned jobs
//       if (jobItem.companyOrgId) {
//         jobWithColleges.companyDetails = {
//           orgId: jobItem.companyOrgId,
//           name: orgDetailsMap[jobItem.companyOrgId]?.name || "Unknown Company",
//           type: orgDetailsMap[jobItem.companyOrgId]?.type || "company",
//           email: orgDetailsMap[jobItem.companyOrgId]?.email,
//         };
//       }

//       return jobWithColleges;
//     });

//     // Sort - FIXED: Use correct variable name
//     const sortField = sort || "_id";
//     jobsWithCollegeNames.sort((a, b) => {
//       if (sortField === "_id") {
//         return new Date(b.createdAt) - new Date(a.createdAt);
//       }
//       return b[sortField] > a[sortField] ? 1 : -1;
//     });

//     // Pagination - FIXED: Use correct variable name
//     const skip = (page - 1) * limit;
//     const paginatedJobs = jobsWithCollegeNames.slice(skip, skip + limit);

//     const totalDocs = jobsWithCollegeNames.length;
//     const totalPages = Math.ceil(totalDocs / limit);

//     res.status(200).json({
//       data: paginatedJobs,
//       pagination: {
//         totalDocs,
//         totalPages,
//         currentPage: page,
//         limit,
//       },
//     });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ err: error.message });
//   }
// };
module.exports.getAllJobs = async (req, res) => {
  const { job, assignedJob } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    let {
      page = 1,
      limit = 20,
      sort = null,
      search = "",
      ...filters
    } = req.query;

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    if (isNaN(page) || page < 1) page = 1;
    if (isNaN(limit) || limit < 1) limit = 20;

    console.log("Query params:", { search, filters, page, limit });

    // Define searchable fields for the search parameter
    const searchableFields = [
      "jobTitle",
      "companyName",
      "city",
      "street",
      "jobType",
      "coordinatorName",
      "coordinatorEmail",
      "sector",
    ];

    // Helper function to check if job matches search term
    const matchesSearch = (jobDoc) => {
      // If no search term, always return true
      if (!search || search.trim() === "") return true;

      const searchTerm = search.trim();
      const searchRegex = new RegExp(searchTerm, "i");

      return searchableFields.some((field) => {
        const value = jobDoc[field];
        if (value === undefined || value === null) return false;

        // Handle arrays
        if (Array.isArray(value)) {
          return value.some((item) => searchRegex.test(String(item)));
        }

        // Handle strings and other types
        return searchRegex.test(String(value));
      });
    };

    // Helper function to check if job matches specific field filters
    const matchesFilters = (jobDoc) => {
      // If no filters, always return true
      if (Object.keys(filters).length === 0) return true;

      for (let key in filters) {
        if (
          filters[key] === "" ||
          filters[key] === null ||
          filters[key] === undefined
        ) {
          continue;
        }

        const jobValue = jobDoc[key];
        if (jobValue === undefined || jobValue === null) return false;

        const filterRegex = new RegExp(filters[key], "i");

        // Handle arrays
        if (Array.isArray(jobValue)) {
          const matches = jobValue.some((item) =>
            filterRegex.test(String(item))
          );
          if (!matches) return false;
        } else {
          // Handle strings and other types
          if (!filterRegex.test(String(jobValue))) return false;
        }
      }
      return true;
    };

    // Build MongoDB query for local jobs
    const matchStage = {};

    // Add search query using $or for multiple fields
    if (search && search.trim() !== "") {
      matchStage.$or = searchableFields.map((field) => ({
        [field]: { $regex: search.trim(), $options: "i" },
      }));
    }

    // Add specific field filters
    for (let key in filters) {
      if (
        filters[key] === "" ||
        filters[key] === null ||
        filters[key] === undefined
      ) {
        continue;
      }
      matchStage[key] = { $regex: filters[key], $options: "i" };
    }

    console.log("MongoDB matchStage:", JSON.stringify(matchStage, null, 2));

    // Get local jobs with MongoDB filtering
    const localJobs = await job.find(matchStage).toArray();
    console.log("Local jobs found:", localJobs.length);

    // Get assigned jobs
    let assignedJobs = [];
    try {
      assignedJobs = await assignedJob.find({}).toArray();
      console.log("Assigned job references found:", assignedJobs.length);
    } catch (error) {
      console.warn(
        "assignedJob collection not found or inaccessible:",
        error.message
      );
      assignedJobs = [];
    }

    const assignedJobDetails = [];

    // Fetch and filter assigned jobs
    for (const assignedJobDoc of assignedJobs) {
      try {
        const mainTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
        const { job: companyJob } = connectTodb(mainTenantDB);
        const jobDetail = await companyJob.findOne({
          _id: new ObjectId(assignedJobDoc.jobId),
        });

        if (!jobDetail) {
          console.log(`Job ${assignedJobDoc.jobId} not found in company DB`);
          continue;
        }

        // Apply both search and filters to assigned jobs
        const searchMatch = matchesSearch(jobDetail);
        const filterMatch = matchesFilters(jobDetail);

        console.log(
          `Job ${assignedJobDoc.jobId}: searchMatch=${searchMatch}, filterMatch=${filterMatch}`
        );

        if (searchMatch && filterMatch) {
          assignedJobDetails.push({
            ...jobDetail,
            isAssignedJob: true,
            companyOrgId: assignedJobDoc.companyOrgId,
          });
        }
      } catch (error) {
        console.error(
          `Error fetching assigned job ${assignedJobDoc.jobId}:`,
          error.message
        );
      }
    }

    console.log("Assigned jobs after filtering:", assignedJobDetails.length);

    // Combine all jobs
    const allJobs = [
      ...localJobs.map((job) => ({ ...job, isAssignedJob: false })),
      ...assignedJobDetails,
    ];

    console.log("Total jobs before org details:", allJobs.length);

    // Collect all unique organization IDs from jobs
    const orgIds = new Set();

    for (const jobItem of allJobs) {
      // Add organization IDs from colleges array
      if (jobItem.colleges && Array.isArray(jobItem.colleges)) {
        jobItem.colleges.forEach((collegeId) => orgIds.add(collegeId));
      }
      // Add companyOrgId for assigned jobs
      if (jobItem.companyOrgId) {
        orgIds.add(jobItem.companyOrgId);
      }
    }

    // Fetch organization details from global database
    let orgDetailsMap = {};
    if (orgIds.size > 0) {
      try {
        const orgIdArray = [...orgIds];
        const organizationDetails = await organisation
          .find({
            orgId: { $in: orgIdArray },
          })
          .toArray();

        // Create a map of orgId to organization details
        organizationDetails.forEach((org) => {
          orgDetailsMap[org.orgId] = {
            name: org.orgName || "Unknown Organization",
            type: org.type || "college",
            email: org.email,
            taxInfo: org.taxInfo,
          };
        });
      } catch (error) {
        console.error("Error fetching organization details:", error.message);
      }
    }

    // Add college names and company details to jobs
    const jobsWithCollegeNames = allJobs.map((jobItem) => {
      const jobWithColleges = { ...jobItem };

      if (jobItem.colleges && Array.isArray(jobItem.colleges)) {
        jobWithColleges.collegesDetails = jobItem.colleges.map((collegeId) => ({
          orgId: collegeId,
          name: orgDetailsMap[collegeId]?.name || "Unknown College",
          type: orgDetailsMap[collegeId]?.type || "college",
          email: orgDetailsMap[collegeId]?.email,
        }));
      }

      // Add company organization details for assigned jobs
      if (jobItem.companyOrgId) {
        jobWithColleges.companyDetails = {
          orgId: jobItem.companyOrgId,
          name: orgDetailsMap[jobItem.companyOrgId]?.name || "Unknown Company",
          type: orgDetailsMap[jobItem.companyOrgId]?.type || "company",
          email: orgDetailsMap[jobItem.companyOrgId]?.email,
        };
      }

      return jobWithColleges;
    });

    // Sort
    const sortField = sort || "_id";
    jobsWithCollegeNames.sort((a, b) => {
      if (sortField === "_id") {
        return new Date(b.createdAt) - new Date(a.createdAt);
      }

      const aVal = a[sortField];
      const bVal = b[sortField];

      // Handle null/undefined
      if (aVal === undefined || aVal === null) return 1;
      if (bVal === undefined || bVal === null) return -1;

      // Numeric comparison
      if (typeof aVal === "number" && typeof bVal === "number") {
        return bVal - aVal; // Descending
      }

      // String comparison (descending)
      return String(bVal).localeCompare(String(aVal));
    });

    // Pagination
    const skip = (page - 1) * limit;
    const paginatedJobs = jobsWithCollegeNames.slice(skip, skip + limit);

    const totalDocs = jobsWithCollegeNames.length;
    const totalPages = Math.ceil(totalDocs / limit);

    console.log("Final result:", {
      totalDocs,
      paginatedJobs: paginatedJobs.length,
    });

    res.status(200).json({
      data: paginatedJobs,
      pagination: {
        totalDocs,
        totalPages,
        currentPage: page,
        limit,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ err: error.message });
  }
};

module.exports.applyJob = async (req, res) => {
  const { job, student, assignedJob } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    const { jobId, studentId } = req.query;
    const { orgId } = req; // Current organization ID

    let findJob = null;
    let isAssignedJob = false;
    let targetJobCollection = job;

    // First check if it's a local job
    findJob = await job.findOne({
      _id: new ObjectId(jobId),
    });

    // If not found locally, check if it's an assigned job
    if (!findJob) {
      const assignedJobDoc = await assignedJob.findOne({ jobId });
      if (assignedJobDoc) {
        // Connect to company's DB to get the actual job
        const mainTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
        const { job: companyJob } = connectTodb(mainTenantDB);
        findJob = await companyJob.findOne({
          _id: new ObjectId(jobId),
        });
        isAssignedJob = true;
        targetJobCollection = companyJob;
      }
    }

    if (!findJob) throw new Error("Please select a valid job to apply");

    const findStudent = await student.findOne({
      _id: new ObjectId(studentId),
    });
    if (!findStudent) throw new Error("Please select a valid student to apply");

    // Update the job (either local or in company's DB)
    const jobUpdatedData = await targetJobCollection.updateOne(
      { _id: findJob._id },
      { $addToSet: { applicants: studentId } }
    );

    // Always update student in local DB
    const studentUpdatedData = await student.updateOne(
      { _id: findStudent._id, "appliedJobs.id": { $ne: jobId } },
      {
        $addToSet: {
          appliedJobs: {
            id: jobId,
            createdAt: new Date().getTime(),
            isAssignedJob: isAssignedJob,
          },
        },
      }
    );

    // If it's an assigned job, you might want to create an application record
    // in the company's DB as well for tracking
    if (isAssignedJob) {
      try {
        const assignedJobDoc = await assignedJob.findOne({ jobId });
        const { applications } = connectTodb(assignedJobDoc.companyOrgId);

        await applications.insertOne({
          jobId,
          studentId,
          studentOrgId: orgId,
          studentData: {
            enrollementId: findStudent.enrollementId,
            firstName: findStudent.firstName,
            lastName: findStudent.lastName,
            email: findStudent.email,
            department: findStudent.department,
          },
          appliedAt: new Date().getTime(),
          status: "applied",
        });
      } catch (error) {
        console.error(
          "Error creating application record in company DB:",
          error
        );
      }
    }

    res.status(200).json({
      msg: "Successfully applied to this job",
      jobData: findJob,
      isAssignedJob,
      jobUpdatedData,
      studentUpdatedData,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.createJobAssessment = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { job, jobAssessments } = connectTodb(req.tenantDB);

  try {
    const { jobId } = req.params;
    const { questionIds = [] } = req.body;

    const findJob = await job.findOne({ _id: new ObjectId(jobId) });
    if (!findJob) throw new Error("Please select a valid job");

    // const skillPromises = skills.map(({ skillId, difficulty, numQues }) =>
    //   questions
    //     .aggregate([
    //       {
    //         $match: {
    //           refId: skillId,
    //           difficulty,
    //         },
    //       },
    //       { $sample: { size: Number(numQues) } },
    //       { $project: { _id: 1 } },
    //     ])
    //     .toArray()
    // );

    // const questionLists = await Promise.all(skillPromises);
    // const questionIds = questionLists.flat().map((q) => q._id?.toString());

    const insertedData = await jobAssessments.insertOne({
      ...req.body,
      createdBy: req.userID,
      jobId: jobId,
      jobTitle: findJob.jobTitle,
      title: findJob.jobTitle,
      questionIds,
      createdAt: Date.now(),
    });

    await job.updateOne(
      { _id: findJob._id },
      {
        $set: {
          AssessmentId: insertedData.insertedId.toString(),
        },
      }
    );

    res.status(200).json({ data: insertedData });
  } catch (error) {
    console.log(error);

    res.status(500).json({ err: error.message });
  }
};
module.exports.updateJobAssessment = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { job, jobAssessments } = connectTodb(req.tenantDB);

  try {
    const { id } = req.params;
    const { questionIds } = req.body;

    const findJobAssessment = await jobAssessments.findOne({
      _id: new ObjectId(id),
    });

    if (!findJobAssessment)
      throw new Error("Please select a valid jobAssessment");

    let updateData = { ...req.body };

    // if (skills && Array.isArray(skills) && skills.length > 0) {
    //   const existingSkills = findJobAssessment.skills || [];

    //   const skillsChanged = hasSkillsChanged(existingSkills, skills);

    //   if (skillsChanged) {

    //     const skillPromises = skills.map(({ skillId, difficulty, numQues }) =>
    //       questions
    //         .aggregate([
    //           {
    //             $match: {
    //               refId: skillId,
    //               difficulty,
    //             },
    //           },
    //           { $sample: { size: Number(numQues) } },
    //           { $project: { _id: 1 } },
    //         ])
    //         .toArray()
    //     );

    //     const questionLists = await Promise.all(skillPromises);
    //     const questionIds = questionLists.flat().map((q) => q._id?.toString());

    //     updateData.questionIds = questionIds;
    //   } else {
    //     console.log("Skills data unchanged, keeping existing questions");
    //     delete updateData.questionIds;
    //   }
    // } else {
    //   delete updateData.questionIds;
    // }

    // updateData.updatedAt = Date.now();

    const updatedData = await jobAssessments.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (updatedData.matchedCount === 0) {
      throw new Error("Assessment not found");
    }

    res.status(200).json({
      message: "Assessment updated successfully",
      data: updatedData,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

function hasSkillsChanged(existingSkills, newSkills) {
  if (existingSkills.length !== newSkills.length) {
    return true;
  }

  const sortedExisting = [...existingSkills].sort((a, b) =>
    a.skillId.localeCompare(b.skillId)
  );
  const sortedNew = [...newSkills].sort((a, b) =>
    a.skillId.localeCompare(b.skillId)
  );

  for (let i = 0; i < sortedExisting.length; i++) {
    const existing = sortedExisting[i];
    const newSkill = sortedNew[i];

    if (
      existing.skillId !== newSkill.skillId ||
      existing.difficulty !== newSkill.difficulty ||
      existing.numQues !== newSkill.numQues
    ) {
      return true;
    }
  }

  return false;
}

module.exports.getOneJobAssessment = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { jobAssessments } = connectTodb(req.tenantDB);

  try {
    const { id } = req.params;

    const findJobAssessment = await jobAssessments.findOne({
      _id: new ObjectId(id),
    });

    if (!findJobAssessment)
      throw new Error("Please select a valid jobAssessment");

    let responseData = { ...findJobAssessment };

    if (
      findJobAssessment.questionIds &&
      findJobAssessment.questionIds.length > 0
    ) {
      const questionsData = await questions
        .find({
          _id: {
            $in: findJobAssessment.questionIds?.map((q) => new ObjectId(q)),
          },
        })
        .toArray();

      responseData.questionsData = questionsData;
    } else {
      responseData.questionsData = [];
    }

    res.status(200).json({
      data: responseData,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// module.exports.getAllJobAssessment = async (req, res) => {
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });

//   const { jobAssessments } = connectTodb(req.tenantDB);

//   try {
//     // Extract pagination parameters
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 10;
//     const skip = (page - 1) * limit;

//     // Get total count
//     const totalCount = await jobAssessments.countDocuments({});

//     // Get assessments with questions
//     const assessmentsWithQuestions = await jobAssessments
//       .aggregate([
//         {
//           $lookup: {
//             from: "questions",
//             localField: "questionIds",
//             foreignField: "_id",
//             as: "questionsData",
//           },
//         },
//         {
//           $sort: { createdAt: -1 },
//         },
//         {
//           $skip: skip,
//         },
//         {
//           $limit: limit,
//         },
//       ])
//       .toArray();

//     res.status(200).json({
//       data: assessmentsWithQuestions,
//       pagination: {
//         currentPage: page,
//         totalPages: Math.ceil(totalCount / limit),
//         totalCount,
//         limit,
//         hasNextPage: page < Math.ceil(totalCount / limit),
//         hasPrevPage: page > 1,
//       },
//       message: "Job assessments retrieved successfully",
//     });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// };
module.exports.getAllJobAssessment = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  // Connect to tenant DB collections
  const { jobAssessments } = connectTodb(req.tenantDB);

  try {
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Get total count
    const totalCount = await jobAssessments.countDocuments({});

    // Fetch paginated assessments
    const assessments = await jobAssessments
      .find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // Extract all unique skill IDs from assessments
    // const allSkillIds = [
    //   ...new Set(
    //     assessments.flatMap((a) => a.skills?.map((s) => s.skillId.toString()))
    //   ),
    // ];

    // // Fetch skill details from skills DB
    // const skillsData = await skillsCollection
    //   .find({ _id: { $in: allSkillIds.map((id) => new ObjectId(id)) } })
    //   .toArray();

    // // Merge skills into assessments
    // console.log(assessments[0])
    // const assessmentsWithSkills = assessments.map((a) => ({

    //   ...a,
    //   skillsData: a.skills.map((s) => {
    //     const match = skillsData.find(
    //       (sk) => sk._id.toString() === s.skillId.toString()
    //     );
    //     return {
    //       ...s,
    //       ...(match || null),
    //     };
    //   }),
    // }));

    res.status(200).json({
      data: assessments,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        totalCount,
        limit,
        hasNextPage: page < Math.ceil(totalCount / limit),
        hasPrevPage: page > 1,
      },
      message: "Job assessments retrieved successfully",
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({ err: error.message });
  }
};

// module.exports.getAssignedAssessments = async (req, res) => {
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });

//   const { job, assignedJob, jobAssessments, student } = connectTodb(req.tenantDB);
//   const userId = req.userID;
//   const { orgId } = req;

//   try {
//     // Get student record (by globalId)
//     const studentDoc = await student.findOne({ globalId: userId });
//     if (!studentDoc || !studentDoc.appliedJobs || studentDoc.appliedJobs.length === 0) {
//       return res.status(404).json({ error: 'No applied jobs found for this student' });
//     }

//     // Get all applied job IDs
//     const appliedJobIds = studentDoc.appliedJobs.map(job => job.id);
//     let allJobs = [];
//     const foundLocalJobIds = [];

//     // Attempt to find jobs in local collection
//     for (const jobId of appliedJobIds) {
//       try {
//         const jobDoc = await job.findOne({ _id: new ObjectId(jobId) });
//         if (jobDoc) {
//           allJobs.push({ ...jobDoc, _sourceOrg: 'local', _sourceOrgId: orgId });
//           foundLocalJobIds.push(jobId);
//         }
//       } catch {}
//     }

//     // Remaining jobs, to check in assignedJob
//     const remainingJobIds = appliedJobIds.filter(id => !foundLocalJobIds.includes(id));

//     // For external jobs, get job from external org/company
//     let assignedJobDocs = [];
//     if (remainingJobIds.length > 0) {
//       try {
//         assignedJobDocs = await assignedJob.find({ jobId: { $in: remainingJobIds } }).toArray();
//       } catch { assignedJobDocs = []; }
//       for (const assignedDoc of assignedJobDocs) {
//         try {
//           const mainTenantDB = await getTenantDB(assignedDoc.companyOrgId);
//           const { job: companyJob } = connectTodb(mainTenantDB);
//           const jobDetail = await companyJob.findOne({ _id: new ObjectId(assignedDoc.jobId) });
//           if (jobDetail) {
//             allJobs.push({ ...jobDetail, _sourceOrg: 'external', _sourceOrgId: assignedDoc.companyOrgId });
//           }
//         } catch {}
//       }
//     }

//     const orgAssessmentsMap = {};
//     for (const jobDoc of allJobs) {
//       if (jobDoc.AssessmentId) {
//         const orgId = jobDoc._sourceOrgId || req.orgId;
//         if (!orgAssessmentsMap[orgId]) orgAssessmentsMap[orgId] = [];
//         orgAssessmentsMap[orgId].push(jobDoc.AssessmentId.toString());
//       }
//     }

//     let allAssessments = [];
//     for (const [searchOrgId, assessmentIdArr] of Object.entries(orgAssessmentsMap)) {
//       if (!assessmentIdArr.length) continue;
//       const uniqueIds = Array.from(new Set(assessmentIdArr)).map(id => new ObjectId(id));

//       try {
//         let assessCollection;
//         if (searchOrgId === String(orgId)) {
//           assessCollection = jobAssessments;
//         } else {
//           const orgTenantDB = await getTenantDB(searchOrgId);
//           const collections = connectTodb(orgTenantDB);
//           assessCollection = collections.jobAssessments;
//         }

//         const assessments = await assessCollection.find({ _id: { $in: uniqueIds } }).toArray();

//         // For each assessment, aggregate skills data
//         for (const assessment of assessments) {
//           if (assessment.skills && Array.isArray(assessment.skills)) {
//             const skillIds = assessment.skills.map(s => new ObjectId(s.skillId));

//             try {
//               const skillsData = await skillsCollection.find({
//                 _id: { $in: skillIds }
//               }).toArray();

//               // Add skillsData to the assessment
//               assessment.skillsData = skillsData;
//             } catch (error) {
//               console.error(`Error fetching skills for assessment ${assessment._id}:`, error.message);
//               assessment.skillsData = [];
//             }
//           }
//         }

//         allAssessments.push(...assessments);
//       } catch (e) {
//         console.error(`Error fetching assessments from org ${searchOrgId}:`, e.message);
//       }
//     }

//     res.status(200).json({
//       data: allAssessments,
//       totalAssessments: allAssessments.length
//     });

//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// };

module.exports.addAssessmentToStudent = async (req, res) => {
  if (!req.tenantDB) {
    return res.status(500).json({ error: "No tenant DB available" });
  }

  const { jobId, assessmentId, studentIds } = req.body;
  if (!jobId || !assessmentId || !studentIds) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const studentIdList = Array.isArray(studentIds) ? studentIds : [studentIds];

  try {
    const localDB = req.tenantDB;
    const { job: localJob, assignedJob } = connectTodb(localDB);

    // Get job document to find associated colleges/organizations
    const jobObjectId = new ObjectId(jobId);
    const jobDoc = await localJob.findOne({ _id: jobObjectId });
    if (!jobDoc) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Get all organizations to search in
    let colleges = [];
    if (
      jobDoc &&
      Array.isArray(jobDoc.colleges) &&
      jobDoc.colleges.length > 0
    ) {
      colleges = jobDoc.colleges;
    } else {
      // Fallback: get organization IDs from assignedJob collection
      const assignedJobs = await assignedJob.find({ jobId: jobId }).toArray();
      colleges = assignedJobs.map((doc) => doc.companyOrgId);
    }

    // Always include current org
    if (!colleges.includes(req.orgId)) {
      colleges.unshift(req.orgId);
    }

    const results = [];
    const studentsToUpdate = []; // Track students found for assessment update

    // First pass: Find all students and track which org they're in
    for (const studentId of studentIdList) {
      const studentObjectId = new ObjectId(studentId);
      let studentFound = false;

      for (const orgId of colleges) {
        try {
          const tenantDB =
            orgId === req.orgId ? localDB : await getTenantDB(orgId);
          const { student } = connectTodb(tenantDB);

          const studentDoc = await student.findOne({ _id: studentObjectId });

          if (studentDoc) {
            studentFound = true;

            // Update student's appliedJobs
            if (
              !studentDoc.appliedJobs ||
              !Array.isArray(studentDoc.appliedJobs)
            ) {
              results.push({
                studentId,
                error: "No appliedJobs found",
                foundInOrg: orgId,
              });
              break;
            }

            // Find and update the specific job
            let jobFound = false;
            const updatedAppliedJobs = studentDoc.appliedJobs.map((job) => {
              if (job.id === jobId) {
                jobFound = true;
                const assessments = job.assessments || [];
                if (!assessments.includes(assessmentId)) {
                  return {
                    ...job,
                    assessments: [...assessments, assessmentId],
                  };
                }
              }
              return job;
            });

            if (!jobFound) {
              results.push({
                studentId,
                error: "Job not found in appliedJobs",
                foundInOrg: orgId,
              });
              break;
            }

            // Update student document
            await student.updateOne(
              { _id: studentObjectId },
              { $set: { appliedJobs: updatedAppliedJobs } }
            );

            // Track this student for assessment update
            studentsToUpdate.push(studentId);

            results.push({
              studentId,
              success: true,
              updatedInOrg: orgId,
            });

            break; // Student found and processed
          }
        } catch (error) {
          console.error(
            `Error processing student ${studentId} in org ${orgId}:`,
            error.message
          );
          continue;
        }
      }

      if (!studentFound) {
        results.push({
          studentId,
          error: "Student not found in any associated organization",
        });
      }
    }

    // Second pass: Update assessment with all found students
    // The assessment should be updated in each organization where it might exist
    if (studentsToUpdate.length > 0) {
      for (const orgId of colleges) {
        try {
          const tenantDB =
            orgId === req.orgId ? localDB : await getTenantDB(orgId);
          const { jobAssessments: assessment } = connectTodb(tenantDB);

          // Try to update assessment in this organization
          const assessmentUpdateResult = await assessment.updateOne(
            { _id: new ObjectId(assessmentId) },
            { $addToSet: { assignedStudents: { $each: studentsToUpdate } } }
          );

          // If assessment was found and updated in this org, log it
          if (assessmentUpdateResult.matchedCount > 0) {
            console.log(
              `Assessment ${assessmentId} updated in org ${orgId} with ${studentsToUpdate.length} students`
            );
          }
        } catch (error) {
          console.error(
            `Error updating assessment in org ${orgId}:`,
            error.message
          );
        }
      }
    }

    res.status(200).json({
      message: "Assessment assignment process completed",
      results,
      studentsUpdated: studentsToUpdate.length,
      organizationsSearched: colleges,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAssignedAssessments = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { job, assignedJob, jobAssessments, student } = connectTodb(
    req.tenantDB
  );
  const userId = req.userID;
  const { orgId } = req;

  try {
    // Get pagination parameters from query
    let { page = 1, limit = 20 } = req.query;
    page = Math.max(parseInt(page, 10), 1);
    limit = Math.max(parseInt(limit, 10), 1);

    // Get student record (by globalId)
    const studentDoc = await student.findOne({ globalId: userId });
    if (
      !studentDoc ||
      !studentDoc.appliedJobs ||
      studentDoc.appliedJobs.length === 0
    ) {
      return res.status(200).json({
        data: [],
        pagination: {
          currentPage: page,
          totalPages: 0,
          totalAssessments: 0,
          limit,
          hasNextPage: false,
          hasPrevPage: false,
        },
        message: "No applied jobs found for this student",
      });
    }

    // Collect all assessmentIds from student's appliedJobs
    let allAssessmentIds = new Set();

    for (const appliedJob of studentDoc.appliedJobs) {
      if (appliedJob.assessments && Array.isArray(appliedJob.assessments)) {
        appliedJob.assessments.forEach((assessmentId) => {
          allAssessmentIds.add(assessmentId.toString());
        });
      }
    }

    if (allAssessmentIds.size === 0) {
      return res.status(200).json({
        data: [],
        pagination: {
          currentPage: page,
          totalPages: 0,
          totalAssessments: 0,
          limit,
          hasNextPage: false,
          hasPrevPage: false,
        },
        message: "No assessments assigned to this student",
      });
    }

    // Get all applied job IDs to find which organizations to search in
    const appliedJobIds = studentDoc.appliedJobs.map((job) => job.id);
    let searchOrganizations = new Set([orgId]); // Always include current org

    // Find jobs in local collection first
    const localJobs = await job
      .find({
        _id: { $in: appliedJobIds.map((id) => new ObjectId(id)) },
      })
      .toArray();

    const foundLocalJobIds = localJobs.map((j) => j._id.toString());
    const remainingJobIds = appliedJobIds.filter(
      (id) => !foundLocalJobIds.includes(id)
    );

    // For remaining jobs, check assignedJob collection to find their source organizations
    if (remainingJobIds.length > 0) {
      const assignedJobDocs = await assignedJob
        .find({
          jobId: { $in: remainingJobIds },
        })
        .toArray();

      for (const assignedDoc of assignedJobDocs) {
        searchOrganizations.add(assignedDoc.companyOrgId);
      }
    }

    let allAssessments = [];

    // Search for assessments in each organization
    for (const searchOrgId of searchOrganizations) {
      try {
        let assessmentCollection;
        let skillsCollection;

        if (searchOrgId === orgId) {
          assessmentCollection = jobAssessments;
          // skillsCollection = skillsCollection; // Your local skills collection
        } else {
          const orgTenantDB = await getTenantDB(searchOrgId);
          const collections = connectTodb(orgTenantDB);
          assessmentCollection = collections.jobAssessments;
          // skillsCollection = collections.skillsCollection;
        }

        // Convert assessment IDs to ObjectIds for querying
        const assessmentObjectIds = [...allAssessmentIds].map(
          (id) => new ObjectId(id)
        );

        // Find assessments in this organization
        const assessments = await assessmentCollection
          .find({
            _id: { $in: assessmentObjectIds },
          })
          .toArray();

        // For each assessment, fetch related skills and questions data
        for (const assessment of assessments) {
          assessment._sourceOrgId = searchOrgId; // Track source organization

          // Fetch skills data if available

          // if (assessment.skills && Array.isArray(assessment.skills) && skillsCollection) {
          //   try {
          //     const skillIds = assessment.skills.map(s => new ObjectId(s.skillId));
          //     const skillsData = await skillsCollection.find({
          //       _id: { $in: skillIds }
          //     }).toArray();
          //     assessment.skillsData = skillsData || [];
          //   } catch (error) {
          //     console.error(`Error fetching skills for assessment ${assessment._id}:`, error.message);
          //     assessment.skillsData = [];
          //   }
          // }

          // Fetch questions data if available
          if (assessment.questionIds && Array.isArray(assessment.questionIds)) {
            try {
              const questionIds = assessment.questionIds.map(
                (q) => new ObjectId(q)
              );
              const questionsData = await questions
                .find({
                  _id: { $in: questionIds },
                })
                .toArray();
              assessment.questions = questionsData || [];
            } catch (error) {
              console.error(
                `Error fetching questions for assessment ${assessment._id}:`,
                error.message
              );
              assessment.questions = [];
            }
          }
        }

        allAssessments.push(...assessments);
      } catch (error) {
        console.error(
          `Error fetching assessments from org ${searchOrgId}:`,
          error.message
        );
      }
    }

    // Remove duplicates (in case same assessment exists in multiple orgs)
    const uniqueAssessments = [];
    const seenIds = new Set();

    for (const assessment of allAssessments) {
      if (!seenIds.has(assessment._id.toString())) {
        uniqueAssessments.push(assessment);
        seenIds.add(assessment._id.toString());
      }
    }

    // Apply pagination to the combined assessments
    const totalAssessments = uniqueAssessments.length;
    const totalPages = Math.ceil(totalAssessments / limit);

    // Check if requested page exceeds available pages
    if (page > totalPages && totalAssessments > 0) {
      return res.status(200).json({
        data: [],
        pagination: {
          currentPage: page,
          totalPages,
          totalAssessments,
          limit,
          hasNextPage: false,
          hasPrevPage: page > 1,
        },
        message: "Page exceeds available data",
      });
    }

    // Apply pagination
    const skip = (page - 1) * limit;
    const paginatedAssessments = uniqueAssessments.slice(skip, skip + limit);

    res.status(200).json({
      data: paginatedAssessments,
      pagination: {
        currentPage: page,
        totalPages,
        totalAssessments,
        limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Error in getAssignedAssessments:", error);
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAllAppliedStudents = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { student, assignedJob, job: localJob } = connectTodb(req.tenantDB);
  const { orgId } = req;

  try {
    const { studentIds, filter, jobId } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res
        .status(200)
        .json({ error: "No student IDs provided", data: [] });
    }

    const convertedIds = studentIds.map((e) => new ObjectId(e));
    let allStudents = [];

    // Get organization IDs to search in
    let colleges = [];

    if (jobId) {
      const jobDoc = await localJob.findOne({ _id: new ObjectId(jobId) });

      if (
        jobDoc &&
        Array.isArray(jobDoc.colleges) &&
        jobDoc.colleges.length > 0
      ) {
        colleges = jobDoc.colleges;
      } else {
        // Fallback: get organization IDs from assignedJob collection
        const assignedJobs = await assignedJob.find({ jobId }).toArray();
        colleges = assignedJobs.map((doc) => doc.companyOrgId);
      }
    }
    // Get students from local DB first
    const localStudents = await student
      .find({
        _id: { $in: convertedIds },
      })
      .toArray();

    const localStudentIds = localStudents.map((s) => s._id.toString());
    allStudents.push(
      ...localStudents.map((s) => ({
        ...s,
        sourceOrgId: orgId,
        isFromExternalOrg: false,
      }))
    );

    // Find remaining student IDs not found locally
    let remainingStudentIds = studentIds.filter(
      (id) => !localStudentIds.includes(id)
    );

    // Search in colleges (either from job document or assignedJob collection)
    if (remainingStudentIds.length > 0 && colleges.length > 0) {
      for (const collegeOrgId of colleges) {
        try {
          const collegeOrgIdDb = await getTenantDB(collegeOrgId);
          const { student: collegeStudentCollection } =
            connectTodb(collegeOrgIdDb);
          const externalStudents = await collegeStudentCollection
            .find({
              _id: { $in: remainingStudentIds.map((id) => new ObjectId(id)) },
            })
            .toArray();

          if (externalStudents.length > 0) {
            const studentsWithOrgInfo = externalStudents.map((s) => ({
              ...s,
              sourceOrgId: collegeOrgId,
              isFromExternalOrg: true,
            }));

            allStudents.push(...studentsWithOrgInfo);

            // Remove found student IDs from remaining list
            const foundIds = externalStudents.map((s) => s._id.toString());
            remainingStudentIds = remainingStudentIds.filter(
              (id) => !foundIds.includes(id)
            );
          }
        } catch (error) {
          console.error(
            `Failed to fetch students from college org ${collegeOrgId}:`,
            error.message
          );
        }
      }
    }

    // Apply filters to the combined student data
    let filteredStudents = allStudents;

    // Date range filter for appliedJobs
    if (filter?.startDate && filter?.endDate) {
      const startDateTime = new Date(filter.startDate);
      startDateTime.setHours(0, 0, 0, 0);

      const endDateTime = new Date(filter.endDate);
      endDateTime.setHours(23, 59, 59, 999);

      const startTimestamp = startDateTime.getTime();
      const endTimestamp = endDateTime.getTime();

      filteredStudents = filteredStudents.filter((student) => {
        if (!student.appliedJobs || !Array.isArray(student.appliedJobs))
          return false;

        return student.appliedJobs.some(
          (job) =>
            job.createdAt >= startTimestamp && job.createdAt <= endTimestamp
        );
      });
    }

    // Year of passing filter
    if (filter?.yearOfPass) {
      const yearValue = parseInt(filter.yearOfPass);

      filteredStudents = filteredStudents.filter((student) => {
        if (
          !student.educationDetails ||
          !Array.isArray(student.educationDetails)
        )
          return false;

        return student.educationDetails.some(
          (edu) => edu.yearofPass === yearValue
        );
      });
    }

    // CGPA filter
    if (filter?.CGPA && parseFloat(filter.CGPA) > 0) {
      const gradeValue = parseFloat(filter.CGPA);

      filteredStudents = filteredStudents.filter((student) => {
        if (
          !student.educationDetails ||
          !Array.isArray(student.educationDetails)
        )
          return false;

        return student.educationDetails.some((degree) => {
          if (!degree.grade) return false;

          let normalizedGrade;
          if (degree.gradingSystem === "cgpa") {
            normalizedGrade = parseFloat(degree.grade);
          } else {
            normalizedGrade = parseFloat(degree.grade) / 10;
          }

          return normalizedGrade >= gradeValue;
        });
      });
    }

    return res.status(200).json({
      data: filteredStudents,
      totalCount: filteredStudents.length,
      organizationBreakdown: {
        local: filteredStudents.filter((s) => !s.isFromExternalOrg).length,
        external: filteredStudents.filter((s) => s.isFromExternalOrg).length,
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

// module.exports.getOneAssessmentFromStudent = async (req, res) => {
//   if (!req.tenantDB)
//     return res.status(500).json({ error: "No tenant DB available" });

//   const { job, assignedJob, jobAssessments, student } = connectTodb(
//     req.tenantDB
//   );
//   const userId = req.userID;
//   const { orgId } = req;
//   const { assessmentId } = req.params;

//   try {
//     // Get student record (by globalId)
//     const studentDoc = await student.findOne({ globalId: userId });
//     if (
//       !studentDoc ||
//       !studentDoc.appliedJobs ||
//       studentDoc.appliedJobs.length === 0
//     ) {
//       return res
//         .status(404)
//         .json({ error: "No applied jobs found for this student" });
//     }

//     // Get all applied job IDs
//     const appliedJobIds = studentDoc.appliedJobs.map((job) => job.id);
//     let allJobs = [];
//     const foundLocalJobIds = [];

//     // Attempt to find jobs in local collection
//     for (const jobId of appliedJobIds) {
//       try {
//         const jobDoc = await job.findOne({ _id: new ObjectId(jobId) });
//         if (jobDoc) {
//           allJobs.push({ ...jobDoc, _sourceOrg: "local", _sourceOrgId: orgId });
//           foundLocalJobIds.push(jobId);
//         }
//       } catch {}
//     }

//     // Remaining jobs, to check in assignedJob
//     const remainingJobIds = appliedJobIds.filter(
//       (id) => !foundLocalJobIds.includes(id)
//     );

//     // For external jobs, get job from external org/company
//     let assignedJobDocs = [];
//     if (remainingJobIds.length > 0) {
//       try {
//         assignedJobDocs = await assignedJob
//           .find({ jobId: { $in: remainingJobIds } })
//           .toArray();
//       } catch {
//         assignedJobDocs = [];
//       }
//       for (const assignedDoc of assignedJobDocs) {
//         try {
//           const mainTenantDB = await getTenantDB(assignedDoc.companyOrgId);
//           const { job: companyJob } = connectTodb(mainTenantDB);
//           const jobDetail = await companyJob.findOne({
//             _id: new ObjectId(assignedDoc.jobId),
//           });
//           if (jobDetail) {
//             allJobs.push({
//               ...jobDetail,
//               _sourceOrg: "external",
//               _sourceOrgId: assignedDoc.companyOrgId,
//             });
//           }
//         } catch {}
//       }
//     }

//     // Check if student has access to this assessment through applied jobs
//     let hasAccess = false;
//     let targetAssessment = null;

//     for (const jobDoc of allJobs) {
//       if (
//         jobDoc.AssessmentId &&
//         jobDoc.AssessmentId.toString() === assessmentId
//       ) {
//         hasAccess = true;

//         try {
//           let assessCollection;
//           if (jobDoc._sourceOrgId === orgId) {
//             assessCollection = jobAssessments;
//           } else {
//             const orgTenantDB = await getTenantDB(jobDoc._sourceOrgId);
//             const collections = connectTodb(orgTenantDB);
//             assessCollection = collections.jobAssessments;
//           }

//           // Find the specific assessment
//           targetAssessment = await assessCollection.findOne({
//             _id: new ObjectId(assessmentId),
//           });

//           if (targetAssessment) {
//             // Aggregate skills data for this assessment
//             if (
//               targetAssessment.skills &&
//               Array.isArray(targetAssessment.skills)
//             ) {
//               const skillIds = targetAssessment.skills.map(
//                 (s) => new ObjectId(s.skillId)
//               );

//               try {
//                 const skillsData = await skillsCollection
//                   .find({
//                     _id: { $in: skillIds },
//                   })
//                   .toArray();

//                 // Add skillsData to the assessment
//                 targetAssessment.skillsData = skillsData;
//               } catch (error) {
//                 console.error(
//                   `Error fetching skills for assessment ${targetAssessment._id}:`,
//                   error.message
//                 );
//                 targetAssessment.skillsData = [];
//               }
//             }
//             break; // Found the assessment, exit loop
//           }
//         } catch (e) {
//           console.error(
//             `Error fetching assessment from org ${jobDoc._sourceOrgId}:`,
//             e.message
//           );
//         }
//       }
//     }

//     // Check if student has access to this assessment
//     if (!hasAccess) {
//       return res.status(403).json({
//         error:
//           "Access denied. You have not applied to any job with this assessment.",
//       });
//     }

//     // Check if assessment was found
//     if (!targetAssessment) {
//       return res.status(404).json({
//         error: "Assessment not found or no longer available.",
//       });
//     }

//     const questionsData = await questions
//       .find({
//         _id: {
//           $in: targetAssessment?.questionIds?.map((e) => new ObjectId(e)),
//         },
//       })
//       .toArray();

//     const respData = {
//       ...targetAssessment,
//       questions: questionsData,
//       // companyOrg: targetAssessment._sourceOrgId || orgId,
//     };
//     res.status(200).json({
//       data: respData,
//       message: "Assessment retrieved successfully",
//     });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// };

module.exports.getOneAssessmentFromStudent = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { job, assignedJob, jobAssessments, student } = connectTodb(
    req.tenantDB
  );
  const userId = req.userID;
  const { orgId } = req;
  const { assessmentId } = req.params;

  try {
    // Get student record (by globalId)
    const studentDoc = await student.findOne({ globalId: userId });
    if (
      !studentDoc ||
      !studentDoc.appliedJobs ||
      studentDoc.appliedJobs.length === 0
    ) {
      return res
        .status(404)
        .json({ error: "No applied jobs found for this student" });
    }

    // Get all applied job IDs
    const appliedJobIds = studentDoc.appliedJobs.map((job) => job.id);
    let allJobs = [];
    const foundLocalJobIds = [];

    // Attempt to find jobs in local collection
    for (const jobId of appliedJobIds) {
      try {
        const jobDoc = await job.findOne({ _id: new ObjectId(jobId) });
        if (jobDoc) {
          allJobs.push({ ...jobDoc, _sourceOrg: "local", _sourceOrgId: orgId });
          foundLocalJobIds.push(jobId);
        }
      } catch { }
    }

    // Remaining jobs, to check in assignedJob
    const remainingJobIds = appliedJobIds.filter(
      (id) => !foundLocalJobIds.includes(id)
    );

    // For external jobs, get job from external org/company
    let assignedJobDocs = [];
    if (remainingJobIds.length > 0) {
      try {
        assignedJobDocs = await assignedJob
          .find({ jobId: { $in: remainingJobIds } })
          .toArray();
      } catch {
        assignedJobDocs = [];
      }
      for (const assignedDoc of assignedJobDocs) {
        try {
          const mainTenantDB = await getTenantDB(assignedDoc.companyOrgId);
          const { job: companyJob } = connectTodb(mainTenantDB);
          const jobDetail = await companyJob.findOne({
            _id: new ObjectId(assignedDoc.jobId),
          });
          if (jobDetail) {
            allJobs.push({
              ...jobDetail,
              _sourceOrg: "external",
              _sourceOrgId: assignedDoc.companyOrgId,
            });
          }
        } catch { }
      }
    }

    // Check if student has access to this assessment through applied jobs
    let hasAccess = false;
    let targetAssessment = null;
    let assessmentCompanyOrgId = null; // Track the company org ID

    for (const jobDoc of allJobs) {
      if (
        jobDoc.AssessmentId &&
        jobDoc.AssessmentId.toString() === assessmentId
      ) {
        hasAccess = true;

        assessmentCompanyOrgId = jobDoc._sourceOrgId; // Store the company org ID

        try {
          let assessCollection;
          if (jobDoc._sourceOrgId === orgId) {
            assessCollection = jobAssessments;
          } else {
            const orgTenantDB = await getTenantDB(jobDoc._sourceOrgId);
            const collections = connectTodb(orgTenantDB);
            assessCollection = collections.jobAssessments;
          }

          // Find the specific assessment

          targetAssessment = await assessCollection.findOne({
            _id: new ObjectId(assessmentId),
          });

          // if (targetAssessment) {
          //   // Aggregate skills data for this assessment
          //   if (targetAssessment.skills && Array.isArray(targetAssessment.skills)) {
          //     const skillIds = targetAssessment.skills.map(s => new ObjectId(s.skillId));

          //     try {
          //       const skillsData = await skillsCollection.find({
          //         _id: { $in: skillIds }
          //       }).toArray();

          //       // Add skillsData to the assessment
          //       targetAssessment.skillsData = skillsData;
          //     } catch (error) {
          //       console.error(`Error fetching skills for assessment ${targetAssessment._id}:`, error.message);
          //       targetAssessment.skillsData = [];
          //     }
          //   }
          //   break; // Found the assessment, exit loop
          // }
        } catch (e) {
          console.error(
            `Error fetching assessment from org ${jobDoc._sourceOrgId}:`,
            e.message
          );
        }
      }
    }

    // Check if student has access to this assessment
    if (!hasAccess) {
      return res.status(403).json({
        error:
          "Access denied. You have not applied to any job with this assessment.",
      });
    }

    // Check if assessment was found
    if (!targetAssessment) {
      return res.status(404).json({
        error: "Assessment not found or no longer available.",
      });
    }

    const questionsData = await questions
      .find({
        _id: {
          $in: targetAssessment?.questionIds?.map((e) => new ObjectId(e)),
        },
      })
      .toArray();

    const respData = {
      ...targetAssessment,
      questions: questionsData,

      companyOrgId: assessmentCompanyOrgId, // Include company org ID
    };

    res.status(200).json({
      data: respData,
      message: "Assessment retrieved successfully",
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getJobAssessmentResultsForStudent = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { jobAssessmentProgress, job, assignedJob, student, questions } = connectTodb(
    req.tenantDB
  );
  const { assessmentId, studentId } = req.params;
  const { orgId } = req;

  try {
    let foundResults = null;
    let targetOrgId = orgId; // Default to current org

    // Determine where to look based on job source
    // First, try to find which organization this assessment belongs to
    const localJob = await job.findOne({ AssessmentId: assessmentId });

    if (!localJob) {
      // Check assigned jobs to find the source organization
      const assignedJobWithAssessment = await assignedJob.findOne({});

      if (assignedJobWithAssessment) {
        // Get the actual job from company DB to check if it has this assessment
        const companyTenantDB = await getTenantDB(
          assignedJobWithAssessment.companyOrgId
        );
        const { job: companyJob } = connectTodb(companyTenantDB);
        const companyJobWithAssessment = await companyJob.findOne({
          AssessmentId: assessmentId,
        });

        if (companyJobWithAssessment) {
          targetOrgId = assignedJobWithAssessment.companyOrgId;
        }
      }
    }

    // Now search in the determined organization's database
    let progressCollection = jobAssessmentProgress;

    if (targetOrgId !== orgId) {
      // Search in external company's database
      const targetTenantDB = await getTenantDB(targetOrgId);
      progressCollection = connectTodb(targetTenantDB).jobAssessmentProgress;
    }

    const results = await progressCollection
      .aggregate([
        { $match: { assessmentId: assessmentId, studentId: studentId } },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
      ])
      .toArray();



    // ========== STUDENT DETAILS LOGIC (Similar to getAllAppliedStudents) ==========

    let studentDetails = null;
    const convertedStudentId = new ObjectId(studentId);

    // Get organization IDs to search in
    let colleges = [];

    // Get colleges from job document or assigned jobs
    const jobDoc = await job.findOne({ AssessmentId: assessmentId });
    if (
      jobDoc &&
      Array.isArray(jobDoc.colleges) &&
      jobDoc.colleges.length > 0
    ) {
      colleges = jobDoc.colleges;
    } else {
      // Fallback: get organization IDs from assignedJob collection
      const assignedJobs = await assignedJob.find({}).toArray();
      colleges = assignedJobs.map((doc) => doc.companyOrgId);
    }

    // Get student from local DB first
    const localStudent = await student.findOne({
      _id: convertedStudentId,
    });

    if (localStudent) {
      studentDetails = {
        ...localStudent,
        sourceOrgId: orgId,
        isFromExternalOrg: false,
      };
    } else {
      // Search in colleges if not found locally
      if (colleges.length > 0) {
        for (const collegeOrgId of colleges) {
          try {
            const collegeOrgIdDb = await getTenantDB(collegeOrgId);
            const { student: collegeStudentCollection } =
              connectTodb(collegeOrgIdDb);
            const externalStudent = await collegeStudentCollection.findOne({
              _id: convertedStudentId,
            });

            if (externalStudent) {
              studentDetails = {
                ...externalStudent,
                sourceOrgId: collegeOrgId,
                isFromExternalOrg: true,
              };
              break; // Found student, exit loop
            }
          } catch (error) {
            console.error(
              `Failed to fetch student from college org ${collegeOrgId}:`,
              error.message
            );
          }
        }
      }
    }

    if (!studentDetails) {
      return res.status(404).json({
        error: "Student details not found in local or external databases",
      });
    }
    const questionData = await questions
      .find({
        _id: {
          $in: (results[0]?.assessmentData?.questionIds || []).map(
            (f) => new ObjectId(f)
          ),
        },
      })
      .toArray();

    // ==========================================================================
    const responsePayload = {
      JobAssessments: {
        assessmentId,
        studentId,
        studentDetails, // Now includes sourceOrgId and isFromExternalOrg
        assessmentResults: results,
        questionData,
      },
    };

    res.status(200).json(responsePayload);
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getJobAssessmentResultsByAssessmentId = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { jobAssessmentProgress, assignedJob } = connectTodb(req.tenantDB);
  const { assessmentId, jobId } = req.params;
  const { orgId } = req;

  try {
    let allResults = [];

    // 1. Collect from local org
    const localResults = await jobAssessmentProgress
      .aggregate([
        { $match: { assessmentId } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$studentId", latestAttempt: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$latestAttempt" } },
      ])
      .toArray();

    allResults.push(...localResults);

    // 2. Collect from each assigned company/org
    const assignedJobsList = await assignedJob.find({ jobId }).toArray();

    for (const assignedJobDoc of assignedJobsList) {
      try {
        const extTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
        const { jobAssessmentProgress: extProgress } = connectTodb(extTenantDB);

        const extResults = await extProgress
          .aggregate([
            { $match: { assessmentId } },
            { $sort: { createdAt: -1 } },
            {
              $group: {
                _id: "$studentId",
                latestAttempt: { $first: "$$ROOT" },
              },
            },
            { $replaceRoot: { newRoot: "$latestAttempt" } },
          ])
          .toArray();

        allResults.push(...extResults);
      } catch (e) {
        console.error(
          `Error fetching results from org ${assignedJobDoc.companyOrgId}:`,
          e.message
        );
      }
    }

    const uniqueResults = [];
    const seen = new Set();
    for (const res of allResults) {
      if (!seen.has(res.studentId)) {
        uniqueResults.push(res);
        seen.add(res.studentId);
      }
    }

    // Return the results
    res.status(200).json({
      JobAssessments: {
        assessmentId,
        jobId,
        assessmentResults: uniqueResults,
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAllAppliedStudentsWithAssesmentResults = async (req, res) => {
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const {
    student,
    assignedJob,
    job: localJob,
    jobAssessmentProgress,
  } = connectTodb(req.tenantDB);
  const { orgId } = req;

  try {
    const { studentIds, jobId, assessmentId } = req.body;
    if (
      !Array.isArray(studentIds) ||
      studentIds.length === 0 ||
      !jobId ||
      !assessmentId
    ) {
      return res
        .status(400)
        .json({ error: "Required parameters missing", data: [] });
    }

    const convertedIds = studentIds.map((e) => new ObjectId(e));
    let allStudents = [];
    let colleges = [];
    let useAssignedJobFallback = true;

    // Decide college-orgs or assignedJob orgs
    const jobDoc = await localJob.findOne({ _id: new ObjectId(jobId) });
    if (
      jobDoc &&
      Array.isArray(jobDoc.colleges) &&
      jobDoc.colleges.length > 0
    ) {
      colleges = jobDoc.colleges;
      useAssignedJobFallback = false;
    } else {
      const assignedJobs = await assignedJob.find({ jobId }).toArray();
      colleges = assignedJobs.map((doc) => doc.companyOrgId);
      useAssignedJobFallback = true;
    }

    // Get local students
    const localStudents = await student
      .find({ _id: { $in: convertedIds } })
      .toArray();
    const localStudentIds = localStudents.map((s) => s._id.toString());
    allStudents.push(
      ...localStudents.map((s) => ({
        ...s,
        sourceOrgId: orgId,
        isFromExternalOrg: false,
      }))
    );

    // Get remaining students from colleges
    let remainingStudentIds = studentIds.filter(
      (id) => !localStudentIds.includes(id)
    );
    if (remainingStudentIds.length > 0 && colleges.length) {
      for (const collegeOrgId of colleges) {
        try {
          const collegeOrgIdDb = await getTenantDB(collegeOrgId);
          const { student: collegeStudentCollection } =
            connectTodb(collegeOrgIdDb);
          const externalStudents = await collegeStudentCollection
            .find({
              _id: { $in: remainingStudentIds.map((id) => new ObjectId(id)) },
            })
            .toArray();

          if (externalStudents.length > 0) {
            allStudents.push(
              ...externalStudents.map((s) => ({
                ...s,
                sourceOrgId: collegeOrgId,
                isFromExternalOrg: true,
              }))
            );
            const foundIds = externalStudents.map((s) => s._id.toString());
            remainingStudentIds = remainingStudentIds.filter(
              (id) => !foundIds.includes(id)
            );
          }
        } catch (error) {
          console.error(
            `Failed to fetch students from org ${collegeOrgId}:`,
            error.message
          );
        }
      }
    }

    // If company job, try assignedJob fallback for remaining
    if (remainingStudentIds.length > 0 && useAssignedJobFallback) {
      for (const collegeOrgId of colleges) {
        try {
          const collegeOrgIdDb = await getTenantDB(collegeOrgId);
          const { student: collegeStudentCollection } =
            connectTodb(collegeOrgIdDb);
          const externalStudents = await collegeStudentCollection
            .find({
              _id: { $in: remainingStudentIds.map((id) => new ObjectId(id)) },
            })
            .toArray();

          if (externalStudents.length > 0) {
            allStudents.push(
              ...externalStudents.map((s) => ({
                ...s,
                sourceOrgId: collegeOrgId,
                isFromExternalOrg: true,
              }))
            );
            const foundIds = externalStudents.map((s) => s._id.toString());
            remainingStudentIds = remainingStudentIds.filter(
              (id) => !foundIds.includes(id)
            );
          }
        } catch (error) {
          console.error(
            `AssignedJob fetch students from org ${collegeOrgId}:`,
            error.message
          );
        }
      }
    }

    // ------ JOB PROGRESS ENRICHMENT ------
    let jobProgressMap = new Map();

    // Local job progress
    const localJobProgress = await jobAssessmentProgress
      .aggregate([
        { $match: { jobId, assessmentId } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$studentId", latestAttempt: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$latestAttempt" } },
      ])
      .toArray();
    localJobProgress.forEach((prog) =>
      jobProgressMap.set(prog.studentId, prog)
    );

    // External job progress
    if (colleges.length > 0) {
      for (const collegeOrgId of colleges) {
        try {
          const collegeOrgIdDb = await getTenantDB(collegeOrgId);
          const { jobAssessmentProgress: collegeProgressCollection } =
            connectTodb(collegeOrgIdDb);
          const jobProgressExternal = await collegeProgressCollection
            .aggregate([
              { $match: { jobId, assessmentId } },
              { $sort: { createdAt: -1 } },
              {
                $group: {
                  _id: "$studentId",
                  latestAttempt: { $first: "$$ROOT" },
                },
              },
              { $replaceRoot: { newRoot: "$latestAttempt" } },
            ])
            .toArray();
          jobProgressExternal.forEach((prog) => {
            if (!jobProgressMap.has(prog.studentId)) {
              jobProgressMap.set(prog.studentId, prog);
            }
          });
        } catch (error) {
          console.error(
            `Progress fetch failed college org ${collegeOrgId}:`,
            error.message
          );
        }
      }
    } else {
      const assignedJobs = await assignedJob.find({ jobId }).toArray();
      for (const assignedJobDoc of assignedJobs) {
        try {
          const extTenantDB = await getTenantDB(assignedJobDoc.companyOrgId);
          const { jobAssessmentProgress: extProgressCollection } =
            connectTodb(extTenantDB);
          const jobProgressExt = await extProgressCollection
            .aggregate([
              { $match: { jobId, assessmentId } },
              { $sort: { createdAt: -1 } },
              {
                $group: {
                  _id: "$studentId",
                  latestAttempt: { $first: "$$ROOT" },
                },
              },
              { $replaceRoot: { newRoot: "$latestAttempt" } },
            ])
            .toArray();
          jobProgressExt.forEach((prog) => {
            if (!jobProgressMap.has(prog.studentId)) {
              jobProgressMap.set(prog.studentId, prog);
            }
          });
        } catch (error) {
          console.error(
            `AssignedJob progress fetch failed org ${assignedJobDoc.companyOrgId}:`,
            error.message
          );
        }
      }
    }

    // Attach jobProgress to each student
    const enrichedStudents = allStudents.map((student) => ({
      ...student,
      jobProgress: jobProgressMap.get(student._id?.toString()) || null,
    }));

    return res.status(200).json({
      data: enrichedStudents,
      totalCount: enrichedStudents.length,
      organizationBreakdown: {
        local: enrichedStudents.filter((s) => !s.isFromExternalOrg).length,
        external: enrichedStudents.filter((s) => s.isFromExternalOrg).length,
      },
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateStudentAndJobStatus = async (req, res) => {
  if (!req.tenantDB) {
    return res.status(500).json({ error: "No tenant DB available" });
  }

  const { student, job: localJob, assignedJob } = connectTodb(req.tenantDB);
  const { jobId, studentId, status } = req.body;
  const { orgId } = req;

  // Validate required fields
  if (!jobId || !studentId || !status) {
    return res.status(400).json({
      error: "jobId, studentId and status are required",
    });
  }

  // Validate status values
  const validStatuses = ["approved", "rejected", "pending", "shortlisted"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      error:
        "Invalid status. Must be one of: approved, rejected, pending, shortlisted",
    });
  }

  try {
    const jobObjectId = new ObjectId(jobId);
    const studentObjectId = new ObjectId(studentId);

    // Step 1: Check if this is an assigned job (company side)
    const assignedJobDoc = await assignedJob.findOne({
      jobId: jobId,
      companyOrgId: orgId,
    });

    // Step 2: Update job collections based on status
    const jobUpdatePromises = [];

    let updateOperations = {};
    if (status === "approved") {
      updateOperations = {
        $addToSet: { approvedStudents: studentObjectId?.toString() },
        $pull: { rejectedCandidates: studentObjectId?.toString() },
      };
    } else if (status === "rejected") {
      updateOperations = {
        $addToSet: { rejectedCandidates: studentObjectId?.toString() },
        $pull: { approvedStudents: studentObjectId?.toString() },
      };
    } else {
      // For other statuses, remove from both arrays
      updateOperations = {
        $pull: {
          approvedStudents: studentObjectId?.toString(),
          rejectedCandidates: studentObjectId?.toString(),
        },
      };
    }

    // Always update local job collection
    jobUpdatePromises.push(
      localJob.updateOne({ _id: jobObjectId }, updateOperations)
    );

    // If this is an assigned job, also update assignedJob collection
    if (assignedJobDoc) {
      jobUpdatePromises.push(
        assignedJob.updateOne(
          { jobId: jobId, companyOrgId: orgId },
          updateOperations
        )
      );
    }

    // Execute job updates in parallel
    await Promise.all(jobUpdatePromises);

    // Step 3: Find student - first try locally, then search external orgs
    let studentDoc = await student.findOne({ _id: studentObjectId });
    let studentSourceOrg = orgId; // Default to current org
    let studentCollection = student; // Default to local collection

    // If student not found locally, search in external tenant databases
    if (!studentDoc) {
      // Get organization IDs to search in
      let colleges = [];

      // Get colleges from job document
      const jobDoc = await localJob.findOne({ _id: jobObjectId });
      if (
        jobDoc &&
        Array.isArray(jobDoc.colleges) &&
        jobDoc.colleges.length > 0
      ) {
        colleges = jobDoc.colleges;
      } else {
        // Fallback: get organization IDs from assignedJob collection
        const assignedJobs = await assignedJob.find({ jobId: jobId }).toArray();
        colleges = assignedJobs.map((doc) => doc.companyOrgId);
      }

      // Search in each college organization
      for (const collegeOrgId of colleges) {
        try {
          const externalTenantDB = await getTenantDB(collegeOrgId);
          const { student: externalStudent } = connectTodb(externalTenantDB);

          studentDoc = await externalStudent.findOne({ _id: studentObjectId });

          if (studentDoc) {
            studentSourceOrg = collegeOrgId;
            studentCollection = externalStudent;
            studentDoc.isFromExternalOrg = true;
            studentDoc.sourceOrgId = collegeOrgId;
            break; // Exit loop once student is found
          }
        } catch (error) {
          console.error(
            `Failed to search student in org ${collegeOrgId}:`,
            error.message
          );
        }
      }
    }

    // If student still not found, return error
    if (!studentDoc) {
      return res.status(404).json({
        error: "Student not found in local or associated organizations",
      });
    }

    // Step 4: Update student's appliedJobs array with new status
    await studentCollection.updateOne(
      {
        _id: studentObjectId,
        "appliedJobs.id": jobId,
      },
      {
        $set: { "appliedJobs.$.status": status },
      }
    );

    // Step 5: If student was found in external org, also try to update local record
    if (studentDoc.isFromExternalOrg && studentSourceOrg !== orgId) {
      try {
        // Try to update in local database too (if student has a record here)
        await student.updateOne(
          {
            _id: studentObjectId,
            "appliedJobs.id": jobId,
          },
          {
            $set: { "appliedJobs.$.status": status },
          }
        );
      } catch (localUpdateError) {
        console.log(
          `Student ${studentId} not found in local DB, only updated in source org`
        );
      }
    }

    return res.status(200).json({
      message: `Student and job status updated successfully`,
      data: {
        jobId,
        studentId,
        status,
        updatedInAssignedJob: !!assignedJobDoc,
        updatedInLocalJob: true,
        studentFoundIn: studentDoc.isFromExternalOrg
          ? "external_org"
          : "local_org",
        sourceOrgId: studentSourceOrg,
        action:
          status === "approved"
            ? "moved to approvedStudents"
            : status === "rejected"
              ? "moved to rejectedCandidates"
              : "removed from approval/rejection lists",
      },
    });
  } catch (error) {
    console.error("Error updating student and job status:", error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports.scheduleInterview = async (req, res) => {
  if (!req.tenantDB) {
    return res.status(500).json({ error: "No tenant DB available" });
  }

  const { student, job: localJob, assignedJob } = connectTodb(req.tenantDB);
  const { jobId, studentId, interviewDetails } = req.body;
  const { orgId } = req;

  if (!jobId || !studentId || !interviewDetails) {
    return res
      .status(400)
      .json({ error: "jobId, studentId and interviewDetails are required" });
  }

  const requiredFields = ["date", "time", "type", "interviewer"];
  const missingFields = requiredFields.filter(
    (field) => !interviewDetails[field]
  );
  if (missingFields.length > 0) {
    return res.status(400).json({
      error: `Missing required interview fields: ${missingFields.join(", ")}`,
    });
  }

  const validInterviewTypes = ["online", "offline", "phone", "video"];
  if (!validInterviewTypes.includes(interviewDetails.type)) {
    return res.status(400).json({
      error:
        "Invalid interview type. Must be one of: online, offline, phone, video",
    });
  }

  try {
    const jobObjectId = new ObjectId(jobId);
    const studentObjectId = new ObjectId(studentId);

    const interviewObject = {
      interviewId: new ObjectId().toString(),
      studentId: studentId,
      jobId: jobId,
      ...interviewDetails,
      status: "scheduled",
      scheduledBy: orgId,
      createdAt: new Date().getTime(),
      updatedAt: new Date().getTime(),
    };

    // Step 1: Check if this is an assigned job (company side)
    const assignedJobDoc = await assignedJob.findOne({
      jobId: jobId,
      companyOrgId: orgId,
    });

    // Step 2: Update or upsert the interview for this student in job
    // Update job (local)
    await localJob.updateOne(
      { _id: jobObjectId, "scheduledInterviews.studentId": studentId },
      {
        $set: {
          "scheduledInterviews.$": interviewObject,
        },
      }
    );
    // If not present, push new (because $set above won't add if not found)
    await localJob.updateOne(
      { _id: jobObjectId, "scheduledInterviews.studentId": { $ne: studentId } },
      {
        $addToSet: { scheduledInterviews: interviewObject },
      }
    );

    // Assigned job (external) - do the same if it exists
    if (assignedJobDoc) {
      await assignedJob.updateOne(
        {
          jobId: jobId,
          companyOrgId: orgId,
          "scheduledInterviews.studentId": studentId,
        },
        {
          $set: {
            "scheduledInterviews.$": interviewObject,
          },
        }
      );
      await assignedJob.updateOne(
        {
          jobId: jobId,
          companyOrgId: orgId,
          "scheduledInterviews.studentId": { $ne: studentId },
        },
        {
          $addToSet: { scheduledInterviews: interviewObject },
        }
      );
    }

    // ---- Student updates (same as before, "last one wins"): -----
    let studentDoc = await student.findOne({ _id: studentObjectId });
    let studentSourceOrg = orgId;
    let studentCollection = student;

    if (!studentDoc) {
      let colleges = [];
      const jobDoc = await localJob.findOne({ _id: jobObjectId });
      if (
        jobDoc &&
        Array.isArray(jobDoc.colleges) &&
        jobDoc.colleges.length > 0
      ) {
        colleges = jobDoc.colleges;
      } else {
        const assignedJobs = await assignedJob.find({ jobId: jobId }).toArray();
        colleges = assignedJobs.map((doc) => doc.companyOrgId);
      }

      for (const collegeOrgId of colleges) {
        try {
          const externalTenantDB = await getTenantDB(collegeOrgId);
          const { student: externalStudent } = connectTodb(externalTenantDB);
          studentDoc = await externalStudent.findOne({ _id: studentObjectId });
          if (studentDoc) {
            studentSourceOrg = collegeOrgId;
            studentCollection = externalStudent;
            studentDoc.isFromExternalOrg = true;
            studentDoc.sourceOrgId = collegeOrgId;
            break;
          }
        } catch (error) {
          console.error(
            `Failed to search student in org ${collegeOrgId}:`,
            error.message
          );
        }
      }
    }

    if (!studentDoc) {
      return res.status(404).json({
        error: "Student not found in local or associated organizations",
      });
    }

    // Step 3: Update (or upsert) student's appliedJobs array with interview details
    const studentUpdateResult = await studentCollection.updateOne(
      { _id: studentObjectId, "appliedJobs.id": jobId },
      {
        $set: {
          "appliedJobs.$.interviewScheduled": true,
          "appliedJobs.$.interviewDetails": interviewObject,
          "appliedJobs.$.status": "interview_scheduled",
        },
      }
    );
    // If no appliedJob found, add a new one
    if (studentUpdateResult.matchedCount === 0) {
      await studentCollection.updateOne(
        { _id: studentObjectId },
        {
          $addToSet: {
            appliedJobs: {
              id: jobId,
              status: "interview_scheduled",
              interviewScheduled: true,
              interviewDetails: interviewObject,
              appliedAt: new Date().getTime(),
            },
          },
        }
      );
    }
    // Step 4: If student was found in external org, also try to update local record
    if (studentDoc.isFromExternalOrg && studentSourceOrg !== orgId) {
      try {
        const localUpdateResult = await student.updateOne(
          { _id: studentObjectId, "appliedJobs.id": jobId },
          {
            $set: {
              "appliedJobs.$.interviewScheduled": true,
              "appliedJobs.$.interviewDetails": interviewObject,
              "appliedJobs.$.status": "interview_scheduled",
            },
          }
        );
        if (localUpdateResult.matchedCount === 0) {
          await student.updateOne(
            { _id: studentObjectId },
            {
              $addToSet: {
                appliedJobs: {
                  id: jobId,
                  status: "interview_scheduled",
                  interviewScheduled: true,
                  interviewDetails: interviewObject,
                  appliedAt: new Date().getTime(),
                },
              },
            }
          );
        }
      } catch (localUpdateError) {
        console.log(
          `Could not update local student record: ${localUpdateError.message}`
        );
      }
    }

    return res.status(200).json({
      message: `Interview scheduled/updated successfully`,
      data: {
        jobId,
        studentId,
        interviewId: interviewObject.interviewId,
        interviewDetails: interviewObject,
        updatedInAssignedJob: !!assignedJobDoc,
        updatedInLocalJob: true,
        studentFoundIn: studentDoc.isFromExternalOrg
          ? "external_org"
          : "local_org",
        sourceOrgId: studentSourceOrg,
        action: "interview_scheduled",
      },
    });
  } catch (error) {
    console.error("Error scheduling interview:", error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports.getScheduledInterviewsForJob = async (req, res) => {
  if (!req.tenantDB) {
    return res.status(500).json({ error: "No tenant DB available" });
  }

  const { student, job: localJob, assignedJob } = connectTodb(req.tenantDB);
  const { jobId } = req.params;
  const { orgId } = req;

  if (!jobId) {
    return res.status(400).json({ error: "jobId is required" });
  }

  try {
    const jobObjectId = new ObjectId(jobId);

    // Step 1: Find if job is assigned (company-side)
    const assignedJobDoc = await assignedJob.findOne({
      jobId: jobId,
      companyOrgId: orgId,
    });

    // Step 2: Get scheduledInterviews array from local or assigned job
    let scheduledInterviews = [];
    const jobDoc = await localJob.findOne({ _id: jobObjectId });
    if (jobDoc && Array.isArray(jobDoc.scheduledInterviews)) {
      scheduledInterviews = jobDoc.scheduledInterviews;
    }
    if (scheduledInterviews.length === 0 && assignedJobDoc) {
      const assignedJobData = await assignedJob.findOne({
        jobId: jobId,
        companyOrgId: orgId,
      });
      if (
        assignedJobData &&
        Array.isArray(assignedJobData.scheduledInterviews)
      ) {
        scheduledInterviews = assignedJobData.scheduledInterviews;
      }
    }
    if (scheduledInterviews.length === 0) {
      return res
        .status(200)
        .json({ students: [] });
    }

    // Step 3: Find all studentIds (deduplicate)
    const studentIds = scheduledInterviews.map(
      (interview) => interview.studentId
    );
    const uniqueStudentIds = [...new Set(studentIds)];

    // Step 4: Fetch student info (local first, then external orgs)
    const studentsMap = new Map();
    const localStudents = await student
      .find({
        _id: {
          $in: uniqueStudentIds
            .filter((id) => ObjectId.isValid(id))
            .map((id) => new ObjectId(id)),
        },
      })
      .toArray();

    localStudents.forEach((s) => {
      studentsMap.set(s._id.toString(), {
        ...s,
        sourceOrgId: orgId,
        isFromExternalOrg: false,
      });
    });

    // Find studentIds not present locally
    const localStudentIds = localStudents.map((s) => s._id.toString());
    let remainingStudentIds = uniqueStudentIds.filter(
      (id) => !localStudentIds.includes(id)
    );

    // Get colleges/orgs to search (from jobDoc or assignedJob)
    let colleges = [];
    if (
      jobDoc &&
      Array.isArray(jobDoc.colleges) &&
      jobDoc.colleges.length > 0
    ) {
      colleges = jobDoc.colleges;
    } else if (assignedJobDoc) {
      colleges = [assignedJobDoc.companyOrgId];
    } else {
      const assignedJobs = await assignedJob.find({ jobId }).toArray();
      colleges = assignedJobs.map((doc) => doc.companyOrgId);
    }

    // Query in external orgs for remaining students
    for (const collegeOrgId of colleges) {
      if (remainingStudentIds.length === 0) break;
      try {
        const externalTenantDB = await getTenantDB(collegeOrgId);
        const { student: extStudentCollection } = connectTodb(externalTenantDB);
        const externalStudents = await extStudentCollection
          .find({
            _id: {
              $in: remainingStudentIds
                .filter((id) => ObjectId.isValid(id))
                .map((id) => new ObjectId(id)),
            },
          })
          .toArray();
        externalStudents.forEach((s) => {
          studentsMap.set(s._id.toString(), {
            ...s,
            sourceOrgId: collegeOrgId,
            isFromExternalOrg: true,
          });
        });
        const foundIds = externalStudents.map((s) => s._id.toString());
        remainingStudentIds = remainingStudentIds.filter(
          (id) => !foundIds.includes(id)
        );
      } catch (error) {
        console.error(
          `Failed to fetch students from org ${collegeOrgId}:`,
          error.message
        );
      }
    }

    // Prepare final result combining interview & student info
    const studentsWithInterviews = scheduledInterviews.map((interview) => {
      const sid = interview.studentId.toString();
      const studentInfo = studentsMap.get(sid) || null;
      return {
        studentId: sid,
        studentDetails: studentInfo,
        interviewDetails: interview,
      };
    });

    return res.status(200).json({
      jobId,
      students: studentsWithInterviews,
    });
  } catch (error) {
    console.error("Error getting scheduled interviews:", error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports.getQuestionById = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await questions.findOne({ _id: convertToMid(id) });
    if (!doc) return res.status(404).json({ err: "Question not found" });
    return res.status(200).json({ data: doc });
  } catch (error) {
    console.error("getQuestionById error:", error);
    return res.status(500).json({ err: error.message });
  }
};

module.exports.updateQuestion = async (req, res) => {
  try {
    const { id } = req.params;

    const updateDoc = {
      ...req.body,
      updatedAt: Date.now(),
    };

    const result = await questions.updateOne(
      { _id: convertToMid(id) },
      { $set: updateDoc }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ err: "Question not found" });
    }

    return res.status(200).json({
      message: "Question updated successfully",
      data: {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      },
    });
  } catch (error) {
    console.error("updateQuestion error:", error);
    return res.status(500).json({ err: error.message });
  }
};
