/* =========================================================
   RBD5 - OUTBOUND SCHEDULE (v3)
   Developed by Alcino

   v3: location, equipment, carrier (AZNG / 3P), trailer,
   copy VR ID, load alerts, Board view, and attaching
   a load to a door yourself.
   ========================================================= */

/*
 * FIREBASE SWITCH
 * false = simple mode: the schedule is saved on this device only.
 * true  = shared mode: everyone sees the same schedule live,
 *         with the team password screen.
 *         (Also un-comment the Firebase parts in ob-schedule.html)
 */
const USE_FIREBASE = false;


// Top bar (prototype login display)
const USER_LOGIN = "pparker";
const SITE_CODE = "RBD5";

// Related UIs
const CPT_VIEW_URL = "https://trans-logistics.amazon.com/ssp/dock/hrz/cpt";

// Alerts: warn this many minutes before a starred route's SDT
const ALERT_MINUTES = 20;

/*
 * ACCESS CODE
 * The site asks for a code when a tab is opened, and again after
 * IDLE_MINUTES with no activity. Only a scrambled version (hash)
 * of the code is stored here, never the code itself.
 *
 * To change the code: open the site, press F12 > Console, type
 *     makeCodeHash("your new code")
 * and paste the result between the quotes below.
 * (Default code: 1234)
 */
const ACCESS_CODE_HASH = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4";

const IDLE_MINUTES = 40;

// Wrong tries before a short wait
const MAX_CODE_TRIES = 5;
const CODE_WAIT_SECONDS = 30;


// Dock doors you can attach a load to (edit these if doors change)
// skip = door numbers that don't exist
const DOOR_GROUPS = [
    { name: "300 side", from: 310, to: 346, skip: [321] },
    { name: "100 side", from: 109, to: 120, skip: [] }
];


/*
 * SHIFT WINDOWS
 * The schedule only shows loads up to the end of your side's shifts.
 *   Day side  (MOR + DAY), from 03:30: loads until 16:00
 *   Night side (TWI + NIT), from 15:30: loads until 04:00 next morning
 * Anything later belongs to the next side's shifts.
 */
const SHIFT_WINDOWS = [
    { name: "MOR + DAY", start: "03:30", cutoff: "16:00" },
    { name: "TWI + NIT", start: "15:30", cutoff: "04:00" }
];


// true = loads whose SDT has passed (and aren't finished) are hidden.
// false = they stay on the schedule, just without a "Late" label.
const HIDE_PAST_SDT = false;


// Saved on this device. Stars and 12H/24H are shared with v1;
// the schedule itself is kept separate so the versions don't mix.
const MY_ROUTE_KEY = "outboundMyRoutes";
const TIME_FORMAT_KEY = "outboundTimeFormat";
const VIEW_KEY = "outboundV3ViewSettings";
const ALERTS_KEY = "outboundV3Alerts";
const ALERTED_KEY = "outboundV3Alerted";

// Schedule saved on this device (simple mode)
const LOCAL_SCHEDULE_KEY = "outboundV3ScheduleData";
const LOCAL_UPLOAD_KEY = "outboundV3UploadedAt";

// Firebase collections
const LOADS_COLLECTION = "loadsV3";
const META_COLLECTION = "metaV3";
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
    copyVrButton: $("copyVrButton"),
    detailLocation: $("detailLocation"),
    detailEquipment: $("detailEquipment"),
    detailCarrier: $("detailCarrier"),
    detailTrailer: $("detailTrailer"),
    detailTrailerRow: $("detailTrailerRow"),
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
   CODE LOCK
   sessionStorage is cleared when the tab closes, so a new tab
   always asks for the code. A refresh in the same tab doesn't.
   ========================================================= */

const CODE_UNLOCKED_KEY = "obv3Unlocked";
const CODE_ACTIVITY_KEY = "obv3LastActivity";
const CODE_LEFT_KEY = "obv3LeftAt";

