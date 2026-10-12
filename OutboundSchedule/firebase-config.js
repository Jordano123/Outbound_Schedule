/* =========================================================
   FIREBASE SETTINGS
   Paste the values Firebase gives you (SETUP.md step 2).

   These aren't secret passwords. Every Firebase website
   has them in its code. The security rules (SETUP.md
   step 4) and the team password are what protect the data.
   ========================================================= */

const FIREBASE_CONFIG = {
    apiKey: "PASTE_YOUR_API_KEY",
    authDomain: "PASTE_YOUR_AUTH_DOMAIN",
    projectId: "PASTE_YOUR_PROJECT_ID",
    storageBucket: "PASTE_YOUR_STORAGE_BUCKET",
    messagingSenderId: "PASTE_YOUR_SENDER_ID",
    appId: "PASTE_YOUR_APP_ID"
};


/*
 * The hidden team account. Your coworkers never see or type this.
 * It must match the user you create in SETUP.md step 3,
 * and the email in firestore.rules.
 */
const TEAM_EMAIL = "team@rbd5-schedule.app";
