// src/config/database.js
const { MongoClient } = require("mongodb");

let client;
let kSquareDB;
let globalDB;

const getMongoUrl = require("../../../../shared/db/connection").getMongoUrl;

const connectDB = async () => {
  try {
    const uri = getMongoUrl();

    client = new MongoClient(uri);
    await client.connect();

    kSquareDB = client.db(process.env.KSQUARE_DB_NAME || "KSquare");
    globalDB = client.db(process.env.GLOBAL_DB_NAME || "SkilmedhaDefault");

    return { kSquareDB, globalDB };
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error.message);
    process.exit(1);
  }
};

const getKSquareDB = () => {
  if (!kSquareDB) {
    throw new Error("KSquare Database not initialized");
  }
  return kSquareDB;
};

const getGlobalDB = () => {
  if (!globalDB) {
    throw new Error("Global Database not initialized");
  }
  return globalDB;
};

const getOrgDB = (orgId) => {
  if (!client) {
    throw new Error("MongoDB client not initialized");
  }
  // For college orgs, use their specific database
  const dbName = `${orgId}`;
  return client.db(dbName);
};

const closeDB = async () => {
  if (client) {
    await client.close();
  }
};
const getResourcesDB = () => {
  if (!client) {
    throw new Error("MongoDB client not initialized");
  }
  return client.db("skillmedha_resources");
};
const getClient = () => {
  if (!client) {
    throw new Error("MongoDB client not initialized");
  }
  return client;
};
module.exports = {
  connectDB,
  getKSquareDB,
  getGlobalDB,
  getOrgDB,
  closeDB,
  getResourcesDB,
  getClient,
};