const codeLock = {
    locked: true,
    tries: 0,
    waitUntil: 0,
    lastSaved: 0
};


function startCodeLock() {

    const unlocked = sessionStorage.getItem(CODE_UNLOCKED_KEY) === "1";

    const last = Number(sessionStorage.getItem(CODE_ACTIVITY_KEY)) || 0;

    // When the page was last closed or refreshed. A refresh comes back
    // within seconds; a tab reopened later (Ctrl+Shift+T, or the browser
    // restoring tabs) doesn't, so that asks for the code again.
    const leftAt = Number(sessionStorage.getItem(CODE_LEFT_KEY)) || 0;

    const reopened = leftAt && Date.now() - leftAt > 10000;

    if (unlocked && !reopened && Date.now() - last < IDLE_MINUTES * 60000) {
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

    $("codeLockButton")?.addEventListener("click", () => lockWithCode());

}


function noteActivity() {

    if (codeLock.locked) {
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

    if (codeLock.locked) {
        return;
    }

    const last = Number(sessionStorage.getItem(CODE_ACTIVITY_KEY)) || 0;

    if (Date.now() - last >= IDLE_MINUTES * 60000) {
        lockWithCode("Locked after " + IDLE_MINUTES + " minutes without activity.");
    }

}


function lockWithCode(message = "") {

    sessionStorage.removeItem(CODE_UNLOCKED_KEY);

    closeDetails();
    closeRoutesPanel();
    closeDoorPicker();

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

    on(elements.searchInput, "input", event => {
        appState.searchText = event.target.value.toLowerCase().trim();
        renderSchedule();
    });

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

    on(elements.copyVrButton, "click", copySelectedVrId);

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

    if (!file) {
        return;
    }

    Papa.parse(file, {

        header: true,

        skipEmptyLines: true,

        complete: results => {
            processCSV(results.data);
            input.value = ""; // lets you upload the same file again
        },

        error: error => {
            console.error(error);
            alert("There was a problem reading the CSV.");
            input.value = "";
        }

    });

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
        const trailer = cleanValue(getColumn(row, ["Trailer"]));

        if (!route || !sdt) {
            return;
        }

        const fullRoute = normalizeRoute(extractDestination(route));

        const matchedRoute = matchRoute(fullRoute);

        // Not one of our routes (shuttles, LEX2, UPS...) -> skip
        if (!matchedRoute) {
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
            nextCptAfter(normalizedSdt, getRouteCpts(matchedRoute));

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
            route: matchedRoute,
            fullRoute,
            sdt: normalizedSdt,
            cpt,
            vrId: vrId || "",
            location,
            equipment,
            carrierCode: carrier.code,
            carrierType: carrier.type,
            trailer,
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
   LOAD FIELDS (location, equipment, carrier)
   ========================================================= */

/* "-" and blanks mean "nothing" */
function cleanValue(value) {

    const text = String(value || "").trim();

    return text === "-" ? "" : text;

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
        !item.removed &&
        isInShiftWindow(item) &&
        !(HIDE_PAST_SDT && isLate(item)) &&
        (!appState.myRouteMode || appState.myRoutes.includes(item.route))
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

    elements.cptRoutes.innerHTML = routes
        .map(route => {
            const starred = appState.myRoutes.includes(route);
            return `<div class="cpt-route ${starred ? "starred" : ""}">
                        ${starred ? '<span class="row-star">★</span>' : ""}${escapeHTML(route)}
                    </div>`;
        })
        .join("");

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
        schedules = schedules.filter(item =>
            item.route.toLowerCase().includes(appState.searchText) ||
            (item.fullRoute || "").toLowerCase().includes(appState.searchText) ||
            getDoor(item).toLowerCase().includes(appState.searchText)
        );
    }

    if (appState.statusFilter === "finished") {

        // Picking "Finished" in the filter always shows them
        schedules = schedules.filter(item => item.status === "finished");

    } else {

        if (appState.statusFilter !== "all") {
            schedules = schedules.filter(item => item.status === appState.statusFilter);
        }

        if (!appState.showFinished) {
            schedules = schedules.filter(item => !isFinishedHidden(item));
        }

    }

    schedules.sort(bySdt);

    // Board view shows every load (no page size); list view pages
    const visible = appState.viewMode === "list"
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
            : appState.myRouteMode ? "My Route" : "Today's Schedule"
    );

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

}


function renderEmptyState() {

    let title = "No loads to show";
    let text = "Try a different search or status filter.";
    let icon = "⌕";

    if (!appState.schedules.length) {

        title = "No schedule loaded";
        text = "Upload your CSV schedule to begin.";
        icon = "↑";

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
            <td colspan="8">
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

            <td class="cell-action">
                <button type="button" class="row-action" title="Route details" aria-label="Details for ${escapeHTML(item.route)}">⋮</button>
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

    if (elements.copyVrButton) {
        elements.copyVrButton.classList.toggle("hidden", !item.vrId);
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

    setText(elements.detailTrailer, item.trailer || "--");
    elements.detailTrailerRow?.classList.toggle("hidden", !item.trailer);


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

        for (let number = group.from; number <= group.to; number++) {
            if (!(group.skip || []).includes(number)) {
                doors.push(`DD${number}`);
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
   COPY VR ID
   ========================================================= */

function copySelectedVrId() {

    const item = getSelectedSchedule();

    if (!item || !item.vrId) {
        return;
    }

    const done = () => {
        showToast(`Copied VR ID ${item.vrId}`);
        if (elements.copyVrButton) {
            elements.copyVrButton.textContent = "Copied";
            setTimeout(() => { elements.copyVrButton.textContent = "Copy"; }, 1500);
        }
    };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(item.vrId).then(done, () => fallbackCopy(item.vrId, done));
    } else {
        fallbackCopy(item.vrId, done);
    }

}


/* Older browsers / non-https pages */
function fallbackCopy(text, done) {

    const box = document.createElement("textarea");

    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";

    document.body.appendChild(box);
    box.select();

    try {
        document.execCommand("copy");
        done();
    } catch (error) {
        alert(`Couldn't copy. VR ID: ${text}`);
    }

    box.remove();

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
    if (codeLock.locked) {
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


function startFirebase() {

    if (!isFirebaseConfigured()) {
        showLockScreen(
            "Firebase isn't set up yet. Fill in firebase-config.js (see SETUP.md)."
        );
        return;
    }

    firebase.initializeApp(FIREBASE_CONFIG);

    firebaseState.auth = firebase.auth();

    firebaseState.db = firebase.firestore();

    // Keeps a copy on the device so the schedule opens fast
    // and still shows if the signal drops for a moment
    firebaseState.db
        .enablePersistence({ synchronizeTabs: true })
        .catch(() => { /* not supported in this browser - that's fine */ });

    // Lets password managers (iPhone Keychain, Samsung Pass) save the password
    if (elements.lockUsername) {
        elements.lockUsername.value = TEAM_EMAIL;
    }

    // Firebase remembers the sign-in on this device.
    // This runs on page load and whenever someone unlocks or locks.
    firebaseState.auth.onAuthStateChanged(user => {

        if (user) {
            onUnlocked();
        } else {
            onLocked();
        }

    });

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

    if (elements.lockSubmit) {
        elements.lockSubmit.disabled = true;
        elements.lockSubmit.textContent = "Checking...";
    }

    firebaseState.auth
        .signInWithEmailAndPassword(TEAM_EMAIL, password)
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

    stopListening();

    // Nothing stays on screen once it's locked
    appState.schedules = [];
    appState.uploadedAt = null;

    closeDetails();
    closeRoutesPanel();

    renderSchedule();
    renderCptRoutes();
    updateUploadInfo();

    showLockScreen("");

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
