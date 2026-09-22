'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const config = {
  env: process.env.NODE_ENV || 'dev',

  // Server
  port: parseInt(process.env.PORT || '3000', 10),

  // MongoDB
  mongo: {
    useLocal: process.env.USE_LOCAL_DB === 'true',
    uri: process.env.MONGO_URI || null,
    user: process.env.MONGO_USER || '',
    pass: process.env.MONGO_PASS || '',
    host: process.env.MONGO_HOST || '3.108.190.62',
    port: process.env.MONGO_PORT || '27017',
    authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
    sharedDbName: process.env.SHARED_DB_NAME || 'KSquare',
    defaultDb: 'SkilmedhaDefault',
    resourcesDb: 'skillmedha_resources',
    ksquareDb: 'KSquare',
    archiveDbName: process.env.ARCHIVE_DB_NAME || 'Archive',
    reviewsDbName: process.env.REVIEWS_DB_NAME || 'reviews',
  },

  // Redis
  redis: {
    enabled: process.env.USE_LOCAL_REDIS === 'true',
    useLocal: process.env.USE_LOCAL_REDIS === 'true',
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    pass: process.env.REDIS_PASS || null,
    useTls: process.env.REDIS_USE_TLS === 'true',
  },

  // Auth
  auth: {
    jwtSecret: process.env.JWT_SECRET || '',
    cryptoSecret: process.env.CRYPTOSECRET || '',
    encryptionKey: process.env.ENCRYPTION_KEY || '',
  },

  // Rate limiter
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '10000000', 10),
  },

  // Email
  email: {
    supportMail: process.env.support_mail || '',
    supportPass: process.env.support_pass || '',
    noreplyMail: process.env.noreply_mail || '',
    noreplyPass: process.env.noreply_pass || '',
  },

  // Razorpay
  razorpay: {
    keyId: process.env.RZP_ID || '',
    keySecret: process.env.RZP_SECRET || '',
  },

  // Agora
  agora: {
    appId: process.env.AGORA_APP_ID || '',
    appCertificate: process.env.AGORA_APP_CERTIFICATE || '',
    clientId: process.env.AGORA_CLIENTID || '',
    clientSecret: process.env.AGORA_CLIENTSECRET || '',
  },

  // AWS
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    s3Key: process.env.AWS_KEY_S3 || '',
    s3Secret: process.env.AWS_SECRET_S3 || '',
    s3Bucket: process.env.AWS_S3_BUCKET || 'proctoringrecordings',
    rekogKey: process.env.AWS_REKOG_KEY || '',
    rekogSecret: process.env.AWS_REKOG_SECRET || '',
    accountId: process.env.AWS_ACCOUNT_ID || '',
    rekognitionRoleArn: process.env.REKOGNITION_ROLE_ARN || '',
  },

  // Azure
  azure: {
    storageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
    storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || '',
    storageAccountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY || '',
    storageContainerName: process.env.AZURE_STORAGE_CONTAINER_NAME || 'skillmedha-uploads',
    proctoringContainerName: process.env.AZURE_PROCTORING_CONTAINER_NAME || 'proctoringrecordings',
  },

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    orgId: process.env.OPENAI_ORGID || '',
    projId: process.env.OPENAI_PROJID || '',
  },

  // Zoom
  zoom: {
    accountId: process.env.ZOOM_ACCOUNT_ID || '',
    clientId: process.env.ZOOM_CLIENT_ID || '',
    clientSecret: process.env.ZOOM_CLIENT_SECRET || '',
    webhookSecret: process.env.ZOOM_WEBHOOK_SECRET || '',
    verifySecret: process.env.ZOOM_Verify_SECRET || '',
    sdkKey: process.env.ZOOM_SDK_KEY || '',
    sdkSecret: process.env.ZOOM_SDK_SECRET || '',
  },

  // URLs
  urls: {
    studentVerify: process.env.STUDENT_VERIFY_URL || '',
    restApi: process.env.REST_URL || '',
    studentPortal: process.env.STUDENT_PORTAL_URL || '',
    socketServer: process.env.SOCKET_SERVER_URL || '',
    notiPort: parseInt(process.env.NOTI_PORT || '2005', 10),
  },
};

/**
 * Returns the MongoDB connection URL based on environment flags.
 */
config.mongo.getUrl = function () {
  if (config.mongo.useLocal) return 'mongodb://localhost:27017';
  if (config.mongo.uri) return config.mongo.uri;
  return `mongodb://${config.mongo.user}:${config.mongo.pass}@${config.mongo.host}:${config.mongo.port}/?authSource=${config.mongo.authSource}`;
};

module.exports = config;
