const { MongoClient } = require("mongodb");
require("dotenv").config();
async function run() {
  const uri = process.env.MONGO_URI;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("SM-DEV-TENANT-DB");
  const student = await db.collection("students").findOne({ type: "student" }, { sort: { _id: -1 } });
  console.log("Latest student:", {
    email: student.email,
    createdAt: student.createdAt,
    typeOfCreatedAt: typeof student.createdAt
  });
  process.exit(0);
}
run();
