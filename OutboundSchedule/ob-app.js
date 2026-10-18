
const USE_FIREBASE = true;


// Top bar (prototype login display)
const USER_LOGIN = "pparker";
const SITE_CODE = "RBD5";

// Related UIs
const CPT_VIEW_URL = "https://trans-logistics.amazon.com/ssp/dock/hrz/cpt";

// Alerts: warn this many minutes before a starred route's SDT
const ALERT_MINUTES = 20;


const ACCESS_CODE_HASH = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4";

const IDLE_MINUTES = 40;

// Wrong tries before a short wait
const MAX_CODE_TRIES = 5;
const CODE_WAIT_SECONDS = 30;


/*
 FMC LINK
 */
const FMC_URL_TEMPLATE = "https://track.relay.amazon.dev/view/NA:VR:{VRID}?m=trip&preset=today&column=scheduled_end&type=vehicleRun&r=na&q={VRID}&dateField=effectiveEnd";


// Dock doors you can attach a load to 
const DOOR_GROUPS = [
    { name: "300 side", from: 310, to: 346, skip: [321] },
    { name: "100 side", doors: [100, 122, 123, 124, 125, 126, 127, 128, 130] }
];


/*
  SHIFT WINDOWS
 */
const SHIFT_WINDOWS = [
    { name: "MOR + DAY", start: "03:30", cutoff: "16:59" },
    { name: "TWI + NIT", start: "15:30", cutoff: "04:59" }
];


// true = loads whose SDT has passed 
// false = they stay on the schedule, just without a "Late" label.
const HIDE_PAST_SDT = false;


// Saved on this device. 
const MY_ROUTE_KEY = "outboundMyRoutes";
const TIME_FORMAT_KEY = "outboundTimeFormat";
const VIEW_KEY = "outboundV4ViewSettings";
const ALERTS_KEY = "outboundV4Alerts";
const ALERTED_KEY = "outboundV4Alerted";

// Schedule saved on this device 
const LOCAL_SCHEDULE_KEY = "outboundV4ScheduleData";
const LOCAL_UPLOAD_KEY = "outboundV4UploadedAt";

// Firebase collections
const LOADS_COLLECTION = "loadsV4";
const META_COLLECTION = "metaV4";
const META_DOC = "schedule";

// Firestore allows up to 500 writes per batch
const BATCH_LIMIT = 450;

// A load you mark Finished stays visible this long, so you can undo it
const FINISH_HIDE_DELAY = 2 * 60 * 1000;

// The "Updated ..." line turns yellow after this long
const STALE_AFTER = 60 * 60 * 1000;


/* =========================================================
   SAFE STORAGE HELPERS
   ========================================================= */

function readJSON(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        console.error(`Could not read "${key}" from storage.`, error);
        return fallback;
    }
}

function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.error(`Could not save "${key}" to storage.`, error);
    }
}


/* =========================================================
   STATE
   ========================================================= */

const savedView = readJSON(VIEW_KEY, {});
const savedStars = readJSON(MY_ROUTE_KEY, []);

const appState = {

    schedules: [],

    selectedScheduleId: null,

    timeFormat: localStorage.getItem(TIME_FORMAT_KEY) || "24",

    searchText: "",

    statusFilter: ["all", "scheduled", "in-progress", "finished"]
        .includes(savedView.statusFilter) ? savedView.statusFilter : "all",

    pageSize: Number(savedView.pageSize) || 10,

    // Showing only starred routes?
    myRouteMode: savedView.myRouteMode === true,

    // Route picked from "Current CPT Routes" (null = all routes)
    routeFilter: null,

    // Show loads that are finished? (off = hidden)
    showFinished: savedView.showFinished === true,

    // "list" or "board"
    viewMode: ["list", "board", "doors"].includes(savedView.viewMode)
        ? savedView.viewMode
        : "list",

    // Load alerts on/off
    alertsOn: localStorage.getItem(ALERTS_KEY) === "on",

    // Starred routes
    myRoutes: Array.isArray(savedStars) ? savedStars : [],

    // When the last CSV was uploaded (milliseconds, from Firebase)
    uploadedAt: null,

    // Firebase connection
    signedIn: false,
    uploading: false,

    currentShift: null,

    lastMinute: null

};


/* =========================================================
   ROUTES BY CPT
   The only routes this site shows, grouped by their CPT.
   A route can be in more than one CPT (AZA5 is in 15:00 and 03:00).
   This list is used for the Routes panel and the sidebar's
   "Current CPT Routes". The table shows each load's CPT from the CSV.

   CSV names are matched exactly first, then by the code before
   the first "-": "IAH5-CART-SC" -> IAH5, "DOK4-CYC1" -> DOK4.
   ========================================================= */

const CPT_ROUTES = {

    "09:00": [
        "DAL9", "HOU5", "PNE5", "LBB5", "AUS5",
        "TUL5", "CVG9", "MCI9", "HOU1"
    ],

    "15:00": [
        "OKC5", "IAH5", "BFI5", "AZA5"
    ],

    "21:00": [
        "DOK4", "BTR9", "OAK5", "ONT1-INTERMODAL", "SAT9"
    ],

    "03:00": [
        "AZA5", "ABQ5", "AFW5-CART-SC", "AFW5", "MEM5",
        "DDF1", "DDF5", "DDA9", "DDF4", "TXZ5"
    ]

};

// Every route, once (built from the list above)
const ROUTES = [...new Set(Object.values(CPT_ROUTES).flat())];


/* The CPT times a route belongs to, e.g. AZA5 -> ["15:00", "03:00"] */
function getRouteCpts(route) {

    return Object.keys(CPT_ROUTES).filter(
        cpt => CPT_ROUTES[cpt].includes(route)
    );

}


/* =========================================================
   SHIFTS
   ========================================================= */

const SHIFTS = [
    { name: "MOR", start: "03:30", end: "08:30", cpt: "09:00" },
    { name: "DAY", start: "09:30", end: "14:30", cpt: "15:00" },
    { name: "TWI", start: "15:30", end: "20:30", cpt: "21:00" },
    { name: "NIT", start: "21:30", end: "02:30", cpt: "03:00" }
];


/* =========================================================
   DOM
   ========================================================= */

const $ = id => document.getElementById(id);

const elements = {

    csvFile: $("csvFile"),
    uploadInfo: $("uploadInfo"),
    searchInput: $("searchInput"),
    statusFilter: $("statusFilter"),
    pageSize: $("pageSize"),
    myRouteButton: $("myRouteButton"),
    showFinishedButton: $("showFinishedButton"),

    scheduleNav: $("scheduleNav"),
    routesNav: $("routesNav"),

    nextLoad: $("nextLoad"),

    scheduleTitle: $("scheduleTitle"),
    scheduleBody: $("scheduleBody"),
    scheduleCount: $("scheduleCount"),

    scheduledCount: $("scheduledCount"),
    progressCount: $("progressCount"),
    totalCount: $("totalCount"),
    finishedCount: $("finishedCount"),

    tableView: $("tableView"),
    boardView: $("boardView"),
    listViewButton: $("listViewButton"),
    boardViewButton: $("boardViewButton"),
    doorsViewButton: $("doorsViewButton"),
    doorsView: $("doorsView"),

    alertsButton: $("alertsButton"),
    toastArea: $("toastArea"),

    userLogin: $("userLogin"),
    cptViewLink: $("cptViewLink"),

    currentShift: $("currentShift"),
    currentCpt: $("currentCpt"),
    shiftRange: $("shiftRange"),
    cptRoutes: $("cptRoutes"),
    routeFilterChip: $("routeFilterChip"),

    currentTime: $("time"),
    currentDate: $("date"),

    format24: $("format24"),
    format12: $("format12"),

    detailsPanel: $("detailsPanel"),
    detailsBackdrop: $("detailsBackdrop"),
    closeDetails: $("closeDetails"),
    detailRoute: $("detailRoute"),
    detailStatus: $("detailStatus"),
    detailSdt: $("detailSdt"),
    detailCpt: $("detailCpt"),
    detailVrId: $("detailVrId"),
    detailLocation: $("detailLocation"),
    detailEquipment: $("detailEquipment"),
    detailCarrier: $("detailCarrier"),
    detailTrailer: $("detailTrailer"),
    detailPackages: $("detailPackages"),
    detailContainers: $("detailContainers"),
    detailProgress: $("detailProgress"),
    fmcLink: $("fmcLink"),
    detailDoorNote: $("detailDoorNote"),
    attachButton: $("attachButton"),
    detachButton: $("detachButton"),
    detailCurrentTime: $("detailCurrentTime"),
    detailTimeUntil: $("detailTimeUntil"),

    progressButton: $("progressButton"),
    finishButton: $("finishButton"),
    removeButton: $("removeButton"),

    liveStatus: $("liveStatus"),

    lockScreen: $("lockScreen"),
    lockForm: $("lockForm"),
    lockUsername: $("lockUsername"),
    lockPassword: $("lockPassword"),
    lockSubmit: $("lockSubmit"),
    lockError: $("lockError"),
    lockButton: $("lockButton")

};


/* Firebase handles (set in startFirebase) */
const firebaseState = {
    auth: null,
    db: null,
    unsubscribeLoads: null,
    unsubscribeMeta: null
};


/* =========================================================
   LOCK
   Shared mode (USE_FIREBASE = true): the team password, checked
   by Firebase. The database refuses anyone who isn't signed in,
   so this can't be skipped with F12.
   Simple mode: the access code below (only hides the screen).

   Both modes lock when the tab is closed, and after
   IDLE_MINUTES without activity. A refresh doesn't lock.
   ========================================================= */

const CODE_UNLOCKED_KEY = "obv4Unlocked";
const CODE_ACTIVITY_KEY = "obv4LastActivity";
const CODE_LEFT_KEY = "obv4LeftAt";

const codeLock = {
    locked: true,
    tries: 0,
    waitUntil: 0,
    lastSaved: 0,
    reopened: false,     // tab restored after being closed
    pendingMessage: ""   // shown on the password screen after locking
};


/* Is the site locked right now? */
function isLockedNow() {

    return USE_FIREBASE ? !appState.signedIn : codeLock.locked;

}


function startCodeLock() {

    const unlocked = sessionStorage.getItem(CODE_UNLOCKED_KEY) === "1";

    const last = Number(sessionStorage.getItem(CODE_ACTIVITY_KEY)) || 0;

    // When the page was last closed or refreshed. A refresh comes back
    // within seconds; a tab reopened later (Ctrl+Shift+T, or the browser
    // restoring tabs) doesn't, so that asks for the code again.
    const leftAt = Number(sessionStorage.getItem(CODE_LEFT_KEY)) || 0;

    const reopened = Boolean(leftAt) && Date.now() - leftAt > 10000;

    codeLock.reopened = reopened;

    if (USE_FIREBASE) {

        // The team password screen is used instead of the code screen
        setCodeLocked(false);

    } else if (unlocked && !reopened && Date.now() - last < IDLE_MINUTES * 60000) {
        setCodeLocked(false);
    } else {
        sessionStorage.removeItem(CODE_UNLOCKED_KEY);
        setCodeLocked(true);
    }

    sessionStorage.removeItem(CODE_LEFT_KEY);

    window.addEventListener("pagehide", () => {
        sessionStorage.setItem(CODE_LEFT_KEY, String(Date.now()));
    });

    // Any activity keeps the site unlocked
    ["pointerdown", "keydown", "touchstart", "wheel", "scroll"].forEach(type => {
        window.addEventListener(type, noteActivity, { passive: true });
    });

    // Coming back to the tab: check how long it's been
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            checkIdle();
        }
    });

    window.addEventListener("focus", checkIdle);

    setInterval(checkIdle, 15000);

    $("codeForm")?.addEventListener("submit", event => {
        event.preventDefault();
        submitCode();
    });

    $("codeLockButton")?.addEventListener("click", () => lockApp());

}


function noteActivity() {

    if (isLockedNow()) {
        return;
    }

    const now = Date.now();

    // Save at most every 5 seconds
    if (now - codeLock.lastSaved > 5000) {
        codeLock.lastSaved = now;
        sessionStorage.setItem(CODE_ACTIVITY_KEY, String(now));
    }

}


function checkIdle() {

    if (isLockedNow()) {
        return;
    }

    if (isIdleTooLong()) {
        lockApp("Locked after " + IDLE_MINUTES + " minutes without activity.");
    }

}


function isIdleTooLong() {

    const last = Number(sessionStorage.getItem(CODE_ACTIVITY_KEY)) || 0;

    return Date.now() - last >= IDLE_MINUTES * 60000;

}


/* Lock the site (team password in shared mode, code in simple mode) */
function lockApp(message = "") {

    sessionStorage.removeItem(CODE_UNLOCKED_KEY);

    // Locking the site locks Studio too
    window.Studio?.lock();

    closeDetails();
    closeRoutesPanel();
    closeDoorPicker();

    if (USE_FIREBASE) {

        codeLock.pendingMessage = message;

        if (firebaseState.auth) {
            firebaseState.auth.signOut();
        } else {
            showLockScreen(message);
        }

        return;

    }

    setCodeLocked(true, message);

}


