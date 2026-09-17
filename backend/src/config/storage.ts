import { Storage } from '@google-cloud/storage';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Google Cloud Storage client
let storage: Storage;
let bucket: any;
const bucketName = process.env.GCS_BUCKET_NAME || 'lms-storage';

try {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;

  if (process.env.GCS_CREDENTIALS_BASE64) {
    // Production: use base64-encoded credentials from environment variable
    const credentials = JSON.parse(
      Buffer.from(process.env.GCS_CREDENTIALS_BASE64, 'base64').toString('utf-8')
    );
    storage = new Storage({ projectId, credentials });
    console.log('✅ Google Cloud Storage initialized with env credentials');
  } else {
    // Local development: use key file
    storage = new Storage({
      projectId,
      keyFilename: path.resolve(__dirname, '../../config/gcs-key.json'),
    });
    console.log('✅ Google Cloud Storage initialized with key file');
  }

  bucket = storage.bucket(bucketName);
} catch (error) {
  console.error('❌ Failed to initialize Google Cloud Storage:', error);
  // Create dummy objects to prevent crashes
  storage = {} as Storage;
  bucket = {};
}

/**
 * Upload a file to Google Cloud Storage
 * @param file - Multer file object
 * @param destination - Path in GCS bucket (e.g., 'course-materials/123/file.pdf')
 * @returns The public URL or file path in GCS
 */
export const uploadFile = async (
  file: Express.Multer.File,
  destination: string
): Promise<{ filePath: string; fileName: string; fileSize: number }> => {
  try {
    const blob = bucket.file(destination);
    const blobStream = blob.createWriteStream({
      resumable: false,
      metadata: {
        contentType: file.mimetype,
      },
    });

    return new Promise((resolve, reject) => {
      blobStream.on('error', (err: any) => {
        reject(new Error(`Upload error: ${err.message}`));
      });

      blobStream.on('finish', () => {
        resolve({
          filePath: destination,
          fileName: file.originalname,
          fileSize: file.size,
        });
      });

      blobStream.end(file.buffer);
    });
  } catch (error) {
    throw new Error(`Failed to upload file: ${error}`);
  }
};

/**
 * Delete a file from Google Cloud Storage
 * @param filePath - Path in GCS bucket
 */
export const deleteFile = async (filePath: string): Promise<void> => {
  try {
    await bucket.file(filePath).delete();
  } catch (error) {
    throw new Error(`Failed to delete file: ${error}`);
  }
};

/**
 * Generate a signed URL for temporary file access
 * @param filePath - Path in GCS bucket
 * @param expiresIn - Expiration time in minutes (default: 60)
 * @returns Signed URL
 */
export const generateSignedUrl = async (
  filePath: string,
  expiresIn: number = 60,
  generation?: string
): Promise<string> => {
  try {
    const [url] = await bucket.file(filePath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresIn * 60 * 1000, // Convert minutes to milliseconds
      ...(generation ? { queryParams: { generation } } : {}),
    });

    return url;
  } catch (error) {
    throw new Error(`Failed to generate signed URL: ${error}`);
  }
};

/**
 * Download a file from Google Cloud Storage
 * @param filePath - Path in GCS bucket
 * @returns File buffer
 */
export const downloadFile = async (filePath: string): Promise<Buffer> => {
  try {
    const [fileBuffer] = await bucket.file(filePath).download();
    return fileBuffer;
  } catch (error) {
    throw new Error(`Failed to download file: ${error}`);
  }
};

/**
 * Check if a file exists in Google Cloud Storage
 * @param filePath - Path in GCS bucket
 * @returns Boolean indicating existence
 */
export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const [exists] = await bucket.file(filePath).exists();
    return exists;
  } catch (error) {
    return false;
  }
};

/**
 * Get file metadata
 * @param filePath - Path in GCS bucket
 * @returns File metadata
 */
export const getFileMetadata = async (filePath: string) => {
  try {
    const [metadata] = await bucket.file(filePath).getMetadata();
    return metadata;
  } catch (error) {
    throw new Error(`Failed to get file metadata: ${error}`);
  }
};

/**
 * Initialize GCS bucket (create if doesn't exist)
 */
export const initializeBucket = async (): Promise<void> => {
  try {
    const [exists] = await bucket.exists();
    if (!exists) {
      await storage.createBucket(bucketName, {
        location: 'US',
        storageClass: 'STANDARD',
      });
      console.log(`Bucket ${bucketName} created successfully`);
    } else {
      console.log(`Bucket ${bucketName} already exists`);
    }
  } catch (error) {
    console.error('Error initializing bucket:', error);
    throw error;
  }
};

export { storage, bucket, bucketName };

/** Create-only paths and generation-bound reads keep cited attachments immutable. */
export async function uploadImmutableFile(buffer: Buffer, objectName: string, mimeType: string, sha256: string): Promise<string> {
  const object = bucket.file(objectName);
  await object.save(buffer, {
    resumable: false, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType: mimeType, metadata: { sha256 } },
  });
  const [metadata] = await object.getMetadata();
  if (!metadata.generation) throw new Error('Storage did not return an immutable object generation');
  return String(metadata.generation);
}

export async function downloadImmutableFile(objectName: string, generation: string, maxBytes: number): Promise<Buffer> {
  const object = bucket.file(objectName, { generation });
  const [metadata] = await object.getMetadata();
  if (Number(metadata.size) > maxBytes) throw new Error('Material exceeds the ingestion byte limit');
  const [buffer] = await object.download();
  if (buffer.length > maxBytes) throw new Error('Material exceeds the ingestion byte limit');
  return buffer;
}
