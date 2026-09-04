require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});
const express = require("express");
const mongoDB = require("mongodb");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const CryptoJS = require("crypto-js");

const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb } = require("../../../shared/db/connection");
const { mainDBusers } = require("../../../shared/db/connection").getGlobalCollections();
const { getTenantDB } = require("../../../shared/db/connection");
const { archiveAndDeleteOne } = require("../../../shared/utils/archive.service");

const secretToken = process.env.CRYPTOSECRET;

const app = express();

app.use(cors());
app.use(authenticate);
app.use(selectTenantDB);

module.exports.createTpo = async (req, res) => {
  const { tpo } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { email, password, type = "admin" } = req.body;

    const findUser = await tpo.findOne({ email: email });

    if (findUser) throw new Error("User already created");

    const salt = await bcrypt.genSalt();

    const hash = await bcrypt.hash(password, salt);

    const createUser = await tpo.insertOne({
      ...req.body,
      password: hash,
      type,
      createdAt: new Date().toLocaleString(),
      active: true,
    });

    const createdMainDB = await mainDBusers.insertOne({
      email: req.body.email,
      password: req.body.password,
      orgId: req.body.orgId,
      type: req.body.type || "tpo",
      createdAt: new Date().getTime(),
      globalId: createUser.insertedId.toString(),
      active: true,
    });

    await tpo.updateOne(
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
    res
      .status(500)
      .json({ err: `error while creating user : ${error.message}` });
  }
};

module.exports.loginTpo = async (req, res) => {
  const { tpo } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { email, password } = req.body;

    const findUser = await tpo.findOne({ email: email });

    if (!findUser?._id) throw new Error("User not registered");

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

    await tpo.updateOne({ id: findUser._id }, { $set: { token: token } });

    res
      .status(200)
      .send({ msg: "loggedin successfully", ...loginData, token: token });
  } catch (error) {
    res.status(500).json({ err: `error while login user : ${error.message}` });
  }
};

module.exports.getTpo = async (req, res) => {
  const { tpo } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    if (!req.isAuth) {
      return res.status(401).json({ err: "User not authorised" });
    }
    const { userID } = req;

    const findUser = await tpo.findOne({
      globalId: userID,
    });

    if (!findUser) throw new Error("User not registered");
    res.status(200).json({ data: findUser });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateTpo = async (req, res) => {
  const { tpo } = connectTodb(req.tenantDB);
  if (!req.tenantDB)
    return res.status(500).json({ error: "No tenant DB available" });
  try {
    if (!req.isAuth) {
      return res.status(401).json({ err: "User not authorised" });
    }
    const { userID } = req;

    const findUser = await tpo.findOne({
      globalId: userID,
    });

    if (!findUser) throw new Error("User not registered");

    const updateUser = await tpo.updateOne(
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

    res.status(200).json({ msg: "Tpo updated successfully", data: updateUser });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.toggleTpoStatus = async (req, res) => {
  try {
    if (!req.isAuth) {
      return res.status(401).json({ err: "User not authorised" });
    }
    const { tpoId } = req.params;
    const { active } = req.body;

    const findUser = await mainDBusers.findOne({
      _id: new mongoDB.ObjectId(tpoId),
    });

    if (!findUser) throw new Error("User not registered");

    const result = await mainDBusers.updateOne(
      { _id: new mongoDB.ObjectId(tpoId) },
      { $set: { active: active } }
    );

    if (findUser.orgId) {
      const db = await getTenantDB(findUser.orgId, 5);
      const { tpo } = connectTodb(db);
      await tpo.updateOne(
        { globalId: tpoId },
        { $set: { active: active } }
      );
    }

    res.status(200).json({
      msg: `TPO successfully ${active ? 'activated' : 'deactivated'}`,
      active: active
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.deleteTpo = async (req, res) => {
  try {
    if (!req.isAuth) {
      return res.status(401).json({ err: "User not authorised" });
    }
    const { tpoId } = req.params;
    const { orgId } = req.query;
    const db = await getTenantDB(orgId, 5);
    const { tpo } = connectTodb(db);

    const findUser = await tpo.findOne({
      globalId: tpoId,
    });

    if (!findUser) throw new Error("User not registered");

    const archiveResult = await archiveAndDeleteOne(tpo, { _id: findUser._id }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
    });

    if (archiveResult.deletedCount === 0) {
      throw new Error('Failed to delete tpo after archival');
    }

    await archiveAndDeleteOne(mainDBusers, { _id: new mongoDB.ObjectId(tpoId) }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
    });

    res.status(200).json({ msg: "Tpo deleted successfully", data: archiveResult.deletedDocument });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
