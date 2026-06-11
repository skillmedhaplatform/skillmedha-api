/**
 * azureBlobService.js
 * Handles all Azure Blob Storage operations for ATS resume files.
 * Stores both original uploaded resumes and AI-generated updated resumes.
 *
 * Required npm packages:
 *   npm install @azure/storage-blob uuid
 *
 * Required environment variables (add to your .env):
 *   AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
 *   AZURE_STORAGE_CONTAINER_NAME=ats-resumes
 *   AZURE_STORAGE_SAS_TOKEN_EXPIRY_HOURS=24
 *
 * Place this file in your Node.js/Express API repo under: services/azureBlobService.js
 */

const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

// CONFIGURE: Set these environment variables in your .env file
const AZURE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER_NAME || "ats-resumes";
// SAS token expiry for secure download links (default 24 hours)
const SAS_EXPIRY_HOURS = parseInt(process.env.AZURE_STORAGE_SAS_TOKEN_EXPIRY_HOURS || "24", 10);

const parseConnectionString = (connectionString) => {
  return (connectionString || "").split(";").reduce((acc, part) => {
    const [key, ...valueParts] = part.split("=");
    if (!key || valueParts.length === 0) return acc;
    acc[key.trim()] = valueParts.join("=");
    return acc;
  }, {});
};

const connectionStringParts = parseConnectionString(AZURE_CONNECTION_STRING || "");
const AZURE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME || connectionStringParts.AccountName;
const AZURE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY || connectionStringParts.AccountKey;

// Lazy-initialized client to avoid startup failures if env vars not set
let _blobServiceClient = null;
const getBlobServiceClient = () => {
  if (!_blobServiceClient) {
    if (!AZURE_CONNECTION_STRING) {
      throw new Error("AZURE_STORAGE_CONNECTION_STRING environment variable is not set.");
    }
    _blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONNECTION_STRING);
  }
  return _blobServiceClient;
};

const ensureContainerExists = async () => {
  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(CONTAINER_NAME);
  const response = await containerClient.createIfNotExists();
  if (response.succeeded) {
    console.info(`[AzureBlobService] Created container "${CONTAINER_NAME}".`);
  } else {
    console.info(`[AzureBlobService] Using existing container "${CONTAINER_NAME}".`);
  }
  return containerClient;
};

/**
 * Upload a file buffer to Azure Blob Storage.
 *
 * @param {Buffer} fileBuffer - File content as Buffer
 * @param {string} originalFileName - Original filename (used for extension)
 * @param {string} studentId - Student ID (used in blob path for organization)
 * @param {string} fileType - "original" | "updated"
 * @returns {{ blobName: string, blobUrl: string, sasUrl: string }}
 */
const uploadResumeFile = async (fileBuffer, originalFileName, studentId, fileType = "original") => {
  if (!fileBuffer || !fileBuffer.length) {
    throw new Error("File buffer is empty or invalid.");
  }

  const containerClient = await ensureContainerExists();

  // Generate unique blob name: ats-resumes/{studentId}/{fileType}/{uuid}{ext}
  const ext = path.extname(originalFileName).toLowerCase() || ".pdf";
  const blobName = `${studentId}/${fileType}/${uuidv4()}${ext}`;

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  // Determine content type
  const contentType = ext === ".pdf" ? "application/pdf"
    : ext === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/msword";

  await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobContentDisposition: `attachment; filename="${originalFileName}"`,
    },
    metadata: {
      studentId,
      fileType,
      uploadedAt: new Date().toISOString(),
    },
  });

  // Generate a time-limited SAS URL for secure download
  const sasUrl = await generateSasUrl(blobName);

  return {
    blobName,
    blobUrl: blockBlobClient.url, // Internal URL (no SAS)
    sasUrl, // Time-limited download URL for client
  };
};

/**
 * Upload a text-based file (e.g., generated resume content as PDF buffer).
 * Wrapper around uploadResumeFile for clarity.
 */
const uploadUpdatedResume = async (fileBuffer, studentId, analysisId) => {
  const fileName = `updated_resume_${analysisId}.pdf`;
  return uploadResumeFile(fileBuffer, fileName, studentId, "updated");
};

/**
 * Generate a time-limited SAS (Shared Access Signature) URL for a blob.
 * This allows clients to download without exposing storage credentials.
 *
 * @param {string} blobName - Blob path in container
 * @param {number} expiryHours - How long the URL is valid (default: env variable)
 * @returns {string} Signed download URL
 */
const generateSasUrl = async (blobName, expiryHours = SAS_EXPIRY_HOURS) => {
  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(CONTAINER_NAME);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const expiresOn = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

  if (!AZURE_ACCOUNT_NAME || !AZURE_ACCOUNT_KEY) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_ACCOUNT_KEY is required to generate a SAS token."
    );
  }

  const sharedKeyCredential = new StorageSharedKeyCredential(
    AZURE_ACCOUNT_NAME,
    AZURE_ACCOUNT_KEY
  );

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER_NAME,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn: new Date(Date.now() - 5 * 60 * 1000),
      expiresOn,
    },
    sharedKeyCredential
  ).toString();

  return `${blockBlobClient.url}?${sasToken}`;
};

/**
 * Delete a blob from Azure Storage (e.g., when user deletes history or file expires).
 *
 * @param {string} blobName - Blob path to delete
 */
const deleteBlob = async (blobName) => {
  if (!blobName) return;
  try {
    const client = getBlobServiceClient();
    const containerClient = client.getContainerClient(CONTAINER_NAME);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.deleteIfExists();
  } catch (err) {
    // Log but don't throw — deletion failures shouldn't break main flow
    console.error(`[AzureBlobService] Failed to delete blob ${blobName}:`, err.message);
  }
};

/**
 * Refresh SAS URL for an existing blob (e.g., when history item is accessed).
 *
 * @param {string} blobName - Existing blob name in storage
 * @returns {string} Fresh SAS URL
 */
const refreshSasUrl = async (blobName) => {
  if (!blobName) return null;
  try {
    return await generateSasUrl(blobName);
  } catch (err) {
    console.error(`[AzureBlobService] Failed to refresh SAS URL for ${blobName}:`, err.message);
    return null;
  }
};

/**
 * Download a resume file from Azure Blob Storage.
 *
 * @param {string} blobName - Blob path in container
 * @returns {{ buffer: Buffer, fileName: string, mimeType: string }}
 */
const downloadResumeFile = async (blobName) => {
  if (!blobName) {
    throw new Error("Blob name is required.");
  }

  const client = getBlobServiceClient();
  const containerClient = client.getContainerClient(CONTAINER_NAME);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  try {
    const downloadResponse = await blockBlobClient.download();
    const buffer = await streamToBuffer(downloadResponse.readableStreamBody);

    // Get blob properties for metadata
    const properties = await blockBlobClient.getProperties();
    const fileName = properties.metadata?.originalFileName || blobName.split('/').pop() || 'resume.pdf';
    const mimeType = properties.contentType || 'application/pdf';

    return {
      buffer,
      fileName,
      mimeType,
    };
  } catch (err) {
    console.error(`[AzureBlobService] Failed to download blob ${blobName}:`, err.message);
    throw new Error(`Failed to download file from Azure Blob Storage: ${err.message}`);
  }
};

/**
 * Helper function to convert a readable stream to a Buffer.
 */
const streamToBuffer = async (readableStream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on('error', reject);
  });
};

module.exports = {
  uploadResumeFile,
  uploadUpdatedResume,
  generateSasUrl,
  deleteBlob,
  refreshSasUrl,
  downloadResumeFile,
};