function setCodeLocked(locked, message = "") {

    codeLock.locked = locked;

    const screen = $("codeScreen");

    screen?.classList.toggle("hidden", !locked);

    document.body.classList.toggle("code-locked", locked);

    setText($("codeError"), message);

    const input = $("codeInput");

    if (locked && input) {
        input.value = "";
        // Don't pop the keyboard up on phones
        if (window.matchMedia("(min-width: 960px)").matches) {
            input.focus();
        }
    }

}


function submitCode() {

    const input = $("codeInput");

    const code = (input?.value || "").trim();

    const now = Date.now();

    if (now < codeLock.waitUntil) {
        const seconds = Math.ceil((codeLock.waitUntil - now) / 1000);
        setText($("codeError"), `Too many tries. Wait ${seconds} seconds.`);
        return;
    }

    if (!code) {
        setText($("codeError"), "Enter the code.");
        return;
    }

    if (sha256(code) === ACCESS_CODE_HASH) {

        codeLock.tries = 0;

        sessionStorage.setItem(CODE_UNLOCKED_KEY, "1");
        sessionStorage.setItem(CODE_ACTIVITY_KEY, String(now));

        setCodeLocked(false);

        return;

    }

    codeLock.tries++;

    if (codeLock.tries >= MAX_CODE_TRIES) {
        codeLock.tries = 0;
        codeLock.waitUntil = now + CODE_WAIT_SECONDS * 1000;
        setText($("codeError"), `Too many tries. Wait ${CODE_WAIT_SECONDS} seconds.`);
    } else {
        setText($("codeError"), "Wrong code. Try again.");
    }

    // Little shake
    const card = $("codeForm");
    card?.classList.remove("shake");
    void card?.offsetWidth;
    card?.classList.add("shake");

    input?.select();

}


/* For changing the code: run makeCodeHash("new code") in the console */
function makeCodeHash(code) {

    const hash = sha256(String(code).trim());

    console.log(`Paste this into ACCESS_CODE_HASH:\n${hash}`);

    return hash;

}


/*
 * SHA-256 (turns the code into a scrambled string).
 * Written out here so it works on any page, even without https.
 */
function sha256(text) {

    const rotate = (value, amount) => (value >>> amount) | (value << (32 - amount));

    const bytes = new TextEncoder().encode(text);

    const K = [];
    const H = [];

    // First 32 bits of the fractional parts of square/cube roots of primes
    let prime = 2;
    for (let count = 0; count < 64; prime++) {
        let isPrime = true;
        for (let divisor = 2; divisor * divisor <= prime; divisor++) {
            if (prime % divisor === 0) {
                isPrime = false;
                break;
            }
        }
        if (isPrime) {
            if (count < 8) {
                H[count] = (Math.pow(prime, 1 / 2) * 4294967296) | 0;
            }
            K[count] = (Math.pow(prime, 1 / 3) * 4294967296) | 0;
            count++;
        }
    }

    const length = bytes.length;

    const blocks = Math.ceil((length + 9) / 64);

    const data = new Uint8Array(blocks * 64);

    data.set(bytes);

    data[length] = 0x80;

    const bitLength = length * 8;

    const view = new DataView(data.buffer);

    view.setUint32(data.length - 4, bitLength >>> 0);
    view.setUint32(data.length - 8, Math.floor(bitLength / 4294967296));

    const words = new Array(64);

    for (let block = 0; block < blocks; block++) {

        for (let i = 0; i < 16; i++) {
            words[i] = view.getUint32(block * 64 + i * 4);
        }

        for (let i = 16; i < 64; i++) {
            const s0 = rotate(words[i - 15], 7) ^ rotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
            const s1 = rotate(words[i - 2], 17) ^ rotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
            words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
        }

        let [a, b, c, d, e, f, g, h] = H;

        for (let i = 0; i < 64; i++) {
            const S1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + choice + K[i] + words[i]) | 0;
            const S0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + majority) | 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }

        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0;
        H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0;
        H[7] = (H[7] + h) | 0;

    }

    return H.map(value => (value >>> 0).toString(16).padStart(8, "0")).join("");

}


/* =========================================================
   ERRORS ON THE LOCK SCREEN
   If something breaks while the lock screen is up, show it
   there instead of leaving "Opening..." on screen.
   ========================================================= */

function showStartupError(message) {

    const screen = document.getElementById("lockScreen");

    if (!screen || screen.classList.contains("hidden")) {
        return;
    }

    screen.classList.remove("checking");

    const box = document.getElementById("lockError");

    if (box && !box.textContent) {
        box.textContent = "Error: " + message;
    }

}

window.addEventListener("error", event => {
    showStartupError(event.message || "Something went wrong loading the page.");
});

window.addEventListener("unhandledrejection", event => {
    const reason = event.reason;
    showStartupError((reason && (reason.message || reason.code)) || String(reason));
});


/* =========================================================
   INITIALIZE
   ========================================================= */

function init() {

    // Ask for the code first (if this tab isn't already unlocked)
    startCodeLock();

    document.querySelectorAll(".footer-year").forEach(
        element => { element.textContent = new Date().getFullYear(); }
    );

    // Top bar
    setText(elements.userLogin, `${USER_LOGIN}@amazon.com - ${SITE_CODE}`);

    if (elements.cptViewLink) {
        elements.cptViewLink.href = CPT_VIEW_URL;
    }

    // Stars saved by older versions used names like IAH5-CART-SC
    appState.myRoutes = [...new Set(appState.myRoutes.map(matchRoute).filter(Boolean))];

    setupEvents();

    syncControls();

    tick();

    setInterval(tick, 1000);

    if (USE_FIREBASE) {
        startFirebase();
    } else {
        startLocalMode();
    }

}


/*
 * Runs every second. The clock updates every second;
 * everything else re-draws when the minute changes.
 */
function tick() {

    updateClock();

    const minute = getCurrent24Hour();

    if (minute !== appState.lastMinute) {

        appState.lastMinute = minute;

        updateShift();

        renderSchedule();

        updateUploadInfo();

        checkAlerts();

        window.Studio?.tick();

    }

    updateOpenDetails();

}


/* =========================================================
   EVENTS
   ========================================================= */

/* Safe addEventListener: a missing element never crashes the app */
function on(element, eventName, handler) {

    if (!element) {
        console.warn(`Missing element: could not attach "${eventName}" handler.`);
        return;
    }

    element.addEventListener(eventName, handler);

}


function setupEvents() {

    on(elements.csvFile, "change", handleCSVUpload);

    setupDropUpload();

    setupFolderWatch();

    on(elements.searchInput, "input", event => {
        appState.searchText = event.target.value.toLowerCase().trim();
        renderSchedule();
    });

    // Click a route under "Current CPT Routes" to see only its loads
    on(elements.cptRoutes, "click", event => {
        const button = event.target.closest("[data-route]");
        if (button) {
            setRouteFilter(button.dataset.route);
        }
    });

    on(elements.routeFilterChip, "click", () => setRouteFilter(null));

    on(elements.statusFilter, "change", event => {
        appState.statusFilter = event.target.value;
        saveViewSettings();
        renderSchedule();
    });

    on(elements.pageSize, "change", event => {
        appState.pageSize = Number(event.target.value) || 10;
        saveViewSettings();
        renderSchedule();
    });

    on(elements.myRouteButton, "click", toggleMyRouteMode);

    on(elements.showFinishedButton, "click", () => {
        appState.showFinished = !appState.showFinished;
        saveViewSettings();
        renderSchedule();
    });

    on(elements.listViewButton, "click", () => setViewMode("list"));

    on(elements.boardViewButton, "click", () => setViewMode("board"));

    on(elements.doorsViewButton, "click", () => setViewMode("doors"));

    // Door map tiles open that load's details
    on(elements.doorsView, "click", event => {
        const tile = event.target.closest("[data-id]");
        if (tile) {
            openDetails(tile.dataset.id);
        }
    });

    on(elements.alertsButton, "click", toggleAlerts);


    on(elements.attachButton, "click", openDoorPicker);

    on(elements.detachButton, "click", detachSelectedLoad);

    // Board cards open details, same as table rows
    on(elements.boardView, "click", event => {
        const card = event.target.closest(".board-card");
        if (card) {
            openDetails(card.dataset.id);
        }
    });

    on(elements.scheduleNav, "click", showFullSchedule);

    on(elements.routesNav, "click", () => openRoutesPanel());

    on(elements.nextLoad, "click", () => {
        if (elements.nextLoad.dataset.id) {
            openDetails(elements.nextLoad.dataset.id);
        }
    });

    on(elements.format24, "click", () => setTimeFormat("24"));

    on(elements.format12, "click", () => setTimeFormat("12"));

    on(elements.closeDetails, "click", closeDetails);

    on(elements.detailsBackdrop, "click", closeDetails);

    on(elements.progressButton, "click", markInProgress);

    on(elements.finishButton, "click", markFinished);

    on(elements.removeButton, "click", removeSelectedLoad);

    // One click handler for the whole table
    on(elements.scheduleBody, "click", event => {
        const row = event.target.closest(".schedule-row");
        if (row) {
            openDetails(row.dataset.id);
        }
    });

    // Password screen
    on(elements.lockForm, "submit", event => {
        event.preventDefault();
        unlock(elements.lockPassword.value);
    });

    on(elements.lockButton, "click", lock);

    // Esc closes the Routes panel first, then the details panel
    document.addEventListener("keydown", event => {

        if (event.key !== "Escape") {
            return;
        }

        if (document.getElementById("doorOverlay")) {
            closeDoorPicker();
        } else if (document.getElementById("routesOverlay")) {
            closeRoutesPanel();
        } else if (appState.selectedScheduleId) {
            closeDetails();
        }

    });

}


/* Put the dropdowns and buttons back the way they were saved */
function syncControls() {

    if (elements.statusFilter) {
        elements.statusFilter.value = appState.statusFilter;
    }

    if (elements.pageSize) {
        elements.pageSize.value = String(appState.pageSize);
    }

    elements.format24?.classList.toggle("active", appState.timeFormat === "24");
    elements.format12?.classList.toggle("active", appState.timeFormat === "12");

    updateMyRouteButton();

    updateViewButtons();

    updateAlertsButton();

}


function saveViewSettings() {

    writeJSON(VIEW_KEY, {
        statusFilter: appState.statusFilter,
        pageSize: appState.pageSize,
        myRouteMode: appState.myRouteMode,
        showFinished: appState.showFinished,
        viewMode: appState.viewMode
    });

}


/* =========================================================
   CSV UPLOAD
   ========================================================= */

function handleCSVUpload(event) {

    const input = event.target;

    const file = input.files[0];

    // lets you pick the same file again later
    input.value = "";

    if (file) {
        readCSVFile(file);
    }

}


/* Reads a CSV file (from the Upload button or dropped on the page) */
function readCSVFile(file) {

    Papa.parse(file, {

        header: true,

        skipEmptyLines: true,

        complete: results => processCSV(results.data),

        error: error => {
            console.error(error);
            alert("There was a problem reading the CSV.");
        }

    });

}


/* =========================================================
   WATCH DOWNLOADS (auto-upload)
   Chrome / Edge / Opera only. Pick the Downloads folder once;
   every new Outbound_Dock_Management*.csv that lands there gets
   uploaded by itself, and everyone's screen updates.
   The browser only lets the site read the folder you pick.
   ========================================================= */

// Which files count as the outbound export
const WATCH_FILE_PATTERN = /^outbound_dock_management.*\.csv$/i;

// How often to look in the folder
const WATCH_EVERY_MS = 3000;

const folderWatch = {
    handle: null,       // the folder you picked
    timer: null,
    busy: false,
    lastFile: null      // { name, lastModified, size } of the newest file handled
};


function canWatchFolders() {

    return "showDirectoryPicker" in window && window.isSecureContext;

}


function setupFolderWatch() {

    const button = $("watchButton");

    if (!button) {
        return;
    }

    // Firefox, Safari and phones can't do this; hide the button there
    if (!canWatchFolders()) {
        button.classList.add("hidden");
        return;
    }

    button.classList.remove("hidden");

    button.addEventListener("click", () => {
        if (folderWatch.timer) {
            stopFolderWatch(true);
        } else {
            startFolderWatch();
        }
    });

    // Remember the folder from last time, so it's one click to resume
    loadSavedFolder().then(handle => {
        if (handle) {
            folderWatch.handle = handle;
            updateWatchButton();
        }
    });

    updateWatchButton();

}


async function startFolderWatch() {

    try {

        let handle = folderWatch.handle;

        // Saved folder: just ask the browser to allow it again
        if (handle) {
            const allowed = await handle.requestPermission({ mode: "read" });
            if (allowed !== "granted") {
                handle = null;
            }
        }

        // No folder yet (or permission refused): pick one
        if (!handle) {
            // Chrome/Edge won't allow the Downloads folder itself,
            // so this is a folder made for the CSVs (e.g. Downloads\\Outbound CSV)
            handle = await window.showDirectoryPicker({
                id: "rbd5-downloads",
                mode: "read",
                startIn: "downloads"
            });
        }

        folderWatch.handle = handle;

        saveFolder(handle);

        // Files already in the folder don't count; only new ones get uploaded
        folderWatch.lastFile = await findNewestExport(handle);

        folderWatch.timer = setInterval(checkFolder, WATCH_EVERY_MS);

        updateWatchButton();

        showToast(`Watching "${handle.name}". New outbound CSVs will upload by themselves.`);

    } catch (error) {

        // Closing the folder picker isn't an error
        if (error && error.name === "AbortError") {
            return;
        }

        console.error(error);
        alert("Couldn't watch that folder. Pick the folder your outbound CSVs download into (not Downloads itself).");

    }

}


