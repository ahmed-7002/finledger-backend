import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Uploads a receipt image buffer to Cloudinary and returns the secure URL.
 * Called from the transactions route after multer parses the multipart
 * upload in memory (no file ever touches disk on the server).
 *
 * NOTE: no `transformation` option is passed at upload time on purpose.
 * Accounts with "Strict Transformations" enabled (Cloudinary Dashboard ->
 * Settings -> Security) reject ad-hoc/eager transformations with a 403 at
 * upload time, even with fully correct API credentials - since a 403
 * (as opposed to a 401) means "authenticated, but not permitted to do
 * this specific thing." Delivery-time optimization (quality/format) can
 * still be applied later via the URL itself when displaying the image,
 * without needing special permission at upload time.
 */
export function uploadReceiptBuffer(buffer, ownerId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `khaatabook/receipts/${ownerId}`,
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

export default cloudinary;