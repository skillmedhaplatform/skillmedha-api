'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { MongoClient } = require('mongodb');
const config = require('../src/config');
const { defaultWebsiteInternships } = require('../src/shared/data/defaultWebsiteInternships');

async function seed() {
  const url = config.mongo.getUrl();
  console.log(`[Seed] Connecting to MongoDB: ${url.replace(/:([^:@]+)@/, ':****@')}`);
  
  const client = new MongoClient(url);
  try {
    await client.connect();
    console.log('[Seed] Connected successfully.');

    const dbName = config.mongo.websiteDbName || 'website';
    const db = client.db(dbName);
    const internshipsCol = db.collection('internships');
    const settingsCol = db.collection('settings');

    console.log(`[Seed] Clearing existing static items in ${dbName}.internships...`);
    await internshipsCol.deleteMany({});

    console.log(`[Seed] Inserting ${defaultWebsiteInternships.length} default internships...`);
    const docs = defaultWebsiteInternships.map(s => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await internshipsCol.insertMany(docs);
    console.log(`[Seed] Inserted ${docs.length} internships into ${dbName}.internships.`);

    console.log(`[Seed] Setting up internships_data_mode in ${dbName}.settings...`);
    await settingsCol.updateOne(
      { key: 'internships_data_mode' },
      {
        $set: {
          key: 'internships_data_mode',
          value: 'static',
          updatedAt: new Date(),
          updatedBy: 'cli_seed_script'
        }
      },
      { upsert: true }
    );

    // Create indexes
    await internshipsCol.createIndex({ id: 1 }, { unique: true });
    await internshipsCol.createIndex({ order: 1 });
    await settingsCol.createIndex({ key: 1 }, { unique: true });

    console.log('[Seed] Completed successfully! Internships mode is set to "static".');
  } catch (err) {
    console.error('[Seed] Error during seeding internships:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seed();
