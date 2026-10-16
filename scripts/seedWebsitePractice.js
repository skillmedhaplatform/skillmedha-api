'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { MongoClient } = require('mongodb');
const config = require('../src/config');
const { defaultWebsitePracticeSets } = require('../src/shared/data/defaultWebsitePractice');

async function seed() {
  const url = config.mongo.getUrl();
  console.log(`[Seed] Connecting to MongoDB: ${url.replace(/:([^:@]+)@/, ':****@')}`);
  
  const client = new MongoClient(url);
  try {
    await client.connect();
    console.log('[Seed] Connected successfully.');

    const dbName = config.mongo.websiteDbName || 'website';
    const db = client.db(dbName);
    const practiceCol = db.collection('practice');
    const settingsCol = db.collection('settings');

    console.log(`[Seed] Clearing existing static items in ${dbName}.practice...`);
    await practiceCol.deleteMany({});

    console.log(`[Seed] Inserting ${defaultWebsitePracticeSets.length} default practice sets...`);
    const docs = defaultWebsitePracticeSets.map(s => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await practiceCol.insertMany(docs);
    console.log(`[Seed] Inserted ${docs.length} practice sets.`);

    console.log(`[Seed] Setting up practice_data_mode in ${dbName}.settings...`);
    await settingsCol.updateOne(
      { key: 'practice_data_mode' },
      {
        $set: {
          key: 'practice_data_mode',
          value: 'static',
          updatedAt: new Date(),
          updatedBy: 'cli_seed_script'
        }
      },
      { upsert: true }
    );

    // Create indexes
    await practiceCol.createIndex({ id: 1 }, { unique: true });
    await practiceCol.createIndex({ order: 1 });
    await settingsCol.createIndex({ key: 1 }, { unique: true });

    console.log('[Seed] Completed successfully! Practice mode is set to "static".');
  } catch (err) {
    console.error('[Seed] Error during seeding:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seed();
