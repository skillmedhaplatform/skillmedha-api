'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { MongoClient } = require('mongodb');
const config = require('../src/config');
const { defaultWebsiteCompanyExams } = require('../src/shared/data/defaultWebsiteCompanyExams');

async function seed() {
  const url = config.mongo.getUrl();
  console.log(`[Seed] Connecting to MongoDB: ${url.replace(/:([^:@]+)@/, ':****@')}`);
  
  const client = new MongoClient(url);
  try {
    await client.connect();
    console.log('[Seed] Connected successfully.');

    const dbName = config.mongo.websiteDbName || 'website';
    const db = client.db(dbName);
    const companyExamsCol = db.collection('companyExams');
    const settingsCol = db.collection('settings');

    console.log(`[Seed] Clearing existing static items in ${dbName}.companyExams...`);
    await companyExamsCol.deleteMany({});

    console.log(`[Seed] Inserting ${defaultWebsiteCompanyExams.length} default company exams...`);
    const docs = defaultWebsiteCompanyExams.map(s => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await companyExamsCol.insertMany(docs);
    console.log(`[Seed] Inserted ${docs.length} company exams.`);

    console.log(`[Seed] Setting up company_data_mode in ${dbName}.settings...`);
    await settingsCol.updateOne(
      { key: 'company_data_mode' },
      {
        $set: {
          key: 'company_data_mode',
          value: 'static',
          updatedAt: new Date(),
          updatedBy: 'cli_seed_script'
        }
      },
      { upsert: true }
    );

    // Create indexes
    await companyExamsCol.createIndex({ id: 1 }, { unique: true });
    await companyExamsCol.createIndex({ order: 1 });
    await settingsCol.createIndex({ key: 1 }, { unique: true });

    console.log('[Seed] Completed successfully! Company exams mode is set to "static".');
  } catch (err) {
    console.error('[Seed] Error during seeding:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seed();
