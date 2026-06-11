'use strict';

const express = require('express');
const cors = require('cors');
require('dotenv').config({
  path: require('path').resolve(__dirname, '../../.env'),
});

const connectDB = require('./config/db');

const app = express();

// ─── Env validation ─────────────────────────────────────────
const requiredEnvVars = [
  'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_STORAGE_CONTAINER_NAME',
  'MONGO_URI',
];

const missingEnvVars = requiredEnvVars.filter(
  (name) => !process.env[name]
);

if (missingEnvVars.length > 0) {
  console.warn(
    `[Startup] Missing environment variables: ${missingEnvVars.join(', ')}`
  );
}

// ─── DB Connection ──────────────────────────────────────────
connectDB();

// ─── Middlewares ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ────────────────────────────────────────────────
const atsRouter = require('./routes/ats');
const fileUploadRouter = require('./routes/fileUpload');

app.use('/ats', atsRouter);
app.use('/api', fileUploadRouter);

// ─── Health Check ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'ATS API is running' });
});

module.exports = app;