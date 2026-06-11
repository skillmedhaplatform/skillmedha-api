/**
 * awsS3Service.js
 * Handles AWS S3 operations for ATS resume file uploads and deletions.
 *
 * Required npm packages:
 *   npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
 *
 * Required environment variables (add to your .env):
 *   AWS_ACCESS_KEY_ID=your_access_key
 *   AWS_SECRET_ACCESS_KEY=your_secret_key
 *   AWS_REGION=us-east-1
 *   S3_BUCKET_NAME=your-bucket-name
 *
 * Place this file in your Node.js/Express API repo under: services/awsS3Service.js
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

// AWS S3 Configuration
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

// Lazy-initialized S3 client
let _s3Client = null;
const getS3Client = () => {
  if (!_s3Client) {
    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
      throw new Error("AWS credentials or S3_BUCKET_NAME environment variables are not set.");
    }
    _s3Client = new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3Client;
};

/**
 * Generate a unique file key for S3 storage
 * @param {string} originalFilename - Original file name
 * @param {string} studentId - Student identifier
 * @returns {string} Unique S3 key
 */
const generateFileKey = (originalFilename, studentId) => {
  const timestamp = Date.now();
  const extension = path.extname(originalFilename);
  const basename = path.basename(originalFilename, extension);
  const uniqueId = uuidv4().substring(0, 8);
  return `resumes/${studentId}/${timestamp}_${uniqueId}_${basename}${extension}`;
};

/**
 * Upload a file buffer to S3
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} originalFilename - Original file name
 * @param {string} studentId - Student identifier
 * @param {string} mimeType - File MIME type
 * @returns {Promise<{key: string, url: string, bucket: string}>}
 */
const uploadFileToS3 = async (fileBuffer, originalFilename, studentId, mimeType) => {
  try {
    const s3Client = getS3Client();
    const fileKey = generateFileKey(originalFilename, studentId);

    const uploadParams = {
      Bucket: S3_BUCKET_NAME,
      Key: fileKey,
      Body: fileBuffer,
      ContentType: mimeType,
      // Optional: Add metadata
      Metadata: {
        originalFilename,
        studentId,
        uploadedAt: new Date().toISOString(),
      },
    };

    // Use Upload class for better handling of large files
    const upload = new Upload({
      client: s3Client,
      params: uploadParams,
    });

    const result = await upload.done();

    // Generate public URL (assuming bucket is public or you have CloudFront)
    const fileUrl = `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${fileKey}`;

    return {
      key: fileKey,
      url: fileUrl,
      bucket: S3_BUCKET_NAME,
      region: AWS_REGION,
    };
  } catch (error) {
    console.error("Error uploading file to S3:", error);
    throw new Error(`Failed to upload file to S3: ${error.message}`);
  }
};

/**
 * Delete a file from S3
 * @param {string} fileKey - S3 file key to delete
 * @returns {Promise<{success: boolean, key: string}>}
 */
const deleteFileFromS3 = async (fileKey) => {
  try {
    const s3Client = getS3Client();

    const deleteParams = {
      Bucket: S3_BUCKET_NAME,
      Key: fileKey,
    };

    const command = new DeleteObjectCommand(deleteParams);
    await s3Client.send(command);

    return {
      success: true,
      key: fileKey,
    };
  } catch (error) {
    console.error("Error deleting file from S3:", error);
    throw new Error(`Failed to delete file from S3: ${error.message}`);
  }
};

/**
 * Check if a file exists in S3
 * @param {string} fileKey - S3 file key to check
 * @returns {Promise<boolean>}
 */
const fileExistsInS3 = async (fileKey) => {
  try {
    const s3Client = getS3Client();

    const headParams = {
      Bucket: S3_BUCKET_NAME,
      Key: fileKey,
    };

    const command = new GetObjectCommand(headParams);
    await s3Client.send(command);
    return true;
  } catch (error) {
    if (error.name === "NoSuchKey" || error.name === "NotFound") {
      return false;
    }
    console.error("Error checking file existence in S3:", error);
    throw new Error(`Failed to check file existence: ${error.message}`);
  }
};

module.exports = {
  uploadFileToS3,
  deleteFileFromS3,
  fileExistsInS3,
  generateFileKey,
};