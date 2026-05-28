const admin = require("firebase-admin");

const BULK_MAX_MESSAGE_CHARS_GSM = Number(process.env.BULK_MAX_MESSAGE_CHARS_GSM) || 160;
const BULK_MAX_MESSAGE_CHARS_UCS2 = Number(process.env.BULK_MAX_MESSAGE_CHARS_UCS2) || 70;
const BULK_DAILY_APP_LIMIT = Number(process.env.BULK_DAILY_APP_LIMIT) || 50000;

const GSM_7BIT_CHARSET = new Set([
  ..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\\".split(""),
  ..." !\"#¤%&'()*+,-./0123456789:;<=>?".split(""),
  ..."¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""),
]);

/**
 * Validates that a phone number is in E.164 format.
 * @param {string} phone
 * @returns {boolean}
 */
function validateE164(phone) {
  return typeof phone === "string" && /^\+[1-9]\d{6,14}$/.test(phone);
}

/**
 * Returns true if the text contains only GSM 03.38 basic charset characters.
 * @param {string} text
 * @returns {boolean}
 */
function isGsm7Bit(text) {
  if (typeof text !== "string") {
    return false;
  }

  for (const char of text) {
    if (!GSM_7BIT_CHARSET.has(char)) {
      return false;
    }
  }

  return true;
}

/**
 * Validates a bulk SMS message body and returns charset and limit info.
 * @param {string} message
 * @returns {{valid: boolean, charset: string, maxChars: number, error?: string}}
 */
function validateBulkMessage(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    return {
      valid: false,
      charset: "gsm",
      maxChars: BULK_MAX_MESSAGE_CHARS_GSM,
      error: "Message cannot be empty",
    };
  }

  const charset = isGsm7Bit(message) ? "gsm" : "ucs2";
  const maxChars = charset === "gsm" ? BULK_MAX_MESSAGE_CHARS_GSM : BULK_MAX_MESSAGE_CHARS_UCS2;

  if (message.length > maxChars) {
    return {
      valid: false,
      charset,
      maxChars,
      error: `Message exceeds ${maxChars} chars for ${charset.toUpperCase()}`,
    };
  }

  return {
    valid: true,
    charset,
    maxChars,
  };
}

/**
 * Parses simple CSV text with a phone column header.
 * @param {string} csvString
 * @returns {string[]}
 */
function parseCSV(csvString) {
  if (typeof csvString !== "string" || csvString.trim().length === 0) {
    throw new Error("CSV content cannot be empty");
  }

  const lines = csvString.split(/\r?\n/).map((line) => line.trim());
  const header = lines.shift();

  if (!header) {
    throw new Error("CSV header row is required");
  }

  const columns = header.split(",").map((col) => col.trim().toLowerCase());
  const phoneIndex = columns.indexOf("phone");

  if (phoneIndex === -1) {
    throw new Error("CSV must include a 'phone' column header");
  }

  const phones = [];

  for (const line of lines) {
    if (line === "") {
      continue;
    }

    const cells = line.split(",");
    const phone = (cells[phoneIndex] || "").trim();

    if (phone.length === 0) {
      continue;
    }

    phones.push(phone);
  }

  if (phones.length === 0) {
    throw new Error("CSV contains no phone entries");
  }

  return phones;
}

/**
 * Deduplicates a list of phone numbers while preserving order.
 * @param {string[]} phoneArray
 * @returns {{unique: string[], duplicates: Set<string>, duplicateCount: number}}
 */
function deduplicatePhones(phoneArray) {
  const seen = new Set();
  const duplicates = new Set();
  const unique = [];

  for (const phone of phoneArray) {
    if (seen.has(phone)) {
      duplicates.add(phone);
      continue;
    }

    seen.add(phone);
    unique.push(phone);
  }

  return {
    unique,
    duplicates,
    duplicateCount: duplicates.size,
  };
}

/**
 * Reads bulk_sms_remaining for an app.
 * @param {string} appId
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<number>}
 */
async function checkBulkCreditBalance(appId, db) {
  const doc = await db.collection("app_credits").doc(appId).get();

  if (!doc.exists) {
    return 0;
  }

  const data = doc.data();
  return Number(data?.bulk_sms_remaining || 0);
}

/**
 * Computes remaining bulk quota for the current UTC day.
 * @param {string} appId
 * @param {FirebaseFirestore.Firestore} db
 * @param {number} todayStart
 * @returns {Promise<number>}
 */
async function checkDailyAppQuota(appId, db, todayStart) {
  const snapshot = await db
    .collection("bulk_campaigns")
    .where("appId", "==", appId)
    .where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(todayStart))
    .get();

  let totalRecipients = 0;

  snapshot.forEach((doc) => {
    const data = doc.data();
    totalRecipients += Number(data.totalRecipients || 0);
  });

  return Math.max(0, BULK_DAILY_APP_LIMIT - totalRecipients);
}

module.exports = {
  validateE164,
  validateBulkMessage,
  parseCSV,
  deduplicatePhones,
  checkBulkCreditBalance,
  checkDailyAppQuota,
  isGsm7Bit,
};