function stopFolderWatch(byUser = false) {

    clearInterval(folderWatch.timer);

    folderWatch.timer = null;

    updateWatchButton();

    if (byUser) {
        showToast("Stopped watching the folder");
    }

}


function updateWatchButton() {

    const button = $("watchButton");

    if (!button) {
        return;
    }

    const on = Boolean(folderWatch.timer);

    button.classList.toggle("active", on);

    button.setAttribute("aria-pressed", String(on));

    button.innerHTML = on
        ? `<span class="watch-dot" aria-hidden="true"></span>
           <span class="upload-text"><strong>Watching</strong><small>${escapeHTML(folderWatch.handle?.name || "folder")} · tap to stop</small></span>`
        : `<span aria-hidden="true">⟳</span>
           <span class="upload-text"><strong>Auto-upload</strong><small>${folderWatch.handle ? "Tap to resume" : "Pick CSV folder"}</small></span>`;

    button.title = on
        ? "New outbound CSVs in this folder upload by themselves. Tap to stop."
        : "Pick the folder your outbound CSVs download into. New ones will upload by themselves.";

}


/* The newest outbound CSV in the folder, or null */
async function findNewestExport(handle) {

    let newest = null;

    for await (const entry of handle.values()) {

        if (entry.kind !== "file" || !WATCH_FILE_PATTERN.test(entry.name)) {
            continue;
        }

        const file = await entry.getFile();

        if (!newest || file.lastModified > newest.lastModified) {
            newest = {
                name: file.name,
                lastModified: file.lastModified,
                size: file.size,
                entry
            };
        }

    }

    return newest;

}


async function checkFolder() {

    // Don't upload while locked; it'll catch up after unlocking
    if (folderWatch.busy || !folderWatch.handle || isLockedNow() || appState.uploading) {
        return;
    }

    folderWatch.busy = true;

    try {

        const newest = await findNewestExport(folderWatch.handle);

        const last = folderWatch.lastFile;

        const isNew = newest && newest.size > 0 && (
            !last ||
            newest.name !== last.name ||
            newest.lastModified !== last.lastModified ||
            newest.size !== last.size
        );

        if (!isNew) {
            return;
        }

        // Make sure it finished downloading: same size a moment later
        await new Promise(resolve => setTimeout(resolve, 800));

        const file = await newest.entry.getFile();

        if (file.size !== newest.size || file.lastModified !== newest.lastModified) {
            return; // still changing; check again next time
        }

        folderWatch.lastFile = newest;

        showToast(`Auto-uploading ${file.name}...`);

        readCSVFile(file);

    } catch (error) {

        console.error(error);

        // Permission was taken away (browser restarted, folder moved...)
        stopFolderWatch();

        showToast("Stopped watching the folder. Tap Auto-upload to start again.");

    } finally {

        folderWatch.busy = false;

    }

}


/* ---------- Remember the folder (IndexedDB, this device only) ---------- */

