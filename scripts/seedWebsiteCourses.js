'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { MongoClient } = require('mongodb');
const config = require('../src/config');
const { defaultWebsiteCourses } = require('../src/shared/data/defaultWebsiteCourses');

async function seed() {
  const url = config.mongo.getUrl();
  console.log(`[Seed] Connecting to MongoDB: ${url.replace(/:([^:@]+)@/, ':****@')}`);
  
  const client = new MongoClient(url);
  try {
    await client.connect();
    console.log('[Seed] Connected successfully.');

    const dbName = config.mongo.websiteDbName || 'website';
    const db = client.db(dbName);
    const coursesCol = db.collection('courses');
    const settingsCol = db.collection('settings');

    console.log(`[Seed] Clearing existing static items in ${dbName}.courses...`);
    await coursesCol.deleteMany({});

    console.log(`[Seed] Inserting ${defaultWebsiteCourses.length} default courses...`);
    const docs = defaultWebsiteCourses.map(s => ({
      ...s,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    await coursesCol.insertMany(docs);
    console.log(`[Seed] Inserted ${docs.length} courses into ${dbName}.courses.`);

    console.log(`[Seed] Setting up courses_data_mode in ${dbName}.settings...`);
    await settingsCol.updateOne(
      { key: 'courses_data_mode' },
      {
        $set: {
          key: 'courses_data_mode',
          value: 'static',
          updatedAt: new Date(),
          updatedBy: 'cli_seed_script'
        }
      },
      { upsert: true }
    );

    // Create indexes
    await coursesCol.createIndex({ id: 1 }, { unique: true });
    await coursesCol.createIndex({ order: 1 });
    await settingsCol.createIndex({ key: 1 }, { unique: true });

    console.log('[Seed] Completed successfully! Courses mode is set to "static".');
  } catch (err) {
    console.error('[Seed] Error during seeding courses:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seed();
