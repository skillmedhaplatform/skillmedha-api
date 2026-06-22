const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const config = require('./src/config/index.js');

async function run() {
  const uri = config.mongo.getUrl();
  console.log("Connecting to:", uri);
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('SkilmedhaDefault');
    const salt = await bcrypt.genSalt();
    const hash = await bcrypt.hash('qwerty', salt);
    
    await db.collection('users').updateOne({ email: 'praneethvippili@gmail.com' }, { $set: { password: hash } });
    
    const tenantDB = client.db('vivek_6895eef624f51f79dee3771c');
    await tenantDB.collection('student').updateOne({ email: 'praneethvippili@gmail.com' }, { $set: { password: hash } });

    console.log('Password set to qwerty for both collections!');
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}
run();
