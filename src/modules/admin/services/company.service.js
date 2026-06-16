require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});

const express = require("express");
const mongoDB = require("mongodb");
const bcrypt = require("bcryptjs");
const CryptoJS = require("crypto-js");

const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const { mainDBusers, categories } = require("../../../shared/db/connection").getGlobalCollections();

const secretToken = process.env.CRYPTOSECRET;

const app = express();

app.use(authenticate);
app.use(selectTenantDB);

module.exports.createCompany = async (req, res) => {
  const { company } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { email, password, type = "admin" } = req.body;

    const findUser = await company.findOne({ email: email });

    if (findUser) throw new Error("company already created");

    const salt = await bcrypt.genSalt();

    const hash = await bcrypt.hash(password, salt);

    const createUser = await company.insertOne({
      ...req.body,
      password: hash,
      type: "company",
      createdAt: new Date().toLocaleString(),
      active: true,
    });

    const createdMainDB = await mainDBusers.insertOne({
      email: req.body.email,
      password: req.body.password,
      orgId: req.body.orgId,
      type: req.body.type,
      createdAt: new Date().getTime(),
      globalId: createUser.insertedId.toString(),
      active: true,
    });

    await company.updateOne(
      {
        _id: createUser.insertedId,
      },
      { $set: { globalId: createdMainDB.insertedId.toString() } }
    );

    const loginData = {
      userID: createdMainDB.insertedId.toString(),
      email: email,
    };
    const token = CryptoJS.AES.encrypt(
      JSON.stringify(loginData),
      secretToken
    ).toString();

    res.status(200).send({
      msg: "Account Created Successfully",
      data: createUser,

      token,
    });
  } catch (error) {
    console.log(`error while creating Company : ${error.message}`);
    res
      .status(500)
      .json({ err: `error while creating Company : ${error.message}` });
  }
};

module.exports.loginCompany = async (req, res) => {
  const { company } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { email, password } = req.body;

    const findUser = await company.findOne({ email: email });

    if (!findUser?._id) throw new Error("Company not registered");

    const exp = "30days";
    const storedPassword = findUser.password;

    const compare = await bcrypt.compare(password, storedPassword);
    if (!compare) throw new Error("password incorrect");

    const loginData = {
      userID: findUser._id,
      email: findUser.email,
      userName: findUser.userName,
      role: findUser.role,
    };

    const token = CryptoJS.AES.encrypt(
      JSON.stringify(loginData),
      secretToken
    ).toString();

    await company.updateOne({ id: findUser._id }, { $set: { token: token } });

    res
      .status(200)
      .send({ msg: "loggedin successfully", ...loginData, token: token });
  } catch (error) {
    console.log(`error while login user : ${error.message}`);
    res.status(500).json({ err: `error while login user : ${error.message}` });
  }
};

module.exports.getCompany = async (req, res) => {
  const { company, users } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    if (!req.isAuth) {
      return res.status(401).json({ err: "Company not authorised" });
    }
    const { userID } = req;

    let findUser = await company.findOne({
      globalId: userID,
    });

    if (!findUser) {
      findUser = await users.findOne({
        globalId: userID,
      });
    }

    if (!findUser) return res.status(401).json({ err: "Company not registered" });
    
    res.status(200).json({ data: findUser });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateCompany = async (req, res) => {
  const { company, users } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    if (!req.isAuth) {
      return res.status(401).json({ err: "Company not authorised" });
    }
    const { userID } = req;

    let findUser = await company.findOne({
      globalId: userID,
    });
    let targetCollection = company;

    if (!findUser) {
      findUser = await users.findOne({
        globalId: userID,
      });
      targetCollection = users;
    }

    if (!findUser) return res.status(404).json({ err: "Company not registered" });

    const updateUser = await targetCollection.updateOne(
      {
        _id: findUser._id,
      },
      {
        $set: {
          ...req.body,
          updatedAt: new Date().getTime(),
        },
      }
    );

    res
      .status(200)
      .json({ msg: "Company updated successfully", data: updateUser });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.getAvailableSkills = async (req, res) => {
  try {
    const data = await categories.find({}).toArray();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
module.exports.getJobsByOrgPaginated = async (req, res) => {
  try {
    const { orgId } = req.params;
    let { page = 1, limit = 10 } = req.query;

    if (!orgId) {
      return res.status(400).json({
        success: false,
        error: "Missing orgId",
      });
    }

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    // Calculate offset
    const offset = (page - 1) * limit;

    // Import necessary utilities
    const { getTenantDB } = require("../../../shared/db/connection");
    const { organisation } = require("../../../shared/db/connection").getGlobalCollections();

    // Verify organization exists
    const orgRecord = await organisation.findOne({ orgId });
    if (!orgRecord) {
      return res.status(404).json({
        success: false,
        error: `Organization "${orgId}" not found`,
      });
    }

    // Get tenant database and access jobs collection
    const tenantDB = await getTenantDB(orgId);
    const jobs = tenantDB.collection("job");

    // Get total count for calculating total pages
    const totalJobs = await jobs.countDocuments();

    // Build aggregation pipeline
    const pipeline = [
      { $sort: { _id: -1 } }, // Sort by newest first
      { $skip: offset },
      { $limit: limit },
    ];

    // Execute aggregation
    const jobsList = await jobs.aggregate(pipeline).toArray();

    // Calculate total pages
    const totalPages = Math.ceil(totalJobs / limit);

    res.status(200).json({
      success: true,
      orgId,
      orgName: orgRecord.name,
      jobs: jobsList,
      pagination: {
        currentPage: page,
        totalPages,
        totalJobs,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        nextPage: page < totalPages ? page + 1 : null,
        prevPage: page > 1 ? page - 1 : null,
      },
    });
  } catch (error) {
    console.error("Error fetching jobs:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

module.exports.getUsersByOrgPaginated = async (req, res) => {
  try {
    const { orgId } = req.params;
    let { page = 1, limit = 10 } = req.query;

    if (!orgId) {
      return res.status(400).json({
        success: false,
        error: "Missing orgId",
      });
    }

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    // Calculate offset
    const offset = (page - 1) * limit;

    // Import necessary utilities
    const { getTenantDB } = require("../../../shared/db/connection");
    const { organisation } = require("../../../shared/db/connection").getGlobalCollections();

    // Verify organization exists
    const orgRecord = await organisation.findOne({ orgId });
    if (!orgRecord) {
      return res.status(404).json({
        success: false,
        error: `Organization "${orgId}" not found`,
      });
    }

    // Get tenant database and access company/users collection
    const tenantDB = await getTenantDB(orgId);
    const company = tenantDB.collection("users");

    // Get total count for calculating total pages
    const totalUsers = await company.countDocuments();

    // Build aggregation pipeline
    const pipeline = [
      { $sort: { _id: -1 } }, // Sort by newest first
      { $skip: offset },
      { $limit: limit },
      {
        $project: {
          password: 0,
          token: 0,
        },
      },
    ];

    // Execute aggregation
    const usersList = await company.aggregate(pipeline).toArray();

    // Calculate total pages
    const totalPages = Math.ceil(totalUsers / limit);

    res.status(200).json({
      success: true,
      orgId,
      orgName: orgRecord.name,
      users: usersList,
      pagination: {
        currentPage: page,
        totalPages,
        totalUsers,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        nextPage: page < totalPages ? page + 1 : null,
        prevPage: page > 1 ? page - 1 : null,
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
