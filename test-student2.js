const { MongoClient } = require("mongodb");
async function run() {
  const uri = "mongodb://127.0.0.1:27017/KSquare";
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("KSquare"); // or whatever the main DB is
  // let's just find any tenant DB and check students
  const adminDb = client.db("SM-DEV-TENANT-DB");
  const student = await adminDb.collection("students").findOne({ type: "student" }, { sort: { _id: -1 } });
  console.log("Latest student:", student);
  process.exit(0);
}
run();
