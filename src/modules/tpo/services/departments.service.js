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
