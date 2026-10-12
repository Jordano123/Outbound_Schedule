/* =========================================================
   FIREBASE SETTINGS
   Paste the values Firebase gives you (SETUP.md step 2).

   These aren't secret passwords. Every Firebase website
   has them in its code. The security rules (SETUP.md
   step 4) and the team password are what protect the data.
   ========================================================= */

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCbVdvq8hW6zvDztO_FIgO-tsG5pFkS1Lo",
    authDomain: "rbd5-schedule.firebaseapp.com",
    projectId: "rbd5-schedule",
    storageBucket: "rbd5-schedule.firebasestorage.app",
    messagingSenderId: "869668012801",
    appId: "1:869668012801:web:1f8510bc5564b538099100"
   measurementId: "G-94RLXMC3Z8"
};


/*
 * The hidden team account. Your coworkers never see or type this.
 * It must match the user you create in SETUP.md step 3,
 * and the email in firestore.rules.
 */
const TEAM_EMAIL = "team@rbd5-schedule.app";
