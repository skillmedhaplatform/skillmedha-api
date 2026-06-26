const { MongoClient } = require("mongodb");
async function run() {
  const uri = "mongodb://127.0.0.1:27017/KSquare";
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("KSquare");
  const tenant = await db.collection("organisations").findOne({ type: "tenant" });
  console.log("Tenant DB:", tenant ? tenant.dbName : "Not found");
  
  if (tenant) {
    const tenantDb = client.db(tenant.dbName);
    const student = await tenantDb.collection("student").findOne({}, { sort: { _id: -1 } });
    console.log("Latest student in tenant db:", student);
  }
  process.exit(0);
}
run();
