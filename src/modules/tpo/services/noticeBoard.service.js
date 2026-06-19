require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});
const express = require("express");
const mongoDB = require("mongodb");
const { ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const CryptoJS = require("crypto-js");

const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const { mainDBusers } = require("../../../shared/db/connection").getGlobalCollections();

const nodemailer = require("nodemailer");
const secretToken = process.env.CRYPTOSECRET;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.support_mail,
    pass: process.env.support_pass,
  },
});

const app = express();

app.use(cors());
app.use(authenticate);
app.use(selectTenantDB);

module.exports.createNoticeBoard = async (req, res) => {
  try {
    if (!req.tenantDB) {
      return res.status(500).json({ error: "No tenant DB available" });
    }

    // 1) grab collections correctly
    const dbCols = connectTodb(req.tenantDB);
    const studentsCollection = dbCols.student;
    const departmentsCollection = dbCols.departments;
    const noticeBoardCollection = dbCols.noticeBoard;

    if (
      !studentsCollection ||
      !departmentsCollection ||
      !noticeBoardCollection
    ) {
      console.error("Collections missing:", {
        student: !!studentsCollection,
        department: !!departmentsCollection,
        noticeBoard: !!noticeBoardCollection,
      });
      return res
        .status(500)
        .json({ error: "DB collections not configured correctly" });
    }

    // 2) pull body
    const {
      targetGroupCode = "STU_ALL",
      batchYear,
      deptId,
      minCgpa,
      requiredSkills = [],
      emailNotification = false,
      ...noticeData
    } = req.body;

    // 3) normalize deptId
    const rawDeptIds = Array.isArray(deptId)
      ? deptId.filter(Boolean)
      : deptId
        ? [deptId]
        : [];
    const objectDeptIds = rawDeptIds.map((hex) => new ObjectId(hex));

    // 4) filter‐builders
    const targetGroups = {
      // <-- return an empty filter for ALL
      STU_ALL: () => ({}),

      STU_BATCH: (yr) => ({
        // type: "student",
        yearOfPassing: yr.toString(),
      }),

      STU_DEPT: (deptArr) => ({
        // type: "student",
        department: { $in: deptArr },
      }),

      STU_BATCH_DEPT: (yr, deptArr) => ({
        // type: "student",
        yearOfPassing: yr.toString(),
        department: { $in: deptArr },
      }),

      STU_JOB_APP: () => ({
        // type: "student",
        hasAppliedForJobs: true,
      }),

      STU_ASSGN_ASSESS: () => ({
        // type: "student",
        assignedAssessments: { $exists: true, $ne: [] },
      }),

      STU_PENDING_ACTION: () => ({
        // type: "student",
        pendingActions: { $exists: true, $ne: [] },
      }),

      STU_FINAL_YEAR: (curr = new Date().getFullYear()) => ({
        // type: "student",
        yearOfPassing: curr.toString(),
      }),

      STU_ELIGIBLE: (cgpa = 7.0, skills = []) => ({
        // type: "student",
        cgpa: { $gte: cgpa },
        skills: { $in: skills },
      }),
    };

    // 5) pick & validate your filter
    const builder = targetGroups[targetGroupCode];
    if (!builder) {
      return res
        .status(400)
        .json({ error: `Invalid targetGroupCode: ${targetGroupCode}` });
    }

    let filterQuery;
    switch (targetGroupCode) {
      case "STU_BATCH":
        if (!batchYear)
          return res
            .status(400)
            .json({ error: "batchYear is required for STU_BATCH" });
        filterQuery = builder(batchYear);
        break;

      case "STU_DEPT":
        if (!rawDeptIds.length)
          return res.status(400).json({
            error: "deptId (string or array) is required for STU_DEPT",
          });
        filterQuery = builder(rawDeptIds);
        break;

      case "STU_BATCH_DEPT":
        if (!batchYear || !rawDeptIds.length)
          return res.status(400).json({
            error: "batchYear and deptId are required for STU_BATCH_DEPT",
          });
        filterQuery = builder(batchYear, rawDeptIds);
        break;

      case "STU_ELIGIBLE":
        filterQuery = builder(minCgpa, requiredSkills);
        break;

      default:
        // STU_ALL, STU_JOB_APP, etc.
        filterQuery = builder();
    }
    // 6) build & insert notice
    const noticeRecord = {
      ...noticeData,
      status: noticeData.status || "pending",
      emailNotification,
      createdAt: Date.now(),
      targetGroup: {
        code: targetGroupCode,
        ...(batchYear && { batchYear: batchYear.toString() }),
        ...(rawDeptIds.length && { deptId: rawDeptIds }),
        ...(minCgpa && { minCgpa }),
        ...(requiredSkills.length && { requiredSkills }),
      },
    };

    const { insertedId } = await noticeBoardCollection.insertOne(noticeRecord);
    const noticeBoardId = insertedId.toString();

    // 7) find + update students

    const matchedStudents = await studentsCollection
      .find(filterQuery)
      .project({ email: 1 })
      .toArray();

    if (matchedStudents.length) {
      const ops = matchedStudents.map((stu) => ({
        updateOne: {
          filter: { _id: stu._id },
          update: { $push: { noticeboard: noticeBoardId } },
        },
      }));
      await studentsCollection.bulkWrite(ops);
    }

    // 8) update departments
    if (objectDeptIds.length) {
      if (typeof departmentsCollection.updateMany === "function") {
        await departmentsCollection.updateMany(
          { _id: { $in: objectDeptIds } },
          { $push: { noticeboard: noticeBoardId } }
        );
      } else {
        await Promise.all(
          objectDeptIds.map((did) =>
            departmentsCollection.updateOne(
              { _id: did },
              { $push: { noticeboard: noticeBoardId } }
            )
          )
        );
      }
    }

    // 9) send mail if requested
    if (emailNotification && matchedStudents.length) {
      await transporter.sendMail({
        from: process.env.support_mail,
        to: matchedStudents.map((s) => s.email).join(","),
        subject: noticeData.title,
        text: noticeData.message,
      });
    }

    // 10) final response
    return res.status(200).json({
      msg:
        matchedStudents.length === 0
          ? "Notice created, but no students matched the criteria."
          : "Notice created and students updated successfully.",
      data: {
        noticeBoardId,
        matchedCount: matchedStudents.length,
      },
    });
  } catch (error) {
    console.error("Error creating notice:", error);
    return res.status(500).json({ error: error.message });
  }
};
module.exports.updateNoticeBoard = async (req, res) => {
  const { noticeBoard } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  try {
    const { id } = req.params;

    const covid = new mongoDB.ObjectId(id);

    const findNoticeBoard = await noticeBoard.findOne({ _id: covid });

    if (!findNoticeBoard)
      throw new Error("Please select valid noticeboard to update");

    const updatedData = await noticeBoard.updateOne(
      { _id: findNoticeBoard._id },
      {
        $set: req.body,
      }
    );

    res
      .status(200)
      .json({ msg: "Notice board updated successfully", data: updatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.setStatusActive = async (req, res) => {
  const { noticeBoard } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const covid = new mongoDB.ObjectId(id);

    const findNoticeBoard = await noticeBoard.findOne({ _id: covid });

    if (!findNoticeBoard)
      throw new Error("Please select valid noticeboard to update");

    const updatedData = await noticeBoard.updateOne(
      { _id: findNoticeBoard._id },
      {
        $set: { status: "active" },
      }
    );

    res.status(200).json({
      msg: "Notice board updated successfully",
      data: updatedData,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.setStatusExpire = async (req, res) => {
  const { noticeBoard } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const covid = new mongoDB.ObjectId(id);

    const findNoticeBoard = await noticeBoard.findOne({ _id: covid });

    if (!findNoticeBoard)
      throw new Error("Please select valid noticeboard to update");

    const updatedData = await noticeBoard.updateOne(
      { _id: findNoticeBoard._id },
      {
        $set: { status: "expired" },
      }
    );

    res.status(200).json({
      msg: "Notice board updated successfully",
      data: updatedData,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAllNoticeBoards = async (req, res) => {
  const { noticeBoard } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { limit = 20, page = 1 } = req.body;

    const skip = (page - 1) * limit;

    const totalQuestions = await noticeBoard.countDocuments({});

    const allQuestions = await noticeBoard
      .find({})
      .sort({ _id: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({
      total: totalQuestions,
      page,
      limit,
      questions: allQuestions,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getNoticeByStatus = async (req, res) => {
  const { noticeBoard } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });

  const { limit = 20, page = 1 } = req.body;
  const { status } = req.query;

  try {
    const skip = (page - 1) * limit;
    const filter = { status };

    const total = await noticeBoard.countDocuments(filter);
    const notices = await noticeBoard
      .find(filter)
      .sort({ _id: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({
      total,
      page,
      limit,
      notices,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getOneNoticeBoard = async (req, res) => {
  const { noticeBoard } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const covid = new mongoDB.ObjectId(id);

    const findNoticeBoard = await noticeBoard.findOne({ _id: covid });

    if (!findNoticeBoard) throw new Error("Please select valid noticeboard");

    res.status(200).json({ data: findNoticeBoard });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deleteNoticeBoard = async (req, res) => {
  const { noticeBoard } = connectTodb(req.tenantDB);

  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const covid = new mongoDB.ObjectId(id);

    const findNoticeBoard = await noticeBoard.findOne({ _id: covid });

    if (!findNoticeBoard)
      throw new Error("Please select valid noticeboard to delete");

    const deletedData = await noticeBoard.deleteOne({ _id: covid });

    res
      .status(200)
      .json({ msg: "Notice board deleted successfully", data: deletedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getNoticeByStudent = async (req, res) => {
  const { noticeBoard, student } = connectTodb(req.tenantDB);

  if (!req.tenantDB) {
    return res.status(500).json({ error: "No tenant DB available" });
  }

  try {
    const { userID } = req;

    const foundStudent = await student.findOne({ globalId: userID });

    if (!foundStudent) {
      return res.status(404).json({ message: "Student not found" });
    }

    const noticeBoardIds = foundStudent.noticeboard?.map((e) => {
      return new ObjectId(e);
    });

    if (!noticeBoardIds || noticeBoardIds.length === 0) {
      return res.status(200).json([]);
    }
    const notices = await noticeBoard
      .find({ _id: { $in: noticeBoardIds } })
      .limit(20)
      .toArray();

    res.status(200).json({ data: notices });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.markAsRead = async (req, res) => {
  try {
    if (!req.tenantDB) {
      return res.status(500).json({ error: "No tenant DB available" });
    }
    const { noticeBoard } = connectTodb(req.tenantDB);

    const { noticeId, userId } = req.body;

    const udatedNotice = await noticeBoard.findOneAndUpdate(
      { _id: new ObjectId(noticeId) },
      {
        $addToSet: {
          readBy: userId,
        },
      },
      {
        returnDocument: "after",
      }
    );
    res.status(200).json(udatedNotice);
  } catch (error) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