function folderDb() {

    return new Promise((resolve, reject) => {
        const request = indexedDB.open("rbd5-schedule", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("handles");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

}


function saveFolder(handle) {

    folderDb()
        .then(db => {
            db.transaction("handles", "readwrite").objectStore("handles").put(handle, "downloads");
        })
        .catch(error => console.warn("Couldn't remember the folder", error));

}


function loadSavedFolder() {

    return folderDb()
        .then(db => new Promise(resolve => {
            const request = db.transaction("handles").objectStore("handles").get("downloads");
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => resolve(null);
        }))
        .catch(() => null);

}


/* =========================================================
   DRAG AND DROP UPLOAD
   Drag the CSV from your Downloads onto the page.
   ========================================================= */

function setupDropUpload() {

    const overlay = $("dropOverlay");

    // Counts enter/leave so the overlay doesn't flicker over child elements
    let depth = 0;

    const hasFiles = event =>
        Array.from(event.dataTransfer?.types || []).includes("Files");

    const hide = () => {
        depth = 0;
        overlay?.classList.add("hidden");
    };

    window.addEventListener("dragenter", event => {

        if (!hasFiles(event) || isLockedNow()) {
            return;
        }

        event.preventDefault();

        depth++;

        overlay?.classList.remove("hidden");

    });

    window.addEventListener("dragover", event => {

        if (!hasFiles(event)) {
            return;
        }

        // Without this the browser would open the file instead
        event.preventDefault();

        event.dataTransfer.dropEffect = isLockedNow() ? "none" : "copy";

    });

    window.addEventListener("dragleave", event => {

        if (!hasFiles(event)) {
            return;
        }

        depth = Math.max(0, depth - 1);

        if (depth === 0) {
            hide();
        }

    });

    window.addEventListener("drop", event => {

        if (!hasFiles(event)) {
            return;
        }

        event.preventDefault();

        hide();

        if (isLockedNow()) {
            return;
        }

        const files = Array.from(event.dataTransfer.files || []);

        const file = files.find(item => /\.csv$/i.test(item.name)) || files[0];

        if (!file) {
            return;
        }

        if (!/\.csv$/i.test(file.name)) {
            alert(`"${file.name}" isn't a CSV file. Drop the CSV export from the outbound page.`);
            return;
        }

        showToast(`Uploading ${file.name}...`);

        readCSVFile(file);

    });

    // Safety: hide the overlay if the drag ends somewhere else
    window.addEventListener("dragend", hide);
    window.addEventListener("blur", hide);

}



/* =========================================================
   PROCESS CSV
   The new CSV always replaces the old schedule completely.
   ========================================================= */

function processCSV(rows) {

    const processed = [];

    const usedIds = new Set();

    rows.forEach(row => {

        const route = getColumn(row, ["Sort/Route"]);
        const sdt = getColumn(row, ["SDT"]);
        const csvCpt = getColumn(row, ["CPT"]);
        const csvStatus = getColumn(row, ["Status"]);
        const vrId = getColumn(row, ["VR ID"]);
        const adt = getColumn(row, ["ADT"]);
        const location = cleanValue(getColumn(row, ["Location"]));
        const equipment = formatEquipment(getColumn(row, ["Equipment", "Equipment Type"]));
        const carrier = parseCarrier(getColumn(row, ["Carrier"]));
        const trailer = cleanValue(getColumn(row, ["Trailer", "Trailer Number"]));
        const packages = toNumber(getColumn(row, ["P"]));
        const containers = toNumber(getColumn(row, ["C"]));
        const progress = {
            loaded: toPercent(getColumn(row, ["Load: Loaded Percentage"])),
            staged: toPercent(getColumn(row, ["Load: Staged Percentage"])),
            closed: toPercent(getColumn(row, ["Load: Closed Not Staged Percentage"])),
            available: toPercent(getColumn(row, ["Load: Available Capacity Percentage"])),
            projected: toPercent(getColumn(row, ["Load: Projected Fill Percentage"]))
        };

        if (!route || !sdt) {
            return;
        }

        const fullRoute = normalizeRoute(extractDestination(route));

        const matchedRoute = matchRoute(fullRoute);

        // Not one of our routes (LEX2, DAU7, UPS...): kept for Studio
        // only, never shown on the schedule. Shuttles and the hostler
        // are never kept.
        const otherRoute = matchedRoute ? null : getOtherRouteName(fullRoute);

        if (!matchedRoute && !otherRoute) {
            return;
        }

        // Already departed -> never on the schedule
        if (isDeparted(csvStatus, adt)) {
            return;
        }

        const normalizedSdt = extractDateTime(sdt);

        // CPT comes from the CSV. If the CSV has none, use the
        // route's next CPT from CPT_ROUTES after its SDT.
        const cpt = extractDateTime(csvCpt) ||
            (matchedRoute
                ? nextCptAfter(normalizedSdt, getRouteCpts(matchedRoute))
                : normalizedSdt);

        // Stable id: same load gets the same id on every upload
        // (only letters, numbers, _ and - so Firebase accepts it)
        const baseId = `${fullRoute}_${normalizedSdt}_${vrId}`
            .replace(/[^A-Za-z0-9_-]/g, "_");
        let id = baseId;
        let copy = 2;
        while (usedIds.has(id)) {
            id = `${baseId}_${copy++}`;
        }
        usedIds.add(id);

        processed.push({
            id,
            route: matchedRoute || otherRoute,
            tracked: Boolean(matchedRoute),   // false = Studio only
            fullRoute,
            sdt: normalizedSdt,
            cpt,
            vrId: vrId || "",
            location,
            equipment,
            carrierCode: carrier.code,
            carrierType: carrier.type,
            trailer,
            packages,
            containers,
            progress,
            door: keepManualDoor(id, location),
            csvStatus: csvStatus || "",
            status: normalizeCsvStatus(csvStatus),
            finishedAt: null,   // set when YOU press Finish
            removed: false,     // set when YOU press Remove
            isCpt: getTime(normalizedSdt) === getTime(cpt)
        });

    });

    if (!processed.length) {
        alert(
            "No loads to show from this CSV.\n" +
            "Everything was either departed or not one of your routes."
        );
        return;
    }

    processed.sort(bySdt);

    uploadSchedule(processed);

}


function getColumn(row, names) {

    const keys = Object.keys(row);

    for (const name of names) {

        const found = keys.find(
            key => key.trim().toLowerCase() === name.toLowerCase()
        );

        if (found) {
            return String(row[found] ?? "").trim();
        }

    }

    return "";

}


/*
 * Departed = the status says so, or the ADT
 * (actual departure time) column has a time in it.
 */
function isDeparted(status, adt) {

    return (
        String(status || "").toLowerCase().includes("depart") ||
        Boolean(extractTime(adt))
    );

}


/*
 * Only two working statuses on this site:
 *   Loading In Progress, Loading Paused -> In Progress
 *   Finished Loading                    -> Finished
 *   Everything else (Trailer Attached)  -> Scheduled
 */
function normalizeCsvStatus(status) {

    const value = String(status || "").trim().toLowerCase();

    if (value.includes("finished")) {
        return "finished";
    }

    if (value.includes("progress") || value.includes("paused")) {
        return "in-progress";
    }

    return "scheduled";

}


/* =========================================================
   LOAD FIELDS (location, equipment, carrier, progress)
   ========================================================= */

/* "-" and blanks mean "nothing" */
function cleanValue(value) {

    const text = String(value || "").trim();

    return text === "-" ? "" : text;

}


function toNumber(value) {

    const number = Number(String(value || "").replace(/,/g, "").trim());

    return cleanValue(value) && !isNaN(number) ? number : null;

}


/* "71%" -> 71, "<1%" -> 0.5, "-" -> null */
function toPercent(value) {

    const text = cleanValue(value);

    if (!text) {
        return null;
    }

    if (text.startsWith("<")) {
        return 0.5;
    }

    const number = parseFloat(text);

    return isNaN(number) ? null : number;

}


/*
 * "fifty three foot truck"   -> "53' Truck"
 * "twenty six foot box truck" -> "26' Box Truck"
 */
function formatEquipment(value) {

    let text = cleanValue(value).toLowerCase();

    if (!text) {
        return "";
    }

    const numbers = {
        "fifty three": "53", "fifty-three": "53",
        "twenty six": "26", "twenty-six": "26",
        "forty eight": "48", "forty-eight": "48",
        "twenty eight": "28", "twenty-eight": "28",
        "sixteen": "16", "twenty": "20", "forty": "40"
    };

    Object.keys(numbers).forEach(word => {
        text = text.replace(word + " foot", numbers[word] + "'");
    });

    text = text.replace(/(\d+)\s*(foot|ft)\b/, "$1'");

    // Capitalize words: "53' box truck" -> "53' Box Truck"
    return text.replace(/\b[a-z]/g, letter => letter.toUpperCase());

}


/*
 * "HJBT[ATS_CONTRACTED]" -> { code: "HJBT", type: "3P" }
 * "BLUC[ATS_DEDICATED]"  -> { code: "BLUC", type: "AZNG" }
 * "AVLNP[ATS_BROKERAGE]" -> { code: "AVLNP", type: "AZNG" }
 */
function parseCarrier(value) {

    const text = cleanValue(value);

    if (!text) {
        return { code: "", type: "" };
    }

    const match = text.match(/^([^\[]+)\[([^\]]+)\]/);

    const code = (match ? match[1] : text).trim();

    const kind = (match ? match[2] : "").toUpperCase();

    let type = "";

    if (kind.includes("CONTRACTED")) {
        type = "3P";
    } else if (kind.includes("BROKERAGE") || kind.includes("DEDICATED")) {
        type = "AZNG";
    }

    return { code, type };

}


function hasProgress(item) {

    const p = item.progress;

    return Boolean(p) && [p.loaded, p.staged, p.closed, p.available]
        .some(value => value !== null && value !== undefined);

}


/*
 * Progress bar like the outbound page:
 * green = loaded, blue = staged, orange = closed not staged,
 * gray = available capacity.
 */
function renderProgress(item, compact = false) {

    if (!hasProgress(item)) {
        return "";
    }

    const p = item.progress;

    const part = value => Math.max(0, Math.min(100, Number(value) || 0));

    const loaded = part(p.loaded);
    const staged = part(p.staged);
    const closed = part(p.closed);

    const label = value => (value === 0.5 ? "<1" : Math.round(Number(value) || 0));

    return `
        <div class="progress ${compact ? "progress-compact" : ""}">
            <div class="progress-bar" role="img"
                 aria-label="Loaded ${label(p.loaded)}%, staged ${label(p.staged)}%, closed not staged ${label(p.closed)}%">
                <span class="seg seg-loaded" style="width:${loaded}%"></span>
                <span class="seg seg-staged" style="width:${staged}%"></span>
                <span class="seg seg-closed" style="width:${closed}%"></span>
            </div>
            <div class="progress-legend">
                <span><i class="dot dot-loaded"></i>L ${label(p.loaded)}%</span>
                <span><i class="dot dot-staged"></i>S ${label(p.staged)}%</span>
                <span><i class="dot dot-closed"></i>C ${label(p.closed)}%</span>
                ${compact ? "" : `<span><i class="dot dot-available"></i>A ${label(p.available)}%</span>`}
                ${p.projected !== null && p.projected !== undefined
                    ? `<span class="progress-fill">${label(p.projected)}% fill</span>`
                    : ""}
            </div>
        </div>
    `;

}


function renderCarrierTag(item) {

    if (!item.carrierCode) {
        return "";
    }

    const type = item.carrierType;

    return `<span class="carrier-tag ${type === "3P" ? "carrier-3p" : type === "AZNG" ? "carrier-azng" : ""}">
                ${escapeHTML(item.carrierCode)}${type ? ` - ${type}` : ""}
            </span>`;

}


function renderLocationChip(item) {

    const spot = getDoor(item);

    if (!spot) {
        return "";
    }

    const parking = spot.toUpperCase().startsWith("PS");

    const manual = isManualDoor(item);

    const title = manual
        ? "Attached by you on this site"
        : parking ? "Parking spot" : "Dock door";

    return `<span class="location-chip ${parking ? "location-parking" : ""}"
                  title="${title}">${escapeHTML(spot)}</span>`;

}


/* =========================================================
   ROUTES
   ========================================================= */

function extractDestination(route) {

    const value = String(route || "").trim();

    const arrow = value.indexOf("->");

    return arrow === -1 ? value : value.substring(arrow + 2).trim();

}


function normalizeRoute(route) {

    return String(route).trim().toUpperCase().replace(/\s+/g, "");

}


/*
 * Endings the CSV adds to a route that still mean the same route:
 * "IAH5-CART-SC" -> IAH5, "DOK4-CYC1" -> DOK4.
 * Other endings (like "-INTERMODAL") are a different route,
 * so "OAK5-INTERMODAL" does NOT count as OAK5.
 */
const ROUTE_SUFFIXES = ["-CART-SC", "-CYC1", "-SC"];


/* Routes that are never kept, not even for Studio */
const NEVER_KEEP_ROUTES = [/SHUTTLE/i, /HOSTLER/i];


/*
 * Name for a route that isn't one of ours (Studio shows these):
 * "DAU7-CYC1" -> DAU7. Shuttles / hostler -> null.
 */
function getOtherRouteName(fullRoute) {

    const route = normalizeRoute(fullRoute);

    if (!route || NEVER_KEEP_ROUTES.some(pattern => pattern.test(route))) {
        return null;
    }

    for (const suffix of ROUTE_SUFFIXES) {
        if (route.endsWith(suffix)) {
            return route.slice(0, -suffix.length);
        }
    }

    return route;

}


/* Our route name for a CSV route, or null if it's not ours */
function matchRoute(name) {

    const route = normalizeRoute(name);

    if (ROUTES.includes(route)) {
        return route;
    }

    for (const suffix of ROUTE_SUFFIXES) {
        if (route.endsWith(suffix)) {
            const base = route.slice(0, -suffix.length);
            if (ROUTES.includes(base)) {
                return base;
            }
        }
    }

    return null;

}


/*
 * The earliest of a route's CPT times that comes after its SDT.
 * nextCptAfter("2026-09-21 12:00", ["15:00", "03:00"]) -> "2026-09-21 15:00"
 */
function nextCptAfter(sdt, cpts) {

    if (!cpts.length) {
        return "";
    }

    return cpts
        .map(time => nextTimeAfter(sdt, time))
        .sort()[0];

}


/*
 * The first HH:MM at or after a date-time.
 * nextTimeAfter("2026-09-21 17:00", "03:00") -> "2026-09-22 03:00"
 */
function nextTimeAfter(dateTime, time) {

    if (!dateTime || dateTime.length < 16) {
        return time;
    }

    const date = new Date(`${dateTime.substring(0, 10)}T${time}`);

    if (time < dateTime.substring(11, 16)) {
        date.setDate(date.getDate() + 1);
    }

    return (
        date.getFullYear() + "-" +
        String(date.getMonth() + 1).padStart(2, "0") + "-" +
        String(date.getDate()).padStart(2, "0") + " " +
        time
    );

}


/* =========================================================
   DATE/TIME PARSING
   ========================================================= */

function extractDateTime(value) {

    if (!value) {
        return "";
    }

    const text = String(value).trim();

    const match = text.match(/(\d{1,2})-(\w{3})-(\d{2})\s+(\d{1,2}):(\d{2})/);

    if (!match) {
        return extractTime(text);
    }

    const months = {
        Jan: "01", Feb: "02", Mar: "03", Apr: "04",
        May: "05", Jun: "06", Jul: "07", Aug: "08",
        Sep: "09", Oct: "10", Nov: "11", Dec: "12"
    };

    const day = match[1].padStart(2, "0");
    const month = months[match[2]];
    const hour = match[4].padStart(2, "0");
    const minute = match[5];

    if (!month) {
        return `${hour}:${minute}`;
    }

    return `20${match[3]}-${month}-${day} ${hour}:${minute}`;

}


function extractTime(value) {

    if (!value) {
        return "";
    }

    const match = String(value).match(/(\d{1,2}):(\d{2})/);

    if (!match) {
        return "";
    }

    return String(Number(match[1])).padStart(2, "0") + ":" + match[2];

}


/* Works with both "2026-09-21 09:00" and plain "09:00" */
function getTime(value) {

    if (!value) {
        return "";
    }

    const text = String(value);

    return text.length >= 16 ? text.substring(11, 16) : extractTime(text);

}


/* Departure time in milliseconds, or null */
function getDepartureTime(item) {

    if (!item.sdt || item.sdt.length < 16) {
        return null;
    }

    const time = new Date(item.sdt.replace(" ", "T")).getTime();

    return isNaN(time) ? null : time;

}


function bySdt(a, b) {

    return String(a.sdt).localeCompare(String(b.sdt));

}


/* =========================================================
   LOAD STATE HELPERS
   ========================================================= */

/* SDT has passed and it's not finished */
function isLate(item) {

    if (item.status === "finished") {
        return false;
    }

    const departure = getDepartureTime(item);

    return departure !== null && departure <= Date.now();

}


/*
 * Finished loads are hidden unless "Show finished" is on.
 * One YOU just finished stays visible for 2 minutes first.
 */
function isFinishedHidden(item) {

    if (item.status !== "finished") {
        return false;
    }

    if (!item.finishedAt) {
        return true;
    }

    return Date.now() - item.finishedAt >= FINISH_HIDE_DELAY;

}


/*
 * The current shift window: which side's shifts it is now,
 * and the latest SDT that side needs to see (as a timestamp).
 */
function getShiftWindow(now = new Date()) {

    const minutes = now.getHours() * 60 + now.getMinutes();

    // The window that started most recently
    const sorted = [...SHIFT_WINDOWS].sort(
        (a, b) => timeToMinutes(a.start) - timeToMinutes(b.start)
    );

    let window = sorted[sorted.length - 1];

    sorted.forEach(item => {
        if (minutes >= timeToMinutes(item.start)) {
            window = item;
        }
    });

    // Date the window started (yesterday, if it's after midnight
    // but before the first window's start)
    const start = new Date(now);
    const [startHour, startMinute] = window.start.split(":").map(Number);
    start.setHours(startHour, startMinute, 0, 0);

    if (start > now) {
        start.setDate(start.getDate() - 1);
    }

    // Cutoff is the first cutoff time after the window's start
    const cutoff = new Date(start);
    const [cutHour, cutMinute] = window.cutoff.split(":").map(Number);
    cutoff.setHours(cutHour, cutMinute, 0, 0);

    if (cutoff <= start) {
        cutoff.setDate(cutoff.getDate() + 1);
    }

    return { name: window.name, cutoffTime: cutoff.getTime(), cutoffLabel: window.cutoff };

}


/* Is this load's SDT within the current shift window? */
function isInShiftWindow(item) {

    const departure = getDepartureTime(item);

    if (departure === null) {
        return true;
    }

    return departure <= getShiftWindow().cutoffTime;

}


/* Loads for the current view (everything, or just My Route) */
function getViewLoads() {

    return appState.schedules.filter(item =>
        item.tracked !== false &&   // Studio-only routes never show here
        !item.removed &&
        isInShiftWindow(item) &&
        !(HIDE_PAST_SDT && isLate(item)) &&
        (!appState.myRouteMode || appState.myRoutes.includes(item.route)) &&
        (!appState.routeFilter || item.route === appState.routeFilter)
    );

}


/* =========================================================
   SHIFT
   ========================================================= */

function updateShift() {

    const now = new Date();

    const minutes = now.getHours() * 60 + now.getMinutes();

    let shift = null;

    for (const item of SHIFTS) {

        const start = timeToMinutes(item.start);
        const end = timeToMinutes(item.end);

        const inShift = start <= end
            ? minutes >= start && minutes <= end
            : minutes >= start || minutes <= end; // crosses midnight (NIT)

        if (inShift) {
            shift = item;
            break;
        }

    }

    appState.currentShift = shift;

    if (!shift) {

        setText(elements.currentShift, "OFF SHIFT");
        setText(elements.currentCpt, "--");
        setText(elements.shiftRange, "--");

    } else {

        setText(elements.currentShift, shift.name);
        setText(elements.currentCpt, formatTime(shift.cpt));
        setText(
            elements.shiftRange,
            `${formatTime(shift.start)} – ${formatTime(shift.end)}`
        );

    }

    renderCptRoutes();

}


function renderCptRoutes() {

    if (!elements.cptRoutes) {
        return;
    }

    if (!appState.currentShift) {
        elements.cptRoutes.innerHTML = `<div class="no-data">No active shift</div>`;
        return;
    }

    if (!appState.schedules.length) {
        elements.cptRoutes.innerHTML = `<div class="no-data">No schedule loaded</div>`;
        return;
    }

    const routes = CPT_ROUTES[appState.currentShift.cpt] || [];

    if (!routes.length) {
        elements.cptRoutes.innerHTML = `<div class="no-data">No routes for this CPT</div>`;
        return;
    }

    // How many loads each route has in the schedule window
    const counts = {};
    appState.schedules.forEach(item => {
        if (!item.removed && isInShiftWindow(item)) {
            counts[item.route] = (counts[item.route] || 0) + 1;
        }
    });

    elements.cptRoutes.innerHTML = routes
        .map(route => {
            const starred = appState.myRoutes.includes(route);
            const active = appState.routeFilter === route;
            const count = counts[route] || 0;
            return `<button type="button" class="cpt-route ${starred ? "starred" : ""} ${active ? "active" : ""}"
                        data-route="${escapeHTML(route)}" aria-pressed="${active}"
                        title="${active ? "Show all routes" : `Show only ${escapeHTML(route)} loads`}">
                        <span class="cpt-route-name">${starred ? '<span class="row-star">★</span>' : ""}${escapeHTML(route)}</span>
                        <span class="cpt-route-count">${count}</span>
                    </button>`;
        })
        .join("");

}


/* Show only one route's loads (click the same route again, or ✕, to go back) */
function setRouteFilter(route) {

    appState.routeFilter = route && appState.routeFilter !== route ? route : null;

    renderCptRoutes();
    renderSchedule();

    // On phones the table is below the routes bar, so bring it into view
    if (appState.routeFilter && window.matchMedia("(max-width: 959px)").matches) {
        const card = document.querySelector(".schedule-card");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }

}


/* =========================================================
   RENDER TABLE
   ========================================================= */

function renderSchedule() {

    if (!elements.scheduleBody) {
        return;
    }

    let schedules = getViewLoads();

    if (appState.searchText) {
        const terms = parseSearch(appState.searchText);
        if (terms.length) {
            schedules = schedules.filter(item => matchesSearch(item, terms));
        }
    }

    if (appState.statusFilter === "finished") {

        // Picking "Finished" in the filter always shows them
        schedules = schedules.filter(item => item.status === "finished");

    } else {

        if (appState.statusFilter !== "all") {
            schedules = schedules.filter(item => item.status === appState.statusFilter);
        }

        // A picked route shows ALL its loads, finished ones too
        if (!appState.showFinished && !appState.routeFilter) {
            schedules = schedules.filter(item => !isFinishedHidden(item));
        }

    }

    schedules.sort(bySdt);

    // Board view and a picked route show every load; list view pages
    const visible = appState.viewMode === "list" && !appState.routeFilter
        ? schedules.slice(0, appState.pageSize)
        : schedules;

    elements.scheduleBody.innerHTML = visible.length
        ? visible.map((item, index) => renderRow(item, index)).join("")
        : renderEmptyState();

    renderBoard(visible);

    renderDoorMap();

    setText(
        elements.scheduleTitle,
        appState.viewMode === "doors"
            ? "Door Map"
            : appState.routeFilter ? `${appState.routeFilter} Loads`
            : appState.myRouteMode ? "My Route" : "Today's Schedule"
    );

    if (elements.routeFilterChip) {
        elements.routeFilterChip.classList.toggle("hidden", !appState.routeFilter);
        elements.routeFilterChip.textContent = appState.routeFilter
            ? `${appState.routeFilter} only ✕`
            : "";
    }

    const noun = schedules.length === 1 ? "load" : "loads";

    const through = `through ${formatTime(getShiftWindow().cutoffLabel)}`;

    // (the door map sets its own count)
    if (appState.viewMode !== "doors") setText(
        elements.scheduleCount,
        visible.length < schedules.length
            ? `Showing ${visible.length} of ${schedules.length} ${noun}, ${through}`
            : `${schedules.length} ${noun}, ${through}`
    );

    updateSummary();

    updateShowFinishedButton();

    renderNextLoad();

    // Studio (ob-studio-v4.js) redraws with the schedule
    window.Studio?.render();

}


/* =========================================================
   SEARCH
   Commas search for several things at once:
     "340, 327, 311"   doors
     "ABQ5, AFW5"      routes
     "20"              loads leaving in the 20:00 hour
     "20:3"            loads leaving 20:30 - 20:39
     "8pm", "8:30 am"  12-hour times
   Anything else matches route, VR ID or door.
   A load shows if it matches ANY of the terms.
   ========================================================= */

function parseSearch(text) {

    return String(text)
        .split(",")
        .map(term => term.trim().toLowerCase())
        .filter(Boolean)
        .map(parseSearchTerm);

}


function parseSearchTerm(term) {

    // 12-hour: "8pm", "8 pm", "8:30pm", "12 am"
    const ampm = term.match(/^(\d{1,2})(?::(\d{0,2}))?\s*(a|am|p|pm)$/);

    if (ampm) {

        let hour = Number(ampm[1]) % 12;

        if (ampm[3].startsWith("p")) {
            hour += 12;
        }

        return { kind: "time", prefix: String(hour).padStart(2, "0") + ":" + (ampm[2] || "") };

    }

    // Hour: "20", "8"  -> that hour
    if (/^\d{1,2}$/.test(term) && Number(term) <= 23) {
        return { kind: "time", prefix: term.padStart(2, "0") + ":" };
    }

    // Time: "20:3", "20:30", "8:15"
    const clock = term.match(/^(\d{1,2}):(\d{0,2})$/);

    if (clock) {
        return { kind: "time", prefix: clock[1].padStart(2, "0") + ":" + clock[2] };
    }

    // Door number: "340" -> DD340, PS340
    if (/^\d{3}$/.test(term)) {
        return { kind: "door", value: term };
    }

    return { kind: "text", value: term };

}


function matchesSearch(item, terms) {

    const sdtTime = getTime(item.sdt);
    const door = getDoor(item).toLowerCase();

    return terms.some(term => {

        if (term.kind === "time") {
            return sdtTime.startsWith(term.prefix);
        }

        if (term.kind === "door") {
            return door.replace(/^[a-z]+/, "") === term.value;
        }

        return (
            item.route.toLowerCase().includes(term.value) ||
            (item.fullRoute || "").toLowerCase().includes(term.value) ||
            door.includes(term.value) ||
            (item.vrId || "").toLowerCase().includes(term.value)
        );

    });

}


function renderEmptyState() {

    let title = "No loads to show";
    let text = "Try a different search or status filter.";
    let icon = "⌕";

    if (!appState.schedules.length) {

        title = "No schedule loaded";
        text = "Upload your CSV schedule to begin.";
        icon = "↑";

    } else if (appState.routeFilter) {

        title = `No ${escapeHTML(appState.routeFilter)} loads`;
        text = "This route has no loads in the current schedule window. Tap the route again to see all routes.";
        icon = "☷";

    } else if (appState.myRouteMode && !appState.myRoutes.length) {

        title = "No starred routes yet";
        text = "Open Routes and star the routes you work.";
        icon = "★";

    } else if (appState.myRouteMode) {

        title = "Nothing left for your routes";
        text = "Your starred routes are finished, departed, or not in this schedule.";
        icon = "★";

    }

    return `
        <tr class="empty-row">
            <td colspan="7">
                <div class="empty">
                    <div class="empty-icon">${icon}</div>
                    <h3>${title}</h3>
                    <p>${text}</p>
                </div>
            </td>
        </tr>
    `;

}


function renderRow(item, index) {

    const starred = appState.myRoutes.includes(item.route);

    const until = getTimeUntil(item);

    const meta = [
        renderCarrierTag(item),
        item.equipment ? `<span class="meta-text">${escapeHTML(item.equipment)}</span>` : ""
    ].filter(Boolean).join("");

    const classes = [
        "schedule-row",
        item.isCpt ? "cpt-row" : "",
        item.status === "finished" ? "finished-row" : ""
    ].join(" ");

    return `
        <tr class="${classes}" data-id="${escapeHTML(item.id)}">

            <td class="cell-num">${index + 1}</td>

            <td class="cell-route">
                <div class="route-line">
                    ${starred ? '<span class="row-star" title="My Route">★</span>' : ""}
                    <strong>${escapeHTML(item.route)}</strong>
                    ${item.isCpt ? '<span class="cpt-marker">CPT</span>' : ""}
                    <span class="location-mobile">${renderLocationChip(item)}</span>
                </div>
                ${meta ? `<div class="route-meta">${meta}</div>` : ""}
                ${renderProgress(item, true)}
            </td>

            <td class="cell-location">${renderLocationChip(item)}</td>

            <td class="cell-sdt" data-label="SDT">${renderDateCell(item.sdt)}</td>

            <td class="cell-cpt" data-label="CPT">${renderDateCell(item.cpt)}</td>

            <td class="cell-status">
                <span class="status-badge ${getStatusClass(item.status)}">
                    ${getStatusText(item.status)}
                </span>
            </td>

            <td class="cell-until ${until.text === "—" ? "until-empty" : ""}">
                <span class="${until.className}">${until.text}</span>
            </td>

        </tr>
    `;

}


/* =========================================================
   BOARD VIEW (a column per route, loads stacked by SDT)
   ========================================================= */

function renderBoard(loads) {

    const board = elements.boardView;

    if (!board) {
        return;
    }

    const isBoard = appState.viewMode === "board";

    board.classList.toggle("hidden", !isBoard);
    elements.tableView?.classList.toggle("hidden", appState.viewMode !== "list");

    if (!isBoard) {
        return;
    }

    if (!loads.length) {
        board.innerHTML = `<table class="board-empty"><tbody>${renderEmptyState()}</tbody></table>`;
        return;
    }

    // Group by route, keeping the order of each route's first load
    const groups = new Map();

    loads.forEach(item => {
        if (!groups.has(item.route)) {
            groups.set(item.route, []);
        }
        groups.get(item.route).push(item);
    });

    board.innerHTML = [...groups.entries()].map(([route, items]) => {

        const starred = appState.myRoutes.includes(route);

        return `
            <section class="board-column">

                <header class="board-column-header">
                    ${starred ? '<span class="row-star">★</span>' : ""}
                    <strong>${escapeHTML(route)}</strong>
                    <span class="board-count">${items.length}</span>
                </header>

                <div class="board-cards">
                    ${items.map(renderBoardCard).join("")}
                </div>

            </section>
        `;

    }).join("");

}


function renderBoardCard(item) {

    const until = getTimeUntil(item);

    return `
        <button type="button"
                class="board-card ${item.status === "finished" ? "finished-row" : ""} ${item.isCpt ? "board-card-cpt" : ""}"
                data-id="${escapeHTML(item.id)}">

            <div class="board-card-top">
                <div class="board-card-time">
                    <span class="date-cell-date">${formatDate(item.sdt)}</span>
                    <strong>${formatTime(getTime(item.sdt))}</strong>
                </div>
                <span class="status-badge ${getStatusClass(item.status)}">
                    ${getStatusText(item.status)}
                </span>
            </div>

            <div class="board-card-meta">
                ${renderLocationChip(item)}
                ${renderCarrierTag(item)}
                ${item.isCpt ? '<span class="cpt-marker">CPT</span>' : ""}
            </div>

            ${item.equipment ? `<div class="meta-text">${escapeHTML(item.equipment)}</div>` : ""}

            ${renderProgress(item, true)}

            ${until.text && until.text !== "—"
                ? `<div class="board-card-until ${until.className}">${until.text}</div>`
                : ""}

        </button>
    `;

}


/* =========================================================
   DOOR MAP (every door, and which load is on it)
   Shows the real doors, so it ignores search, filters and the
   shift cutoff. Your starred routes are highlighted.
   ========================================================= */

function renderDoorMap() {

    const map = elements.doorsView;

    if (!map) {
        return;
    }

    const isDoors = appState.viewMode === "doors";

    map.classList.toggle("hidden", !isDoors);

    if (!isDoors) {
        return;
    }

    if (!appState.schedules.length) {
        map.innerHTML = `<table class="board-empty"><tbody>${renderEmptyState()}</tbody></table>`;
        return;
    }

    const taken = getTakenDoors();

    const groups = getDoorGroups();

    // Doors in the CSV that aren't in DOOR_GROUPS (like DD123)
    const known = new Set(groups.flatMap(group => group.doors));

    const others = Object.keys(taken).filter(door => !known.has(door)).sort();

    if (others.length) {
        groups.push({ name: "Other doors", doors: others });
    }

    // Loads sitting in parking spots
    const parked = appState.schedules
        .filter(item => !item.removed && getDoor(item).toUpperCase().startsWith("PS"))
        .sort((a, b) => getDoor(a).localeCompare(getDoor(b)));

    const allDoors = groups.flatMap(group => group.doors);
    const usedCount = allDoors.filter(door => taken[door]).length;

    setText(elements.scheduleCount, `${usedCount} of ${allDoors.length} doors in use`);

    map.innerHTML = `

        <div class="door-map-legend">
            <span><i class="door-key door-key-open"></i>Open</span>
            <span><i class="status-key status-key-scheduled"></i>Scheduled</span>
            <span><i class="status-key status-key-progress"></i>In Progress</span>
            <span><i class="status-key status-key-finished"></i>Finished</span>
            <span><span class="row-star">★</span>My Route</span>
        </div>

        ${groups.map(group => {

            const used = group.doors.filter(door => taken[door]).length;

            return `
                <section class="door-map-group">
                    <h3>
                        ${escapeHTML(group.name)}
                        <span>${used} in use, ${group.doors.length - used} open</span>
                    </h3>
                    <div class="door-map-grid">
                        ${group.doors.map(door => renderDoorTile(door, taken[door])).join("")}
                    </div>
                </section>
            `;

        }).join("")}

        ${parked.length ? `
            <section class="door-map-group">
                <h3>Parking spots <span>${parked.length} in the yard</span></h3>
                <div class="door-map-grid">
                    ${parked.map(item => renderDoorTile(getDoor(item).toUpperCase(), item)).join("")}
                </div>
            </section>
        ` : ""}

    `;

}


function renderDoorTile(door, item) {

    const number = door.replace(/^DD/, "");

    if (!item) {
        return `
            <div class="door-tile door-tile-open">
                <span class="door-tile-number">${escapeHTML(number)}</span>
                <span class="door-tile-empty">Open</span>
            </div>
        `;
    }

    const mine = appState.myRoutes.includes(item.route);

    const statusClass = {
        "in-progress": "door-tile-progress",
        "finished": "door-tile-finished"
    }[item.status] || "door-tile-scheduled";

    return `
        <button type="button"
                class="door-tile ${statusClass} ${mine ? "door-tile-mine" : ""}"
                data-id="${escapeHTML(item.id)}"
                title="${escapeHTML(door)}: ${escapeHTML(item.route)}, ${getStatusText(item.status)}">
            <span class="door-tile-number">${escapeHTML(number)}</span>
            <strong class="door-tile-route">${mine ? '<span class="row-star">★</span>' : ""}${escapeHTML(item.route)}</strong>
            <span class="door-tile-time">${formatTime(getTime(item.sdt))}</span>
            ${item.carrierType === "3P" ? '<span class="door-tile-3p">3P</span>' : ""}
        </button>
    `;

}


function setViewMode(mode) {

    appState.viewMode = mode;

    saveViewSettings();

    updateViewButtons();

    renderSchedule();

}


function updateViewButtons() {

    elements.listViewButton?.classList.toggle("active", appState.viewMode === "list");
    elements.boardViewButton?.classList.toggle("active", appState.viewMode === "board");

    elements.listViewButton?.setAttribute("aria-pressed", String(appState.viewMode === "list"));
    elements.boardViewButton?.setAttribute("aria-pressed", String(appState.viewMode === "board"));

    elements.doorsViewButton?.classList.toggle("active", appState.viewMode === "doors");
    elements.doorsViewButton?.setAttribute("aria-pressed", String(appState.viewMode === "doors"));

    elements.pageSize?.classList.toggle("hidden", appState.viewMode !== "list");

}


/* =========================================================
   TIME UNTIL
   ========================================================= */

function getTimeUntil(item) {

    if (item.status === "finished") {

        if (item.finishedAt && !isFinishedHidden(item)) {

            const left = Math.max(
                1,
                Math.ceil((item.finishedAt + FINISH_HIDE_DELAY - Date.now()) / 60000)
            );

            return { text: `Hides in ${left}m`, className: "until-muted" };

        }

        return { text: "Finished", className: "until-muted" };

    }

    const departure = getDepartureTime(item);

    if (departure === null) {
        return { text: "--", className: "" };
    }

    const difference = departure - Date.now();

    // SDT has passed: no "Late" label, just a dash
    if (difference <= 0) {
        return { text: "—", className: "until-muted" };
    }

    return { text: formatDuration(difference), className: "" };

}


function formatDuration(ms) {

    const totalMinutes = Math.floor(ms / 60000);

    const hours = Math.floor(totalMinutes / 60);

    const minutes = totalMinutes % 60;

    if (hours >= 24) {
        return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }

    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

}


/* =========================================================
   NEXT LOAD (for your starred routes)
   ========================================================= */

function renderNextLoad() {

    const bar = elements.nextLoad;

    if (!bar) {
        return;
    }

    if (!appState.myRoutes.length || !appState.schedules.length) {
        bar.classList.add("hidden");
        bar.dataset.id = "";
        return;
    }

    const now = Date.now();

    const mine = appState.schedules.filter(item =>
        !item.removed &&
        isInShiftWindow(item) &&
        item.status !== "finished" &&
        appState.myRoutes.includes(item.route)
    );

    const next = mine
        .filter(item => (getDepartureTime(item) ?? 0) > now)
        .sort(bySdt)[0];

    bar.dataset.id = next ? next.id : "";

    bar.classList.toggle("clickable", Boolean(next));

    bar.innerHTML = `

        <span class="next-load-star" aria-hidden="true">★</span>

        <span class="next-load-main">

            <span class="next-load-label">Your next load</span>

            ${next
                ? `<span class="next-load-info">
                       <strong>${escapeHTML(next.route)}</strong>
                       <span>leaves ${formatDateTime(next.sdt)}</span>
                       ${renderLocationChip(next)}
                   </span>`
                : `<span class="next-load-info"><strong>No more upcoming loads this shift</strong></span>`}

        </span>

        ${next
            ? `<span class="next-load-in">in ${formatDuration(getDepartureTime(next) - now)}</span>`
            : ""}

    `;

    bar.classList.remove("hidden");

}


/* =========================================================
   UPLOAD INFO ("Updated 12:40, 45 min ago")
   ========================================================= */

function updateUploadInfo() {

    const info = elements.uploadInfo;

    if (!info) {
        return;
    }

    if (appState.uploading) {
        info.textContent = "Uploading...";
        info.classList.remove("stale");
        return;
    }

    if (!appState.uploadedAt) {
        info.textContent = "Load schedule";
        info.classList.remove("stale");
        return;
    }

    const uploaded = new Date(appState.uploadedAt);

    const age = Date.now() - appState.uploadedAt;

    const minutes = Math.floor(age / 60000);

    let ago;

    if (minutes < 1) {
        ago = "just now";
    } else if (minutes < 60) {
        ago = `${minutes} min ago`;
    } else if (minutes < 1440) {
        ago = `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
    } else {
        ago = `${Math.floor(minutes / 1440)}d ago`;
    }

    const time = formatTime(
        String(uploaded.getHours()).padStart(2, "0") + ":" +
        String(uploaded.getMinutes()).padStart(2, "0")
    );

    info.textContent = `Updated ${time}, ${ago}`;

    info.classList.toggle("stale", age > STALE_AFTER);

    info.title = age > STALE_AFTER
        ? "This schedule is over an hour old. Upload a new CSV."
        : "";

}


/* =========================================================
   DATE DISPLAY
   ========================================================= */

/* "2026-09-18" -> "18-Sep-26" */
function formatDate(value) {

    if (!value || value.length < 10) {
        return "";
    }

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const [year, month, day] = value.substring(0, 10).split("-");

    return `${day}-${months[Number(month) - 1]}-${year.substring(2)}`;

}


/* One line: "18-Sep-26 06:45" */
function formatDateTime(value) {

    const date = formatDate(value);

    const time = formatTime(getTime(value));

    return date ? `${date} ${time}` : time;

}


/* Two lines for the table: date on top, time below */
function renderDateCell(value) {

    const date = formatDate(value);

    const time = formatTime(getTime(value));

    return `
        <div class="date-cell">
            ${date ? `<span class="date-cell-date">${date}</span>` : ""}
            <span class="date-cell-time">${time}</span>
        </div>
    `;

}


/* =========================================================
   TIME FORMAT
   ========================================================= */

function setTimeFormat(format) {

    appState.timeFormat = format;

    localStorage.setItem(TIME_FORMAT_KEY, format);

    syncControls();

    updateClock();

    updateShift();

    renderSchedule();

    updateUploadInfo();

    updateOpenDetails();

}


function formatTime(time) {

    if (!time) {
        return "--";
    }

    const [hour, minute] = time.split(":").map(Number);

    if (isNaN(hour) || isNaN(minute)) {
        return "--";
    }

    if (appState.timeFormat === "24") {
        return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
    }

    const suffix = hour >= 12 ? "PM" : "AM";

    const displayHour = hour % 12 === 0 ? 12 : hour % 12;

    return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;

}


/* =========================================================
   CLOCK
   ========================================================= */

function updateClock() {

    const now = new Date();

    setText(
        elements.currentDate,
        now.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric"
        })
    );

    setText(elements.currentTime, formatTime(getCurrent24Hour()));

}


function getCurrent24Hour() {

    const now = new Date();

    return (
        String(now.getHours()).padStart(2, "0") + ":" +
        String(now.getMinutes()).padStart(2, "0")
    );

}


/* =========================================================
   DETAILS PANEL
   ========================================================= */

function openDetails(id) {

    const item = appState.schedules.find(schedule => schedule.id === id);

    if (!item) {
        return;
    }

    appState.selectedScheduleId = id;

    updateDetails(item);

    elements.detailsPanel?.classList.remove("hidden");
    elements.detailsBackdrop?.classList.remove("hidden");
    document.body.classList.add("details-open");

}


function updateDetails(item) {

    setText(
        elements.detailRoute,
        item.fullRoute && item.fullRoute !== item.route
            ? `${item.route} (${item.fullRoute})`
            : item.route
    );

    setText(elements.detailStatus, getStatusText(item.status));

    if (elements.detailStatus) {
        elements.detailStatus.className = `status-badge ${getStatusClass(item.status)}`;
    }

    setText(elements.detailSdt, formatDateTime(item.sdt));
    setText(elements.detailCpt, formatDateTime(item.cpt));
    setText(elements.detailVrId, item.vrId || "--");

    const fmc = getFmcUrl(item);

    if (elements.fmcLink) {
        elements.fmcLink.classList.toggle("hidden", !fmc);
        elements.fmcLink.href = fmc || "#";
    }

    const door = getDoor(item);

    setText(elements.detailLocation, door || "Not attached");

    elements.detailLocation?.classList.toggle("muted-value", !door);

    setText(
        elements.detailDoorNote,
        isManualDoor(item) ? "Attached by you on this site" : ""
    );

    setText(elements.attachButton, door ? "Change door" : "Attach to door");

    elements.detachButton?.classList.toggle("hidden", !door);

    setText(elements.detailEquipment, item.equipment || "--");

    setText(
        elements.detailCarrier,
        item.carrierCode
            ? `${item.carrierCode}${item.carrierType ? ` - ${item.carrierType}` : ""}`
            : "--"
    );

    // Trailer number comes from the CSV; "--" when there isn't one yet
    setText(elements.detailTrailer, item.trailer || "--");
    elements.detailTrailer?.classList.toggle("muted-value", !item.trailer);

    setText(elements.detailPackages, item.packages ?? "--");
    setText(elements.detailContainers, item.containers ?? "--");

    if (elements.detailProgress) {
        const html = renderProgress(item);
        // Only redraw when it changed (this runs every second)
        if (elements.detailProgress.dataset.html !== html) {
            elements.detailProgress.innerHTML = html || '<span class="muted-value">No progress data</span>';
            elements.detailProgress.dataset.html = html;
        }
    }


    setText(elements.detailCurrentTime, formatTime(getCurrent24Hour()));

    const until = getTimeUntil(item);

    setText(elements.detailTimeUntil, until.text);

    if (elements.detailTimeUntil) {
        elements.detailTimeUntil.className = until.className;
    }

}


function updateOpenDetails() {

    if (!appState.selectedScheduleId) {
        return;
    }

    const item = getSelectedSchedule();

    if (item) {
        updateDetails(item);
    }

}


function closeDetails() {

    elements.detailsPanel?.classList.add("hidden");
    elements.detailsBackdrop?.classList.add("hidden");
    document.body.classList.remove("details-open");

    appState.selectedScheduleId = null;

}


function getSelectedSchedule() {

    return appState.schedules.find(
        item => item.id === appState.selectedScheduleId
    );

}


/* =========================================================
   IN PROGRESS / FINISH / REMOVE
   They last until the next CSV upload.
   ========================================================= */

function markInProgress() {

    const item = getSelectedSchedule();

    if (!item) {
        return;
    }

    // (also undoes a Finish)
    saveLoadChange(item, { status: "in-progress", finishedAt: null });

}


function markFinished() {

    const item = getSelectedSchedule();

    if (!item) {
        return;
    }

    saveLoadChange(item, { status: "finished", finishedAt: Date.now() });

}


function removeSelectedLoad() {

    const item = getSelectedSchedule();

    if (!item) {
        return;
    }

    if (!confirm(`Remove ${item.route} (SDT ${formatDateTime(item.sdt)}) from the schedule?`)) {
        return;
    }

    closeDetails();

    saveLoadChange(item, { removed: true });

}


/* =========================================================
   MY ROUTE / SHOW FINISHED BUTTONS
   ========================================================= */

function toggleMyRouteMode() {

    if (!appState.myRouteMode && !appState.myRoutes.length) {
        openRoutesPanel("You haven't starred any routes yet. Tap a route to star it.");
        return;
    }

    setMyRouteMode(!appState.myRouteMode);

}


function setMyRouteMode(value) {

    appState.myRouteMode = value;

    saveViewSettings();

    updateMyRouteButton();

    renderSchedule();

}


function showFullSchedule() {

    closeRoutesPanel();

    setMyRouteMode(false);

}


function updateMyRouteButton() {

    const count = appState.myRoutes.length;

    if (elements.myRouteButton) {
        elements.myRouteButton.classList.toggle("active", appState.myRouteMode);
        elements.myRouteButton.textContent = count ? `★ My Route (${count})` : "★ My Route";
    }

    elements.scheduleNav?.classList.toggle(
        "active",
        !document.getElementById("routesOverlay")
    );

}


function updateShowFinishedButton() {

    const button = elements.showFinishedButton;

    if (!button) {
        return;
    }

    const count = getViewLoads().filter(item => item.status === "finished").length;

    button.classList.toggle("active", appState.showFinished);

    button.setAttribute("aria-pressed", String(appState.showFinished));

    button.textContent = appState.showFinished
        ? `✓ Hide finished (${count})`
        : `✓ Show finished (${count})`;

}


/* =========================================================
   ROUTES PANEL (star the routes you work)
   ========================================================= */

function openRoutesPanel(message) {

    closeRoutesPanel();

    const overlay = document.createElement("div");

    overlay.className = "route-selector-overlay";

    overlay.id = "routesOverlay";

    overlay.innerHTML = `

        <div class="route-selector" role="dialog" aria-modal="true" aria-labelledby="routesTitle">

            <div class="route-selector-header">

                <div>
                    <h2 id="routesTitle">Routes</h2>
                    <p>${escapeHTML(message || "Tap a route to star it. Starred routes show up in My Route.")}</p>
                </div>

                <button type="button" data-action="close" aria-label="Close">×</button>

            </div>

            <div class="route-selector-body">
                ${renderRouteGroups()}
            </div>

            <div class="route-selector-actions">
                <button type="button" data-action="clear">Clear stars</button>
                <button type="button" data-action="show-mine">Show My Route</button>
            </div>

        </div>

    `;

    overlay.addEventListener("click", event => {

        if (event.target === overlay) {
            closeRoutesPanel();
            return;
        }

        const starButton = event.target.closest("[data-star]");

        if (starButton) {
            toggleStar(starButton.dataset.star);
            refreshStarButtons(overlay);
            return;
        }

        const action = event.target.closest("[data-action]")?.dataset.action;

        if (action === "close") {

            closeRoutesPanel();

        } else if (action === "clear") {

            appState.myRoutes = [];
            saveMyRoutes();
            refreshStarButtons(overlay);

        } else if (action === "show-mine") {

            closeRoutesPanel();

            if (appState.myRoutes.length) {
                setMyRouteMode(true);
            }

        }

    });

    document.body.appendChild(overlay);

    document.body.classList.add("routes-open");

    elements.routesNav?.classList.add("active");
    elements.scheduleNav?.classList.remove("active");

}


/* Routes grouped by CPT, in shift order (09:00, 15:00, 21:00, 03:00) */
function renderRouteGroups() {

    const shiftOrder = SHIFTS.map(shift => shift.cpt);

    const order = Object.keys(CPT_ROUTES).sort((a, b) => {
        const ai = shiftOrder.indexOf(a);
        const bi = shiftOrder.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    return order.map(cpt => `
        <section class="route-group">
            <h3>CPT ${formatTime(cpt)}</h3>
            <div class="route-list">
                ${CPT_ROUTES[cpt].map(route => renderRouteOption(route, cpt)).join("")}
            </div>
        </section>
    `).join("");

}


function renderRouteOption(route, cpt) {

    const starred = appState.myRoutes.includes(route);

    // A route with two CPTs (AZA5) counts only the loads for this CPT
    const splitByCpt = getRouteCpts(route).length > 1;

    const loads = appState.schedules.filter(item =>
        item.route === route &&
        !item.removed &&
        isInShiftWindow(item) &&
        item.status !== "finished" &&
        (!splitByCpt || getTime(item.cpt) === cpt)
    ).length;

    return `
        <button type="button"
                class="route-option ${starred ? "starred" : ""}"
                data-star="${escapeHTML(route)}"
                aria-pressed="${starred}">
            <span class="route-star">${starred ? "★" : "☆"}</span>
            <span class="route-name">${escapeHTML(route)}</span>
            <span class="route-loads">${loads ? `${loads} load${loads === 1 ? "" : "s"}` : "–"}</span>
        </button>
    `;

}


function refreshStarButtons(container) {

    container.querySelectorAll("[data-star]").forEach(button => {
        const starred = appState.myRoutes.includes(button.dataset.star);
        button.classList.toggle("starred", starred);
        button.setAttribute("aria-pressed", String(starred));
        button.querySelector(".route-star").textContent = starred ? "★" : "☆";
    });

}


function toggleStar(route) {

    appState.myRoutes = appState.myRoutes.includes(route)
        ? appState.myRoutes.filter(item => item !== route)
        : [...appState.myRoutes, route];

    saveMyRoutes();

}


function saveMyRoutes() {

    writeJSON(MY_ROUTE_KEY, appState.myRoutes);

    updateMyRouteButton();

    renderSchedule();

    renderCptRoutes();

}


function closeRoutesPanel() {

    document.getElementById("routesOverlay")?.remove();

    document.body.classList.remove("routes-open");

    elements.routesNav?.classList.remove("active");

    updateMyRouteButton();

}


/* FMC link for a load, or "" while FMC_URL_TEMPLATE isn't set */
function getFmcUrl(item) {

    if (!FMC_URL_TEMPLATE || !item.vrId) {
        return "";
    }

    let url = FMC_URL_TEMPLATE.replaceAll("{VRID}", encodeURIComponent(item.vrId));

    if (!/^https?:\/\//i.test(url)) {
        url = "https://" + url;
    }

    return url;

}


/* =========================================================
   DOORS (attach a load to a door yourself)
   The site isn't connected to Amazon's system, so this only
   changes the door on this schedule. A door can only hold
   one load at a time.
   ========================================================= */

/*
 * The load's door or spot:
 *   door === null  -> use the CSV's Location
 *   door === ""    -> detached (no door)
 *   door === "DD315" -> attached by you
 */
function getDoor(item) {

    if (item.door === null || item.door === undefined) {
        return item.location || "";
    }

    return item.door;

}


function isManualDoor(item) {

    return Boolean(item.door) && item.door !== item.location;

}


/*
 * On a new CSV upload, keep a door you attached yourself
 * unless the CSV now gives that load its own location.
 */
function keepManualDoor(id, csvLocation) {

    if (csvLocation) {
        return null;
    }

    const old = appState.schedules.find(item => item.id === id);

    return old && old.door ? old.door : null;

}


/* Every dock door, e.g. [{ name: "300 side", doors: ["DD310", ...] }] */
function getDoorGroups() {

    return DOOR_GROUPS.map(group => {

        const doors = [];

        if (Array.isArray(group.doors)) {
            group.doors.forEach(number => doors.push(`DD${number}`));
        } else {
            for (let number = group.from; number <= group.to; number++) {
                if (!(group.skip || []).includes(number)) {
                    doors.push(`DD${number}`);
                }
            }
        }

        return { name: group.name, doors };

    });

}


/* Which load is on each door right now: { "DD315": load, ... } */
function getTakenDoors() {

    const taken = {};

    appState.schedules.forEach(item => {

        if (item.removed) {
            return;
        }

        const door = getDoor(item).toUpperCase();

        if (door.startsWith("DD") && !taken[door]) {
            taken[door] = item;
        }

    });

    return taken;

}


function openDoorPicker() {

    const item = getSelectedSchedule();

    if (!item) {
        return;
    }

    closeDoorPicker();

    const taken = getTakenDoors();

    const current = getDoor(item).toUpperCase();

    const groups = getDoorGroups();

    const openCount = groups
        .flatMap(group => group.doors)
        .filter(door => !taken[door])
        .length;

    const overlay = document.createElement("div");

    overlay.className = "route-selector-overlay";

    overlay.id = "doorOverlay";

    overlay.innerHTML = `

        <div class="route-selector door-picker" role="dialog" aria-modal="true" aria-labelledby="doorTitle">

            <div class="route-selector-header">

                <div>
                    <h2 id="doorTitle">${current ? "Move" : "Attach"} ${escapeHTML(item.route)} to ${current ? "another" : "a"} door</h2>
                    <p>SDT ${formatDateTime(item.sdt)}. ${openCount} doors open.</p>
                </div>

                <button type="button" data-action="close" aria-label="Close">×</button>

            </div>

            <div class="door-legend">
                <span><i class="door-key door-key-open"></i>Open</span>
                <span><i class="door-key door-key-current"></i>This load</span>
                <span><i class="door-key door-key-taken"></i>Taken</span>
            </div>

            <div class="route-selector-body">

                ${groups.map(group => `
                    <section class="door-group">
                        <h3>
                            ${escapeHTML(group.name)}
                            <span>${group.doors.filter(door => !taken[door]).length} open</span>
                        </h3>
                        <div class="door-grid">
                            ${group.doors.map(door => renderDoorButton(door, taken[door], item, current)).join("")}
                        </div>
                    </section>
                `).join("")}

            </div>

        </div>

    `;

    overlay.addEventListener("click", event => {

        if (event.target === overlay || event.target.closest('[data-action="close"]')) {
            closeDoorPicker();
            return;
        }

        const button = event.target.closest("[data-door]");

        if (button && !button.disabled) {
            attachSelectedLoad(button.dataset.door);
        }

    });

    document.body.appendChild(overlay);

    document.body.classList.add("routes-open");

}


function renderDoorButton(door, takenBy, item, current) {

    const isCurrent = door === current;

    const isTaken = takenBy && takenBy.id !== item.id;

    const number = door.replace(/^DD/, "");

    let label = "Open";
    let className = "door-open";

    if (isCurrent) {
        label = "This load";
        className = "door-current";
    } else if (isTaken) {
        label = takenBy.route;
        className = "door-taken";
    }

    return `
        <button type="button"
                class="door-btn ${className}"
                data-door="${door}"
                ${isTaken || isCurrent ? "disabled" : ""}
                title="${isTaken ? `${door}: ${escapeHTML(takenBy.route)} is here` : door}">
            <strong>${number}</strong>
            <small>${escapeHTML(label)}</small>
        </button>
    `;

}


function attachSelectedLoad(door) {

    const item = getSelectedSchedule();

    if (!item) {
        return;
    }

    // Double-check it's still free (someone may have just taken it)
    const takenBy = getTakenDoors()[door];

    if (takenBy && takenBy.id !== item.id) {
        alert(`${door} is already taken by ${takenBy.route}.`);
        return;
    }

    closeDoorPicker();

    saveLoadChange(item, { door });

    showToast(`${item.route} attached to ${door}`);

}


function detachSelectedLoad() {

    const item = getSelectedSchedule();

    if (!item) {
        return;
    }

    const door = getDoor(item);

    if (!door || !confirm(`Detach ${item.route} from ${door}?`)) {
        return;
    }

    saveLoadChange(item, { door: "" });

    showToast(`${item.route} detached from ${door}`);

}


function closeDoorPicker() {

    const overlay = document.getElementById("doorOverlay");

    if (!overlay) {
        return;
    }

    overlay.remove();

    if (!document.getElementById("routesOverlay")) {
        document.body.classList.remove("routes-open");
    }

}


/* =========================================================
   LOAD ALERTS
   Warns ALERT_MINUTES before a starred route's SDT.
   Works while the site is open (a tab in the background is fine).
   ========================================================= */

function toggleAlerts() {

    if (appState.alertsOn) {
        appState.alertsOn = false;
        localStorage.setItem(ALERTS_KEY, "off");
        updateAlertsButton();
        showToast("Alerts off");
        return;
    }

    if (!appState.myRoutes.length) {
        openRoutesPanel("Star the routes you want alerts for first.");
        return;
    }

    appState.alertsOn = true;
    localStorage.setItem(ALERTS_KEY, "on");
    updateAlertsButton();

    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().then(() => {
            showToast(alertsOnMessage());
            checkAlerts();
        });
    } else {
        showToast(alertsOnMessage());
        checkAlerts();
    }

}


function alertsOnMessage() {

    const phoneNote = "Notification" in window && Notification.permission === "granted"
        ? ""
        : " (pop-ups inside the site only)";

    return `Alerts on: ${ALERT_MINUTES} min before your routes leave${phoneNote}`;

}


function updateAlertsButton() {

    const button = elements.alertsButton;

    if (!button) {
        return;
    }

    button.classList.toggle("active", appState.alertsOn);

    button.setAttribute("aria-pressed", String(appState.alertsOn));

    button.textContent = appState.alertsOn ? "🔔 Alerts on" : "🔕 Alerts off";

}


function checkAlerts() {

    // No alerts while the site is locked
    if (isLockedNow()) {
        return;
    }

    if (!appState.alertsOn || !appState.myRoutes.length) {
        return;
    }

    const now = Date.now();

    const windowEnd = now + ALERT_MINUTES * 60000;

    // Loads already alerted (kept for a day so each one alerts once)
    const alerted = readJSON(ALERTED_KEY, {});

    Object.keys(alerted).forEach(id => {
        if (now - alerted[id] > 24 * 60 * 60000) {
            delete alerted[id];
        }
    });

    appState.schedules
        .filter(item =>
            item.tracked !== false &&
            !item.removed &&
            item.status !== "finished" &&
            appState.myRoutes.includes(item.route) &&
            !alerted[item.id]
        )
        .forEach(item => {

            const departure = getDepartureTime(item);

            if (departure === null || departure <= now || departure > windowEnd) {
                return;
            }

            alerted[item.id] = now;

            const minutes = Math.max(1, Math.round((departure - now) / 60000));

            const title = `${item.route} leaves in ${minutes} min`;

            const body = [
                `SDT ${formatTime(getTime(item.sdt))}`,
                getDoor(item),
                item.vrId ? `VR ${item.vrId}` : ""
            ].filter(Boolean).join(" · ");

            showToast(`${title}. ${body}`, item.id);

            if ("Notification" in window && Notification.permission === "granted") {
                try {
                    const note = new Notification(title, { body, tag: item.id });
                    note.onclick = () => {
                        window.focus();
                        openDetails(item.id);
                        note.close();
                    };
                } catch (error) {
                    console.warn("Notification failed", error);
                }
            }

        });

    writeJSON(ALERTED_KEY, alerted);

}


/* Small message at the bottom of the screen */
function showToast(message, loadId) {

    const area = elements.toastArea;

    if (!area) {
        return;
    }

    const toast = document.createElement(loadId ? "button" : "div");

    toast.className = "toast";

    if (loadId) {
        toast.type = "button";
        toast.addEventListener("click", () => {
            openDetails(loadId);
            toast.remove();
        });
    }

    toast.textContent = message;

    area.appendChild(toast);

    setTimeout(() => toast.remove(), loadId ? 15000 : 3500);

}


/* =========================================================
   SUMMARY CARDS (follow My Route when it's on)
   ========================================================= */

function updateSummary() {

    const loads = getViewLoads();

    const count = status => loads.filter(item => item.status === status).length;

    setText(elements.scheduledCount, count("scheduled"));
    setText(elements.progressCount, count("in-progress"));
    setText(elements.totalCount, loads.length);
    setText(elements.finishedCount, count("finished"));

}


/* =========================================================
   SIMPLE MODE (saved on this device only)
   ========================================================= */

function startLocalMode() {

    // Simple mode doesn't use the team password screen
    elements.lockScreen?.classList.add("hidden");
    document.body.classList.remove("locked");

    const saved = readJSON(LOCAL_SCHEDULE_KEY, []);

    appState.schedules = (Array.isArray(saved) ? saved : [])
        .map(item => {

            const route = matchRoute(item.fullRoute || item.route || "");

            if (!route || !item.id) {
                return null;
            }

            // Older saves used "canceled"; that's "removed" now
            const wasCanceled = item.status === "canceled" || item.canceled;

            return {
                ...item,
                route,
                fullRoute: item.fullRoute || item.route,
                status: wasCanceled ? "scheduled" : item.status,
                removed: Boolean(item.removed || wasCanceled),
                finishedAt: item.finishedAt || null
            };

        })
        .filter(Boolean)
        .sort(bySdt);

    appState.uploadedAt = Number(localStorage.getItem(LOCAL_UPLOAD_KEY)) || null;

    appState.signedIn = true;

    renderSchedule();
    renderCptRoutes();
    updateUploadInfo();

}


function saveLocalSchedule() {

    writeJSON(LOCAL_SCHEDULE_KEY, appState.schedules);

}


/* =========================================================
   FIREBASE (shared schedule + team password)
   Not used while USE_FIREBASE is false.
   ========================================================= */

function isFirebaseConfigured() {

    return (
        typeof firebase !== "undefined" &&
        typeof FIREBASE_CONFIG !== "undefined" &&
        typeof TEAM_EMAIL !== "undefined" &&
        FIREBASE_CONFIG.apiKey &&
        !String(FIREBASE_CONFIG.apiKey).startsWith("PASTE")
    );

}


// If Firebase hasn't answered by then, show the password box anyway
const STARTUP_TIMEOUT = 8000;


function startFirebase() {

    if (!isFirebaseConfigured()) {
        showLockScreen(
            "Firebase isn't set up yet. Fill in firebase-config.js (see SETUP.md)."
        );
        return;
    }

    // Never sit on "Opening..." forever
    setTimeout(() => {
        if (elements.lockScreen?.classList.contains("checking")) {
            showLockScreen("Taking longer than usual to connect. Try the password, or refresh the page.");
        }
    }, STARTUP_TIMEOUT);

    try {

        firebase.initializeApp(FIREBASE_CONFIG);

        firebaseState.auth = firebase.auth();

        firebaseState.db = firebase.firestore();

    } catch (error) {

        console.error(error);
        showLockScreen("Couldn't start Firebase: " + (error.message || error));
        return;

    }

    // Keeps a copy on the device so the schedule opens fast
    // and still shows if the signal drops for a moment
    firebaseState.db
        .enablePersistence({ synchronizeTabs: true })
        .catch(() => { /* not supported in this browser - that's fine */ });

    // Lets password managers (iPhone Keychain, Samsung Pass) save the password
    if (elements.lockUsername) {
        elements.lockUsername.value = TEAM_EMAIL;
    }

    // SESSION = the sign-in only lasts while this tab is open.
    // Closing the tab means the password is needed again.
    // (Not waited on here, so a slow browser can't freeze "Opening...")
    setSessionSignIn();

    // Runs on page load and whenever someone unlocks or locks
    firebaseState.auth.onAuthStateChanged(user => {

        if (user && (codeLock.reopened || isIdleTooLong())) {

            // Restored tab, or idle too long since the last visit
            codeLock.reopened = false;
            codeLock.pendingMessage = isIdleTooLong()
                ? "Locked after " + IDLE_MINUTES + " minutes without activity."
                : "";
            firebaseState.auth.signOut();
            return;

        }

        if (user) {
            onUnlocked();
        } else {
            onLocked();
        }

    }, error => {

        console.error(error);
        showLockScreen("Couldn't check the sign-in: " + (error.message || error));

    });

}


/* Sign-in only lasts while the tab is open. Gives up after 3 seconds. */
function setSessionSignIn() {

    const set = firebaseState.auth
        .setPersistence(firebase.auth.Auth.Persistence.SESSION)
        .catch(error => console.warn("Could not set session sign-in", error));

    const timeout = new Promise(resolve => setTimeout(resolve, 3000));

    return Promise.race([set, timeout]);

}


/* ---------- Password screen ---------- */

function unlock(password) {

    if (!firebaseState.auth) {
        return;
    }

    if (!password) {
        setLockError("Enter the team password.");
        return;
    }

    setLockError("");

    // Counts as activity, so the idle check doesn't lock right away
    codeLock.reopened = false;
    sessionStorage.setItem(CODE_ACTIVITY_KEY, String(Date.now()));

    if (elements.lockSubmit) {
        elements.lockSubmit.disabled = true;
        elements.lockSubmit.textContent = "Checking...";
    }

    setSessionSignIn()
        .then(() => firebaseState.auth.signInWithEmailAndPassword(TEAM_EMAIL, password))
        .catch(error => {

            console.error(error);

            const messages = {
                "auth/invalid-credential": "Wrong password. Try again.",
                "auth/wrong-password": "Wrong password. Try again.",
                "auth/invalid-login-credentials": "Wrong password. Try again.",
                "auth/user-not-found": "The team account doesn't exist yet. Check SETUP.md step 3.",
                "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
                "auth/network-request-failed": "No connection. Check your signal and try again."
            };

            setLockError(messages[error.code] || "Couldn't unlock. Try again.");

            if (elements.lockPassword) {
                elements.lockPassword.select();
            }

        })
        .finally(() => {

            if (elements.lockSubmit) {
                elements.lockSubmit.disabled = false;
                elements.lockSubmit.textContent = "Open schedule";
            }

        });

}


function lock() {

    if (!firebaseState.auth) {
        return;
    }

    if (confirm("Lock the schedule on this device? You'll need the team password to open it again.")) {
        firebaseState.auth.signOut();
    }

}


function onUnlocked() {

    appState.signedIn = true;

    if (elements.lockPassword) {
        elements.lockPassword.value = "";
    }

    elements.lockScreen?.classList.add("hidden");

    document.body.classList.remove("locked");

    listenToSchedule();

}


function onLocked() {

    appState.signedIn = false;

    window.Studio?.lock();

    stopListening();

    // Nothing stays on screen once it's locked
    appState.schedules = [];
    appState.uploadedAt = null;

    closeDetails();
    closeRoutesPanel();
    closeDoorPicker();

    renderSchedule();
    renderCptRoutes();
    updateUploadInfo();

    showLockScreen(codeLock.pendingMessage || "");

    codeLock.pendingMessage = "";

}


function showLockScreen(message) {

    elements.lockScreen?.classList.remove("hidden", "checking");

    document.body.classList.add("locked");

    setLockError(message);

    // Don't pop the keyboard up on phones; focus on bigger screens only
    if (elements.lockPassword && window.matchMedia("(min-width: 960px)").matches) {
        elements.lockPassword.focus();
    }

}


function setLockError(message) {

    setText(elements.lockError, message);

}


/* ---------- Live updates ---------- */

function listenToSchedule() {

    stopListening();

    const db = firebaseState.db;

    // Every load. Runs again whenever anyone changes anything.
    firebaseState.unsubscribeLoads = db
        .collection(LOADS_COLLECTION)
        .onSnapshot({ includeMetadataChanges: true }, snapshot => {

            appState.schedules = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .sort(bySdt);

            // fromCache = showing the saved copy, not live data
            setSyncStatus(!snapshot.metadata.fromCache);

            // The open load might be gone after someone uploads
            if (appState.selectedScheduleId && !getSelectedSchedule()) {
                closeDetails();
            }

            renderSchedule();
            renderCptRoutes();
            updateOpenDetails();

        }, handleFirebaseError);

    // Upload time
    firebaseState.unsubscribeMeta = db
        .collection(META_COLLECTION)
        .doc(META_DOC)
        .onSnapshot(doc => {

            appState.uploadedAt = doc.exists ? (doc.data().uploadedAt || null) : null;

            updateUploadInfo();

        }, handleFirebaseError);

}


function stopListening() {

    firebaseState.unsubscribeLoads?.();
    firebaseState.unsubscribeMeta?.();

    firebaseState.unsubscribeLoads = null;
    firebaseState.unsubscribeMeta = null;

}


function handleFirebaseError(error) {

    console.error(error);

    setSyncStatus(false);

    if (error.code === "permission-denied") {
        alert(
            "The database refused access.\n" +
            "Check the Firestore rules (SETUP.md step 4) and that TEAM_EMAIL matches the team account."
        );
    }

}


/* The "● LIVE" dot in the header */
function setSyncStatus(live) {

    const status = elements.liveStatus;

    if (!status) {
        return;
    }

    status.textContent = live ? "● LIVE" : "● OFFLINE";

    status.classList.toggle("offline", !live);

    status.title = live
        ? "Connected. Changes show up for everyone."
        : "Not connected. Showing the last saved copy.";

}


/* ---------- Saving ---------- */

/*
 * A new CSV replaces the whole shared schedule:
 * loads not in the new CSV get deleted, the rest get
 * written fresh (so any Finish/Remove from before resets).
 */
async function uploadSchedule(loads) {

    // Simple mode: save on this device
    if (!USE_FIREBASE) {

        appState.schedules = loads;

        appState.uploadedAt = Date.now();

        saveLocalSchedule();

        localStorage.setItem(LOCAL_UPLOAD_KEY, String(appState.uploadedAt));

        // The open load might not be in the new CSV
        if (appState.selectedScheduleId && !getSelectedSchedule()) {
            closeDetails();
        }

        renderSchedule();
        renderCptRoutes();
        updateUploadInfo();

        return;

    }

    if (!appState.signedIn || !firebaseState.db) {
        alert("Unlock the schedule first.");
        return;
    }

    const db = firebaseState.db;

    const loadsRef = db.collection(LOADS_COLLECTION);

    appState.uploading = true;

    updateUploadInfo();

    try {

        const existing = await loadsRef.get();

        const newIds = new Set(loads.map(load => load.id));

        const writes = [];

        existing.forEach(doc => {
            if (!newIds.has(doc.id)) {
                writes.push(batch => batch.delete(doc.ref));
            }
        });

        loads.forEach(load => {
            const { id, ...data } = load;
            writes.push(batch => batch.set(loadsRef.doc(id), data));
        });

        writes.push(batch => batch.set(
            db.collection(META_COLLECTION).doc(META_DOC),
            { uploadedAt: Date.now(), loadCount: loads.length }
        ));

        for (let start = 0; start < writes.length; start += BATCH_LIMIT) {

            const batch = db.batch();

            writes.slice(start, start + BATCH_LIMIT).forEach(write => write(batch));

            await batch.commit();

        }

    } catch (error) {

        console.error(error);

        alert(
            "The upload didn't go through.\n" +
            (error.code === "permission-denied"
                ? "The database refused it. Check the Firestore rules."
                : "Check your connection and try again.")
        );

    } finally {

        appState.uploading = false;

        updateUploadInfo();

    }

}


/*
 * Saves one load's change (status / finishedAt / removed).
 * The screen updates right away; in shared mode Firebase
 * sends it to everyone.
 */
function saveLoadChange(item, changes) {

    Object.assign(item, changes);

    renderSchedule();
    renderCptRoutes();

    if (!item.removed) {
        updateDetails(item);
    }

    if (changes.status === "finished") {
        // Hide it once the 2 minutes are up
        setTimeout(renderSchedule, FINISH_HIDE_DELAY + 500);
    }

    // Simple mode: save on this device
    if (!USE_FIREBASE) {
        saveLocalSchedule();
        return;
    }

    if (!firebaseState.db) {
        return;
    }

    firebaseState.db
        .collection(LOADS_COLLECTION)
        .doc(item.id)
        .update(changes)
        .catch(error => {

            console.error(error);

            alert(
                error.code === "not-found"
                    ? "That load isn't in the schedule anymore. Someone may have uploaded a new CSV."
                    : "That change didn't save. Check your connection and try again."
            );

        });

}


/* =========================================================
   HELPERS
   ========================================================= */

function setText(element, value) {

    if (element) {
        element.textContent = value;
    }

}


function timeToMinutes(time) {

    const [hours, minutes] = time.split(":").map(Number);

    return hours * 60 + minutes;

}


function getStatusClass(status) {

    switch (status) {
        case "in-progress": return "status-progress";
        case "finished": return "status-finished";
        default: return "status-scheduled";
    }

}


function getStatusText(status) {

    switch (status) {
        case "in-progress": return "In Progress";
        case "finished": return "Finished";
        default: return "Scheduled";
    }

}


function escapeHTML(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

}


/* =========================================================
   START
   ========================================================= */

init();
