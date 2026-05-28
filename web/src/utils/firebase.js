import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";
import { getFunctions, httpsCallable } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);
export const functions = getFunctions(app, "asia-southeast1");

// Callable functions
export const createApp = (data) => httpsCallable(functions, "createApp")(data);
export const revokeApp = (data) => httpsCallable(functions, "revokeApp")(data);
export const regenerateAppSecret = (data) =>
  httpsCallable(functions, "regenerateAppSecret")(data);
export const requestCredit = (data) =>
  httpsCallable(functions, "requestCredit")(data);
export const submitTrxId = (data) =>
  httpsCallable(functions, "submitTrxId")(data);
export const approveCredit = (data) =>
  httpsCallable(functions, "approveCredit")(data);
export const getCredits = (data) =>
  httpsCallable(functions, "getCredits")(data);
export const getUserRole = (data) =>
  httpsCallable(functions, "getUserRole")(data);
export const listApps = (data) => httpsCallable(functions, "listApps")(data);
export const createBulkCampaign = (data) =>
  httpsCallable(functions, "createBulkCampaign")(data);
export const getCampaignStatus = (data) =>
  httpsCallable(functions, "getCampaignStatus")(data);
export const listCampaigns = (data) =>
  httpsCallable(functions, "listCampaigns")(data);
export const listFailedRecipients = (data) =>
  httpsCallable(functions, "listFailedRecipients")(data);
export const pauseCampaign = (data) =>
  httpsCallable(functions, "pauseCampaign")(data);
export const resumeCampaign = (data) =>
  httpsCallable(functions, "resumeCampaign")(data);
export const cancelCampaign = (data) =>
  httpsCallable(functions, "cancelCampaign")(data);
export const retryFailedJobs = (data) =>
  httpsCallable(functions, "retryFailedJobs")(data);
export const listPackages = (data) =>
  httpsCallable(functions, "listPackages")(data);
export const upsertPackage = (data) =>
  httpsCallable(functions, "upsertPackage")(data);
export const getTransactions = (data) =>
  httpsCallable(functions, "getTransactions")(data);
export const getInvoiceHistory = (data) =>
  httpsCallable(functions, "getInvoiceHistory")(data);

// Bulk SMS Enhancements (Modification 4)
export const createContactGroup = (data) =>
  httpsCallable(functions, "createContactGroup")(data);
export const listContactGroups = (data) =>
  httpsCallable(functions, "listContactGroups")(data);
export const deleteContactGroup = (data) =>
  httpsCallable(functions, "deleteContactGroup")(data);
export const listContactGroupPhones = (data) =>
  httpsCallable(functions, "listContactGroupPhones")(data);
export const createMessageTemplate = (data) =>
  httpsCallable(functions, "createMessageTemplate")(data);
export const listMessageTemplates = (data) =>
  httpsCallable(functions, "listMessageTemplates")(data);
export const updateMessageTemplate = (data) =>
  httpsCallable(functions, "updateMessageTemplate")(data);
export const deleteMessageTemplate = (data) =>
  httpsCallable(functions, "deleteMessageTemplate")(data);

// HTTPS endpoints (API Playground)
const functionsRegion =
  import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || "asia-southeast1";

export const sendOtpHttps = async (payload) => {
  const url = `https://${functionsRegion}-${firebaseConfig.projectId}.cloudfunctions.net/sendOtp`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Failed to send OTP");
  }
  return response.json();
};

export const verifyOtpHttps = async (payload) => {
  const url = `https://${functionsRegion}-${firebaseConfig.projectId}.cloudfunctions.net/verifyOtp`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Failed to verify OTP");
  }
  return response.json();
};

export const otpStatusHttps = async (payload) => {
  const url = `https://${functionsRegion}-${firebaseConfig.projectId}.cloudfunctions.net/otpStatus`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Failed to check OTP status");
  }
  return response.json();
};

export default app;
