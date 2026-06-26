const { MongoClient } = require('mongodb');

async function main() {
  const uri = "mongodb://127.0.0.1:27017";
  const client = new MongoClient(uri);
  
  try {
    await client.connect();
    const adminDb = client.db('admin');
    const dbsInfo = await adminDb.admin().listDatabases();
    const dbs = dbsInfo.databases.map(db => db.name);
    
    let found = false;
    for (const dbName of dbs) {
      if (dbName === 'admin' || dbName === 'config' || dbName === 'local') continue;
      const db = client.db(dbName);
      
      // Check 'student' collection
      const student = await db.collection('student').findOne({ email: "nakkavpkavyasudha@gmail.com" });
      if (student) {
        console.log(`Found in Database: ${dbName} | Collection: student | orgId: ${student.orgId}`);
        found = true;
      }
      
      // Check 'users' collection
      const user = await db.collection('users').findOne({ email: "nakkavpkavyasudha@gmail.com" });
      if (user) {
        console.log(`Found in Database: ${dbName} | Collection: users | orgId: ${user.orgId}`);
        found = true;
      }
    }
    
    if (!found) {
      console.log("Email not found in any local database.");
    }
  } catch (e) {
    console.error(e);
  } finally {
    await client.close();
  }
}

main();
