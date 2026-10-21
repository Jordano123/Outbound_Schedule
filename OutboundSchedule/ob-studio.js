/* =========================================================
   RBD5 - OUTBOUND SCHEDULE (v4) — STUDIO
   Manager view: every load in the CSV (SDT through 05:30),
   the 21:00 and 03:00 CPTs, what needs attention, what's
   leaving next, and notifications.

   How to open it:
     type  studio  in the search box and press Enter,
     then the Studio code. (Or open the site with #studio
     at the end of the address.)

   Studio only opens on the browser where the code was typed.
   It locks again when the tab closes, when the site locks,
   or with "Lock Studio".

   When the manager is back:
     - set STUDIO_CODE = ""      -> Studio shows for everyone, no code
     - set STUDIO_ENABLED = false -> Studio is gone
       (or delete the ob-studio.js line in ob-schedule.html)

   Needs ob-app.js (loaded first).
   ========================================================= */

(function () {

"use strict";


/* =========================================================
   SETTINGS
   ========================================================= */

const STUDIO_ENABLED = true;

// The code that opens Studio. "" = no code needed.
const STUDIO_CODE = "12345";

// Studio shows every load with an SDT up to this time (next morning)
const STUDIO_CUTOFF = "05:30";

// The CPTs Studio follows (cards at the top and routes on the left)
const STUDIO_CPTS = ["21:00", "03:00"];

// 100 side routes. Everything else is 300 side.
const SIDE_100_PREFIXES = ["DD"];                  // DDF1, DDF5, DDA9, DDF4 ...
const SIDE_100_ROUTES = ["AFW5-CART-SC", "DAU7"];

// When a load needs attention
const SOON_MINUTES = 20;        // "Leaving in 20 min" notification
const NO_DOOR_MINUTES = 90;     // no dock door this close to SDT
const LOW_FILL_MINUTES = 60;    // fill checked this close to SDT
const LOW_FILL_PERCENT = 70;    // projected fill below this = low

// Loads whose SDT was more than this long ago are old leftovers: hidden
const STALE_HOURS = 24;

// "On time tonight" card
// On time = left (ADT from the CSV) no later than SDT + grace.
// A load still here after its SDT (in the last CSV) counts as late.
const ONTIME_START = "15:30";          // tonight = SDT from 15:30 to STUDIO_CUTOFF (05:30)
const ONTIME_GRACE_MINUTES = 0;
const ONTIME_GOAL = 95;                // % - green at or above, red 10+ below
const ONTIME_OUR_ROUTES_ONLY = true;   // false = count the other loads in the CSV too

// "Leaving next hour" card
const NEXT_MINUTES = 60;
const NEXT_MAX_ROWS = 7;

// How many notifications show before "Show all"
const NOTES_SHOWN = 5;
const NOTES_KEPT = 60;

// Saved on this browser only
const OPEN_KEY = "obv4StudioOpen";      // sessionStorage: code entered in this tab
const SOUND_KEY = "obv4StudioSound";    // localStorage: sound on/off
const NOTES_KEY = "obv4StudioNotes";    // sessionStorage: notification list
const SEEN_KEY = "obv4StudioSeen";      // sessionStorage: what was already notified


if (!STUDIO_ENABLED) {
    return;
}


/* =========================================================
   STATE
   ========================================================= */

const studio = {

    open: STUDIO_CODE === "" || sessionStorage.getItem(OPEN_KEY) === "1",

    active: false,

    side: "all",          // "all" | "300" | "100"
    chip: null,           // null | "attention" | "late" | "in-progress" | "scheduled" | "3p"
    routes: [],           // routes picked on the left (several at once)
    search: "",
    showFinished: false,

    sound: localStorage.getItem(SOUND_KEY) === "on",

    notes: readSession(NOTES_KEY, []),
    seen: new Set(readSession(SEEN_KEY, [])),
    showAllNotes: false,
    firstCheck: true,

    baseline: null,       // loads before the last change (for "New CSV")
    baselineUpload: null,
    diffTimer: null,

    hashAsked: false,

    titles: null

};


function readSession(key, fallback) {
    try {
        const value = JSON.parse(sessionStorage.getItem(key));
        return value ?? fallback;
    } catch (error) {
        return fallback;
    }
}

function writeSession(key, value) {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        // Full or blocked: Studio still works, it just forgets on reload
    }
}


/* =========================================================
   PAGE PARTS (built here so removing this file removes Studio)
   ========================================================= */

const ui = {};

function buildStudio() {

    // Styles
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "ob-studio.css";
    document.head.appendChild(css);

    // Sidebar: Studio button under Routes
    const nav = document.querySelector(".navigation");

    ui.nav = document.createElement("button");
    ui.nav.type = "button";
    ui.nav.id = "studioNav";
    ui.nav.className = "nav-item studio-nav";
    ui.nav.innerHTML = '<span aria-hidden="true">◆</span> Studio';
    nav?.appendChild(ui.nav);

    // Sidebar: CPT routes for Studio (replaces "Current CPT Routes")
    ui.routesBox = document.createElement("section");
    ui.routesBox.className = "studio-routes-box";
    ui.routesBox.innerHTML = `
        <div class="section-label">CPT ROUTES</div>
        <div id="studioRoutes"></div>
        <button type="button" class="studio-lock" id="studioLock">🔒 Lock Studio</button>
    `;
    document.querySelector(".sidebar")?.appendChild(ui.routesBox);
    ui.routes = ui.routesBox.querySelector("#studioRoutes");
    ui.lockButton = ui.routesBox.querySelector("#studioLock");

    // Main area
    ui.view = document.createElement("section");
    ui.view.id = "studioView";
    ui.view.className = "studio";
    ui.view.innerHTML = `

        <section class="st-kpis" id="stKpis"></section>

        <section class="st-cpts" id="stCpts"></section>

        <section class="st-top">

            <div class="st-card st-next">
                <div class="st-card-head">
                    <h2>Leaving next hour</h2>
                    <span id="stNextRange"></span>
                </div>
                <div id="stNextBody"></div>
                <div class="st-next-foot" id="stNextFoot"></div>
            </div>

            <div class="st-card st-notes">
                <div class="st-card-head">
                    <h2>Notifications</h2>
                    <button type="button" id="stSound" class="st-sound"></button>
                </div>
                <ul id="stNotes"></ul>
                <div class="st-notes-foot">
                    <button type="button" id="stMoreNotes" class="st-link"></button>
                    <button type="button" id="stClearNotes" class="st-link st-muted">Clear</button>
                </div>
            </div>

        </section>

        <section class="st-card st-table-card">

            <div class="st-tools">

                <div class="st-search">
                    <span aria-hidden="true">⌕</span>
                    <input id="stSearch" type="search" placeholder="Route, door, VR ID or time (commas for more)" aria-label="Search Studio">
                </div>

                <div class="st-seg" role="group" aria-label="Side">
                    <button type="button" data-side="all">All</button>
                    <button type="button" data-side="300">300 side</button>
                    <button type="button" data-side="100">100 side</button>
                </div>

                <div class="st-chips" role="group" aria-label="Filter">
                    <button type="button" data-chip="attention" class="st-chip st-chip-warn">⚠ Attention <b id="stAttnCount">0</b></button>
                    <button type="button" data-chip="in-progress" class="st-chip">Loading</button>
                    <button type="button" data-chip="scheduled" class="st-chip">Not started</button>
                    <button type="button" data-chip="3p" class="st-chip">3P</button>
                    <button type="button" id="stFinished" class="st-chip st-chip-ghost"></button>
                </div>

            </div>

            <div class="st-filter-line hidden" id="stFilterLine"></div>

            <div class="st-table-title">
                <h2>All loads</h2>
                <span id="stTableCount"></span>
            </div>

            <div class="st-table-wrap">
                <table class="st-table">
                    <thead>
                        <tr>
                            <th>SDT</th>
                            <th>Route</th>
                            <th>CPT</th>
                            <th>Side</th>
                            <th>Door</th>
                            <th>Status</th>
                            <th>Fill</th>
                            <th class="st-col-pc">P / C</th>
                            <th class="st-col-carrier">Carrier</th>
                            <th class="st-col-equip">Equipment</th>
                            <th class="st-col-vr">VR ID</th>
                            <th class="st-right">Until</th>
                        </tr>
                    </thead>
                    <tbody id="stBody"></tbody>
                </table>
            </div>

        </section>
    `;

    const scheduleCard = document.querySelector(".schedule-card");
    scheduleCard?.parentNode.insertBefore(ui.view, scheduleCard);

    ui.kpis = ui.view.querySelector("#stKpis");
    ui.cpts = ui.view.querySelector("#stCpts");
    ui.finished = ui.view.querySelector("#stFinished");
    ui.tableCount = ui.view.querySelector("#stTableCount");
    ui.nextRange = ui.view.querySelector("#stNextRange");
    ui.nextBody = ui.view.querySelector("#stNextBody");
    ui.nextFoot = ui.view.querySelector("#stNextFoot");
    ui.sound = ui.view.querySelector("#stSound");
    ui.notes = ui.view.querySelector("#stNotes");
    ui.moreNotes = ui.view.querySelector("#stMoreNotes");
    ui.clearNotes = ui.view.querySelector("#stClearNotes");
    ui.search = ui.view.querySelector("#stSearch");
    ui.seg = ui.view.querySelector(".st-seg");
    ui.chips = ui.view.querySelector(".st-chips");
    ui.attnCount = ui.view.querySelector("#stAttnCount");
    ui.filterLine = ui.view.querySelector("#stFilterLine");
    ui.body = ui.view.querySelector("#stBody");

    // Code box
    ui.codeOverlay = document.createElement("div");
    ui.codeOverlay.className = "st-code-overlay hidden";
    ui.codeOverlay.innerHTML = `
        <form class="st-code-box" id="stCodeForm" autocomplete="off">
            <div class="st-code-icon">◆</div>
            <h2>Studio</h2>
            <p>Enter the Studio code</p>
            <input id="stCodeInput" type="password" inputmode="numeric" aria-label="Studio code">
            <small id="stCodeError" class="st-code-error"></small>
            <div class="st-code-actions">
                <button type="button" id="stCodeCancel" class="st-btn-light">Cancel</button>
                <button type="submit" class="st-btn-dark">Open Studio</button>
            </div>
        </form>
    `;
    document.body.appendChild(ui.codeOverlay);
    ui.codeForm = ui.codeOverlay.querySelector("#stCodeForm");
    ui.codeInput = ui.codeOverlay.querySelector("#stCodeInput");
    ui.codeError = ui.codeOverlay.querySelector("#stCodeError");
    ui.codeCancel = ui.codeOverlay.querySelector("#stCodeCancel");

}


/* =========================================================
   EVENTS
   ========================================================= */

function setupStudioEvents() {

    ui.nav.addEventListener("click", enterStudio);

    // Leaving Studio: the Schedule button
    elements.scheduleNav?.addEventListener("click", leaveStudio);

    ui.lockButton.addEventListener("click", () => lockStudio(true));

    // Secret door: type "studio" in the schedule search and press Enter
    elements.searchInput?.addEventListener("keydown", event => {

        if (event.key !== "Enter") {
            return;
        }

        if (event.target.value.trim().toLowerCase() !== "studio") {
            return;
        }

        event.preventDefault();

        event.target.value = "";
        appState.searchText = "";
        renderSchedule();

        if (studio.open) {
            enterStudio();
        } else {
            askCode();
        }

    });

    // Code box
    ui.codeForm.addEventListener("submit", event => {
        event.preventDefault();
        submitCode();
    });

    ui.codeCancel.addEventListener("click", closeCode);

    ui.codeOverlay.addEventListener("click", event => {
        if (event.target === ui.codeOverlay) {
            closeCode();
        }
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !ui.codeOverlay.classList.contains("hidden")) {
            closeCode();
        }
    });

    // Left side routes
    ui.routes.addEventListener("click", event => {
        const button = event.target.closest("[data-route]");
        if (button) {
            toggleRoute(button.dataset.route);
        }
    });

    // Filters
    ui.search.addEventListener("input", event => {
        studio.search = event.target.value.toLowerCase().trim();
        renderTable();
    });

    ui.seg.addEventListener("click", event => {
        const button = event.target.closest("[data-side]");
        if (button) {
            studio.side = button.dataset.side;
            renderStudio();
        }
    });

    ui.chips.addEventListener("click", event => {
        const button = event.target.closest("[data-chip]");
        if (button) {
            setChip(button.dataset.chip);
        }
    });

    ui.finished.addEventListener("click", () => {
        studio.showFinished = !studio.showFinished;
        renderToolbar();
        renderTable();
    });

    ui.kpis.addEventListener("click", event => {

        const card = event.target.closest("[data-kpi]");

        if (!card) {
            return;
        }

        const kpi = card.dataset.kpi;

        if (kpi === "300" || kpi === "100") {
            studio.side = studio.side === kpi ? "all" : kpi;
            renderStudio();
        } else if (kpi === "all") {
            clearFilters();
        } else {
            setChip(kpi);
        }

    });

    // Picked-route tags: ✕ removes one, "Clear all" removes them all
    ui.filterLine.addEventListener("click", event => {
        const tag = event.target.closest("[data-route]");
        if (tag) {
            toggleRoute(tag.dataset.route);
        } else if (event.target.closest("[data-clear]")) {
            studio.routes = [];
            if (studio.chip === "late") studio.chip = null;
            renderStudio();
        }
    });

    // Table rows open the details panel
    ui.body.addEventListener("click", event => {

        const row = event.target.closest("[data-id]");

        if (row) {
            openDetails(row.dataset.id);
            renderTable();
        }

    });

    ui.cpts.addEventListener("click", event => {
        const row = event.target.closest("[data-id]");
        if (row && appState.schedules.some(item => item.id === row.dataset.id)) {
            openDetails(row.dataset.id);
            renderTable();
        }
    });

    ui.nextBody.addEventListener("click", event => {
        const row = event.target.closest("[data-id]");
        if (row) {
            openDetails(row.dataset.id);
            renderTable();
        }
    });

    ui.notes.addEventListener("click", event => {
        const note = event.target.closest("[data-id]");
        if (note && appState.schedules.some(item => item.id === note.dataset.id)) {
            openDetails(note.dataset.id);
            renderTable();
        }
    });

    ui.moreNotes.addEventListener("click", () => {
        studio.showAllNotes = !studio.showAllNotes;
        renderNotes();
    });

    ui.clearNotes.addEventListener("click", () => {
        studio.notes = [];
        writeSession(NOTES_KEY, studio.notes);
        renderNotes();
    });

    ui.sound.addEventListener("click", () => {
        studio.sound = !studio.sound;
        localStorage.setItem(SOUND_KEY, studio.sound ? "on" : "off");
        if (studio.sound) {
            beep();
        }
        renderNotes();
    });

    // Closing the details panel clears the row highlight
    elements.closeDetails?.addEventListener("click", () => setTimeout(renderTable));
    elements.detailsBackdrop?.addEventListener("click", () => setTimeout(renderTable));

}


function toggleRoute(route) {
    studio.routes = studio.routes.includes(route)
        ? studio.routes.filter(item => item !== route)
        : [...studio.routes, route];
    renderStudio();
}


function setChip(chip) {
    studio.chip = studio.chip === chip ? null : chip;
    renderStudio();
}


function clearFilters() {
    studio.side = "all";
    studio.chip = null;
    studio.routes = [];
    studio.search = "";
    ui.search.value = "";
    renderStudio();
}


/* =========================================================
   CODE / OPEN / LOCK
   ========================================================= */

function askCode() {

    if (isLockedNow()) {
        return;
    }

    ui.codeError.textContent = "";
    ui.codeInput.value = "";
    ui.codeOverlay.classList.remove("hidden");

    setTimeout(() => ui.codeInput.focus(), 30);

}


function closeCode() {
    ui.codeOverlay.classList.add("hidden");
}


function submitCode() {

    if (ui.codeInput.value.trim() !== STUDIO_CODE) {
        ui.codeError.textContent = "Wrong code";
        ui.codeInput.select();
        return;
    }

    studio.open = true;
    sessionStorage.setItem(OPEN_KEY, "1");

    closeCode();

    enterStudio();

}


function enterStudio() {

    if (!studio.open || isLockedNow()) {
        return;
    }

    studio.active = true;

    document.body.classList.add("studio-mode");

    elements.scheduleNav?.classList.remove("active");
    ui.nav.classList.add("active");

    // Header says Studio
    const title = document.querySelector(".header-title h1");
    const sub = document.querySelector(".header-title p");

    if (!studio.titles) {
        studio.titles = { title: title?.textContent, sub: sub?.textContent };
    }

    setText(title, "RBD5 - Studio");
    setText(sub, `Every load in the CSV · SDT through ${formatTime(STUDIO_CUTOFF)}`);

    renderStudio();

    window.scrollTo(0, 0);

}


function leaveStudio() {

    if (!studio.active) {
        return;
    }

    studio.active = false;

    document.body.classList.remove("studio-mode");

    ui.nav.classList.remove("active");
    elements.scheduleNav?.classList.add("active");

    if (studio.titles) {
        setText(document.querySelector(".header-title h1"), studio.titles.title);
        setText(document.querySelector(".header-title p"), studio.titles.sub);
    }

}


/* byUser = the "Lock Studio" button (shows a message) */
function lockStudio(byUser = false) {

    leaveStudio();

    if (STUDIO_CODE === "") {
        return;
    }

    studio.open = false;

    sessionStorage.removeItem(OPEN_KEY);

    updateNav();

    if (byUser) {
        showToast("Studio locked");
    }

}


function updateNav() {
    ui.nav.classList.toggle("hidden", !studio.open);
}


/* =========================================================
   LOAD HELPERS
   ========================================================= */

/* The next STUDIO_CUTOFF (05:30) from now, as a Date */
function studioCutoff() {

    const now = new Date();
    const [hour, minute] = STUDIO_CUTOFF.split(":").map(Number);

    const cutoff = new Date(now);
    cutoff.setHours(hour, minute, 0, 0);

    if (cutoff <= now) {
        cutoff.setDate(cutoff.getDate() + 1);
    }

    return cutoff;

}


/* "2026-10-12 21:00" style text for a Date */
function dateKey(date) {
    const two = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
        `${two(date.getHours())}:${two(date.getMinutes())}`;
}


/*
 * Tonight's 21:00 and 03:00 CPTs: the last of each time
 * before the cutoff. [{ time: "21:00", key: "2026-10-12 21:00" }, ...]
 */
function studioCpts() {

    const cutoff = studioCutoff();

    return STUDIO_CPTS
        .map(time => {
            const [hour, minute] = time.split(":").map(Number);
            const date = new Date(cutoff);
            date.setHours(hour, minute, 0, 0);
            if (date > cutoff) {
                date.setDate(date.getDate() - 1);
            }
            return { time, key: dateKey(date) };
        })
        .sort((a, b) => a.key.localeCompare(b.key));

}


/* Every load Studio shows: SDT up to the cutoff, not removed, not old leftovers */
function studioLoads() {

    const oldest = Date.now() - STALE_HOURS * 3600000;
    const cutoff = studioCutoff().getTime();

    // After the cutoff: per route, In Progress loads + the next 3 (like the schedule)
    const later = new Map();

    appState.schedules.forEach(item => {
        const departure = getDepartureTime(item);
        if (item.removed || item.status === "finished" || departure === null || departure <= cutoff) return;
        if (!later.has(item.route)) later.set(item.route, []);
        later.get(item.route).push(item);
    });

    const nextSort = new Set();

    later.forEach(loads => {
        loads.sort(bySdt).forEach((item, index) => {
            if (index < 3 || item.status === "in-progress") nextSort.add(item.id);
        });
    });

    return appState.schedules
        .filter(item => {
            if (item.removed) return false;
            const departure = getDepartureTime(item);
            if (departure === null) return true;
            if (departure < oldest) return false;
            return departure <= cutoff || nextSort.has(item.id);
        })
        .sort(bySdt);

}


function sideOf(item) {

    const route = String(item.route || "").toUpperCase();

    if (SIDE_100_ROUTES.includes(route) ||
        SIDE_100_PREFIXES.some(prefix => route.startsWith(prefix))) {
        return "100";
    }

    return "300";

}


function doorOf(item) {
    return String(getDoor(item) || "").toUpperCase();
}

function hasDockDoor(item) {
    return doorOf(item).startsWith("DD");
}

function inYard(item) {
    return doorOf(item).startsWith("PS");
}

function fillOf(item) {
    const value = item.progress?.projected;
    return value === null || value === undefined ? null : Number(value);
}

function isOpen(item) {
    return item.status !== "finished";
}

function isPaused(item) {
    return getLoadStage(item) === "paused";
}

/* Minutes until SDT (negative = passed), or null */
function minutesTo(item) {
    const departure = getDepartureTime(item);
    return departure === null ? null : (departure - Date.now()) / 60000;
}

function cptMinutes(cpt) {
    const time = new Date(String(cpt).replace(" ", "T")).getTime();
    return isNaN(time) ? null : (time - Date.now()) / 60000;
}


/* Why this load needs attention (or null) */
function flagOf(item) {

    if (!isOpen(item)) {
        return null;
    }

    const minutes = minutesTo(item);

    if (minutes === null) {
        return null;
    }

    if (minutes < 0) {
        return { key: "sdt", label: "SDT passed" };
    }

    if (isPaused(item)) {
        return { key: "paused", label: "Paused" };
    }

    if (minutes <= NO_DOOR_MINUTES && !hasDockDoor(item)) {
        return { key: "nodoor", label: "No door" };
    }

    const fill = fillOf(item);

    if (minutes <= LOW_FILL_MINUTES && fill !== null && fill < LOW_FILL_PERCENT) {
        return { key: "low", label: "Low fill" };
    }

    return null;

}


function timeOf(value) {
    return formatTime(getTime(value));
}

function fillText(item) {
    const fill = fillOf(item);
    return fill === null ? "" : `${fill === 0.5 ? "<1" : Math.round(fill)}%`;
}

function minutesText(minutes) {
    return Math.abs(minutes) < 1 ? "<1m" : formatDuration(Math.abs(minutes) * 60000);
}

function routeTime(item) {
    return `${item.route} ${timeOf(item.sdt)}`;
}

/* Real trailer status (see getLoadStage in ob-app.js) */
const STAGE_LABELS = {
    "scheduled":   ["Scheduled", "st-st-sch"],
    "attached":    ["Trailer Attached", "st-st-att"],
    "ready":       ["Ready For Loading", "st-st-ready"],
    "in-progress": ["Loading", "st-st-prog"],
    "paused":      ["Paused", "st-st-paused"],
    "finished":    ["Finished", "st-st-fin"]
};

function statusLabel(item) {
    return STAGE_LABELS[getLoadStage(item)][0];
}

function statusClass(item) {
    return STAGE_LABELS[getLoadStage(item)][1];
}


/* CPT groups: [{ key, cpt, loads }] in time order */
function groupByCpt(loads) {

    const groups = new Map();

    loads.forEach(item => {
        const key = item.cpt || item.sdt;
        if (!groups.has(key)) {
            groups.set(key, { key, cpt: key, loads: [] });
        }
        groups.get(key).loads.push(item);
    });

    return [...groups.values()].sort((a, b) => String(a.cpt).localeCompare(String(b.cpt)));

}


/* Is this one of Studio's CPTs (21:00 / 03:00)? */
function isStudioCpt(item) {
    return STUDIO_CPTS.includes(getTime(item.cpt));
}


/* Filters from the toolbar (not the routes on the left) */
function passesFilters(item) {

    if (studio.side !== "all" && sideOf(item) !== studio.side) {
        return false;
    }

    switch (studio.chip) {
        case "attention": return Boolean(flagOf(item));
        case "late": return flagOf(item)?.key === "sdt";
        case "in-progress": return item.status === "in-progress";
        case "scheduled": return item.status === "scheduled";
        case "3p": return item.carrierType === "3P";
        default: return true;
    }

}


/* =========================================================
   RENDER
   ========================================================= */

function renderStudio() {

    updateNav();

    // Opened with #studio in the address: open (or ask for the code) once
    if (!studio.hashAsked && location.hash.toLowerCase() === "#studio" && !isLockedNow()) {
        studio.hashAsked = true;
        if (studio.open) {
            enterStudio();
            return;
        }
        askCode();
    }

    if (!studio.open) {
        return;
    }

    if (isLockedNow()) {
        return;
    }

    checkNotes();

    if (!studio.active) {
        return;
    }

    renderKpis();
    renderCpts();
    renderNext();
    renderNotes();
    renderSideRoutes();
    renderToolbar();
    renderTable();

}


function renderKpis() {

    const loads = studioLoads();
    const open = loads.filter(isOpen);

    const count = test => loads.filter(test).length;

    const cards = [
        { kpi: "all", value: loads.length, label: "Loads" },
        { kpi: "scheduled", value: count(item => item.status === "scheduled"), label: "Not started", dot: "sch" },
        { kpi: "in-progress", value: count(item => item.status === "in-progress"), label: "Loading", dot: "prog" },
        { kpi: null, value: count(item => item.status === "finished"), label: "Finished", dot: "fin" },
        { kpi: "late", value: count(item => flagOf(item)?.key === "sdt"), label: "SDT passed", tone: "red" },
        { kpi: "attention", value: count(item => Boolean(flagOf(item))), label: "Need attention", tone: "amber" },
        { kpi: "300", value: open.filter(item => sideOf(item) === "300").length, label: "300 side open" },
        { kpi: "100", value: open.filter(item => sideOf(item) === "100").length, label: "100 side open" },
        { kpi: null, value: open.filter(inYard).length, label: "In the yard" }
    ];

    const isOn = kpi =>
        (kpi === "300" || kpi === "100") ? studio.side === kpi : studio.chip === kpi;

    ui.kpis.innerHTML = cards.map(card => `
        <${card.kpi ? `button type="button" data-kpi="${card.kpi}"` : "div"}
            class="st-kpi ${card.tone ? `st-kpi-${card.tone}` : ""} ${card.kpi && isOn(card.kpi) ? "on" : ""}">
            <b>${card.value}</b>
            <small>${card.dot ? `<i class="st-dot st-${card.dot}"></i>` : ""}${card.label}</small>
        </${card.kpi ? "button" : "div"}>
    `).join("");

}


/* =========================================================
   ON TIME TONIGHT
   ========================================================= */

/* Tonight's window: SDT from ONTIME_START to STUDIO_CUTOFF.
   Between 05:30 and 15:30 it's last night's (final) result. */
function onTimeWindow() {

    const now = new Date();

    const [startHour, startMinute] = ONTIME_START.split(":").map(Number);
    const [endHour, endMinute] = STUDIO_CUTOFF.split(":").map(Number);

    const start = new Date(now);
    start.setHours(startHour, startMinute, 0, 0);

    if (start > now) {
        start.setDate(start.getDate() - 1);
    }

    const end = new Date(start);
    end.setHours(endHour, endMinute, 0, 0);

    if (end <= start) {
        end.setDate(end.getDate() + 1);
    }

    return { start: start.getTime(), end: end.getTime(), over: now > end };

}


function toMs(dateTime) {
    const time = new Date(String(dateTime || "").replace(" ", "T")).getTime();
    return isNaN(time) ? null : time;
}


function onTimeStats() {

    const range = onTimeWindow();
    const grace = ONTIME_GRACE_MINUTES * 60000;

    const counts = item => !ONTIME_OUR_ROUTES_ONLY || item.tracked !== false;

    const inWindow = sdt => sdt !== null && sdt >= range.start && sdt <= range.end;

    // Left already (from the CSV's ADT)
    const departed = (appState.departures || [])
        .filter(record => counts(record) && inWindow(toMs(record.sdt)))
        .map(record => {
            const sdt = toMs(record.sdt);
            const adt = toMs(record.adt);
            return { ...record, late: adt !== null && adt > sdt + grace ? adt - sdt : 0 };
        });

    const left = new Set(departed.map(record => record.id));

    // Still here after SDT, as of the last CSV (and now) = late
    const checkedAt = Math.min(Date.now(), appState.uploadedAt || Date.now());

    const stillHere = appState.schedules
        .filter(item => {
            const sdt = getDepartureTime(item);
            return !item.removed && counts(item) && !left.has(item.id) &&
                inWindow(sdt) && sdt + grace < checkedAt;
        })
        .map(item => ({ route: item.route, sdt: item.sdt, id: item.id, late: Date.now() - getDepartureTime(item), here: true }));

    const total = departed.length + stillHere.length;
    const good = departed.filter(record => !record.late).length;

    const late = [...departed.filter(record => record.late), ...stillHere]
        .sort((a, b) => b.late - a.late);

    return {
        total,
        good,
        percent: total ? Math.round((good / total) * 100) : null,
        late,
        over: range.over
    };

}


function renderOnTime() {

    const stats = onTimeStats();

    const title = stats.over ? "On time last night" : "On time tonight";

    if (!stats.total) {
        return `
            <div class="st-card st-ontime">
                <div class="st-ontime-top">
                    <span>${title}</span>
                </div>
                <div class="st-ontime-empty">No departures yet</div>
                <div class="st-ontime-note">Counts loads with SDT ${formatTime(ONTIME_START)} – ${formatTime(STUDIO_CUTOFF)}</div>
            </div>
        `;
    }

    const tone = stats.percent >= ONTIME_GOAL ? "good"
        : stats.percent >= ONTIME_GOAL - 10 ? "warn" : "bad";

    const lateList = stats.late.slice(0, 3).map(record => `
        <span ${record.here ? `data-id="${escapeHTML(record.id)}"` : ""} class="${record.here ? "here" : ""}">
            <b>${escapeHTML(record.route)}</b> ${timeOf(record.sdt)}
            <em>${record.here ? "still here" : `+${minutesText(record.late / 60000)}`}</em>
        </span>`).join("");

    return `
        <div class="st-card st-ontime st-ontime-${tone}">
            <div class="st-ontime-top">
                <span>${title}</span>
                <b>${stats.percent}%</b>
            </div>
            <div class="st-ontime-line"><b>${stats.good} of ${stats.total}</b> left on time</div>
            <div class="st-ontime-bar"><i style="width:${stats.percent}%"></i></div>
            <div class="st-ontime-late">
                ${stats.late.length
                    ? `${lateList}${stats.late.length > 3 ? `<span class="st-ontime-more">+${stats.late.length - 3} more late</span>` : ""}`
                    : `<span class="st-ontime-none">No late departures</span>`}
            </div>
        </div>
    `;

}


/* The 21:00 and 03:00 cards (and On time tonight) */
function renderCpts() {

    const loads = studioLoads();

    ui.cpts.innerHTML = renderOnTime() + studioCpts().map(cpt => {

        const all = loads.filter(item => item.cpt === cpt.key);
        const done = all.filter(item => !isOpen(item)).length;
        const loading = all.filter(item => item.status === "in-progress").length;
        const notStarted = all.length - done - loading;
        const late = all.filter(item => flagOf(item)?.key === "sdt").length;

        const minutes = cptMinutes(cpt.key);
        const passed = minutes !== null && minutes < 0;

        return `
            <div class="st-card st-cpt">
                <div class="st-cpt-top">
                    <span>CPT</span>
                    <b>${formatTime(cpt.time)}</b>
                    <em class="${passed && done < all.length ? "st-red" : ""}">
                        ${minutes === null ? "" : passed ? "passed" : `in ${minutesText(minutes)}`}
                    </em>
                </div>
                <div class="st-cpt-bar">
                    <i class="st-fin" style="flex:${done}"></i>
                    <i class="st-prog" style="flex:${loading}"></i>
                    <i class="st-sch" style="flex:${notStarted}"></i>
                </div>
                <div class="st-cpt-legend">
                    <span><b>${all.length}</b> loads</span>
                    <span><i class="st-dot st-fin"></i>${done} done</span>
                    <span><i class="st-dot st-prog"></i>${loading} loading</span>
                    <span><i class="st-dot st-sch"></i>${notStarted} not started</span>
                    ${late ? `<span class="st-cpt-late">${late} late</span>` : ""}
                </div>
            </div>
        `;

    }).join("");

}


function renderNext() {

    const loads = studioLoads().filter(isOpen);

    const now = new Date();
    const end = new Date(now.getTime() + NEXT_MINUTES * 60000);
    const hhmm = date => formatTime(
        `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    );

    setText(ui.nextRange, `SDT ${hhmm(now)} → ${hhmm(end)}`);

    const next = loads
        .filter(item => {
            const minutes = minutesTo(item);
            return minutes !== null && minutes >= 0 && minutes <= NEXT_MINUTES;
        })
        .sort(bySdt);

    if (!next.length) {
        ui.nextBody.innerHTML = `<div class="st-empty-small">Nothing leaving in the next hour</div>`;
    } else {
        ui.nextBody.innerHTML = `
            <table class="st-mini">
                ${next.slice(0, NEXT_MAX_ROWS).map(item => {
                    const flag = flagOf(item);
                    const fill = fillOf(item);
                    return `
                        <tr data-id="${escapeHTML(item.id)}" class="${flag ? "bad" : ""}">
                            <td class="st-t">${timeOf(item.sdt)}</td>
                            <td><b>${escapeHTML(item.route)}</b></td>
                            <td class="st-mini-cpt">CPT ${timeOf(item.cpt)}</td>
                            <td>${doorChip(item, "no door")}</td>
                            <td class="st-mini-bar">${fill === null ? "" : fillBar(fill)}</td>
                            <td class="st-mini-pc">${fillText(item)}</td>
                            <td class="st-mini-in">in ${minutesText(minutesTo(item))}</td>
                        </tr>
                    `;
                }).join("")}
            </table>
            ${next.length > NEXT_MAX_ROWS ? `<div class="st-more-small">+${next.length - NEXT_MAX_ROWS} more in the table</div>` : ""}
        `;
    }

    const twoHours = loads.filter(item => {
        const minutes = minutesTo(item);
        return minutes !== null && minutes >= 0 && minutes <= 120;
    });

    const late = loads.filter(item => flagOf(item)?.key === "sdt");

    ui.nextFoot.innerHTML = `
        <div><b>${twoHours.length}</b><span>leaving in 2 hours</span></div>
        <div><b>${twoHours.filter(item => !hasDockDoor(item)).length}</b><span>of those have no door</span></div>
        <div class="${late.length ? "st-red" : ""}"><b>${late.length}</b><span>past SDT, not finished</span></div>
    `;

}


function renderSideRoutes() {

    const loads = studioLoads();

    if (!appState.schedules.length) {
        ui.routes.innerHTML = `<div class="no-data">No schedule loaded</div>`;
        return;
    }

    ui.routes.innerHTML = studioCpts().map(cpt => {

        const minutes = cptMinutes(cpt.key);

        const byRoute = new Map();

        loads.filter(item => item.cpt === cpt.key).forEach(item => {
            if (!byRoute.has(item.route)) byRoute.set(item.route, []);
            byRoute.get(item.route).push(item);
        });

        const routes = [...byRoute.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        return `
            <div class="st-cpt-head">
                <b>${formatTime(cpt.time)}</b>
                <span>${minutes === null ? "" : minutes < 0 ? "passed" : `in ${minutesText(minutes)}`}</span>
            </div>
            ${routes.length ? routes.map(([route, items]) => {
                const left = items.filter(isOpen).length;
                const bad = items.some(flagOf);
                const active = studio.routes.includes(route);
                return `
                    <button type="button" data-route="${escapeHTML(route)}"
                        class="st-route ${active ? "active" : ""} ${left ? "" : "done"}" aria-pressed="${active}">
                        <span>${bad ? '<i class="st-route-dot"></i>' : ""}${escapeHTML(route)}</span>
                        ${left ? "" : "<em>✓</em>"}
                    </button>
                `;
            }).join("") : `<div class="no-data st-no-routes">No loads</div>`}
        `;

    }).join("");

}


function renderToolbar() {

    ui.seg.querySelectorAll("[data-side]").forEach(button => {
        button.classList.toggle("on", button.dataset.side === studio.side);
    });

    ui.chips.querySelectorAll("[data-chip]").forEach(button => {
        button.classList.toggle("on", button.dataset.chip === studio.chip);
    });

    setText(ui.attnCount, studioLoads().filter(item => Boolean(flagOf(item))).length);

    const finished = studioLoads().filter(item => !isOpen(item)).length;

    ui.finished.classList.toggle("on", studio.showFinished);
    setText(ui.finished, studio.showFinished ? `✓ Hide finished (${finished})` : `✓ Show finished (${finished})`);

    // Picked routes as yellow tags (and "SDT passed" when that's picked)
    const tags = studio.routes.map(route => `
        <button type="button" class="st-tag" data-route="${escapeHTML(route)}" aria-label="Remove ${escapeHTML(route)}">
            ${escapeHTML(route)}<span aria-hidden="true">✕</span>
        </button>`);

    const show = tags.length || studio.chip === "late";

    ui.filterLine.classList.toggle("hidden", !show);
    ui.filterLine.innerHTML = show
        ? `${tags.length ? `<span class="st-tags-label">Routes</span>${tags.join("")}` : ""}
           ${studio.chip === "late" ? `<span class="st-tags-label">SDT passed only</span>` : ""}
           <button type="button" data-clear class="st-link">Clear all</button>`
        : "";

}


function renderTable() {

    if (!studio.active) {
        return;
    }

    let loads = studioLoads();

    if (studio.routes.length) {
        loads = loads.filter(item => studio.routes.includes(item.route));
    }

    if (studio.search) {
        const terms = parseSearch(studio.search);
        if (terms.length) {
            loads = loads.filter(item => matchesSearch(item, terms));
        }
    }

    loads = loads.filter(passesFilters);

    const finishedCount = loads.filter(item => !isOpen(item)).length;

    if (!studio.showFinished) {
        loads = loads.filter(isOpen);
    }

    setText(
        ui.tableCount,
        `${loads.filter(isOpen).length} open · ${finishedCount} finished${studio.showFinished ? "" : " hidden"} · sorted by SDT`
    );

    if (!loads.length) {
        ui.body.innerHTML = `
            <tr><td colspan="12">
                <div class="st-empty">
                    <b>${appState.schedules.length ? "No loads match" : "No schedule loaded"}</b>
                    <span>${appState.schedules.length ? "Try a different filter or search." : "Upload the CSV to begin."}</span>
                </div>
            </td></tr>`;
        return;
    }

    // Late loads first, then one group per SDT hour
    const groups = [];
    const late = loads.filter(item => isOpen(item) && (minutesTo(item) ?? 0) < 0);

    if (late.length) {
        groups.push({ title: "Past SDT · not finished", loads: late, late: true });
    }

    const byHour = new Map();

    loads.filter(item => !late.includes(item)).forEach(item => {
        const hour = getTime(item.sdt).slice(0, 2) || "--";
        const key = `${String(item.sdt).slice(0, 10)} ${hour}`;
        if (!byHour.has(key)) byHour.set(key, { hour, loads: [] });
        byHour.get(key).loads.push(item);
    });

    [...byHour.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .forEach(([, group]) => {
            groups.push({
                title: `${formatTime(`${group.hour}:00`)} – ${formatTime(`${group.hour}:59`)}`,
                loads: group.loads
            });
        });

    ui.body.innerHTML = groups.map(group => `
        <tr class="st-group ${group.late ? "late" : ""}">
            <td colspan="12">
                <div class="st-group-line">
                    <b>${group.title}</b>
                    <span>${group.loads.length} ${group.loads.length === 1 ? "load" : "loads"}</span>
                </div>
            </td>
        </tr>
        ${group.loads.map(renderRow).join("")}
    `).join("");

}


function renderRow(item) {

    const flag = flagOf(item);
    const minutes = minutesTo(item);
    const fill = fillOf(item);
    const selected = appState.selectedScheduleId === item.id;
    const side = sideOf(item);

    let until = "—";
    let untilClass = "";

    if (!isOpen(item)) {
        until = "Finished";
        untilClass = "st-muted";
    } else if (minutes !== null && minutes < 0) {
        until = `late ${minutesText(minutes)}`;
        untilClass = "st-late";
    } else if (minutes !== null) {
        until = minutesText(minutes);
    }

    const pc = item.packages !== null && item.packages !== undefined
        ? `${Number(item.packages).toLocaleString()} / ${item.containers ?? "--"}`
        : "";

    return `
        <tr class="st-row ${flag ? "flag" : ""} ${selected ? "on" : ""} ${isOpen(item) ? "" : "fin"}" data-id="${escapeHTML(item.id)}">
            <td class="st-t">${timeOf(item.sdt)}</td>
            <td class="st-route-cell">
                <b>${escapeHTML(item.route)}</b>${(getDepartureTime(item) ?? 0) > studioCutoff().getTime() ? '<span class="st-nextsort">Next sort</span>' : ""}${item.carrierType === "3P" ? '<span class="st-3p">3P</span>' : ""}${flag ? `<span class="st-why st-why-${flag.key}">${flag.label}</span>` : ""}
            </td>
            <td><span class="st-cpt-tag ${isStudioCpt(item) ? "mine" : ""}">${timeOf(item.cpt) || "--"}</span></td>
            <td><span class="st-side st-side-${side}">${side}</span></td>
            <td>${doorChip(item, "—")}</td>
            <td><span class="st-status ${statusClass(item)}">${statusLabel(item)}</span></td>
            <td>${fill === null ? '<span class="st-none">—</span>' : `<div class="st-fill">${fillBar(fill)}<span>${fillText(item)}</span></div>`}</td>
            <td class="st-num st-col-pc">${pc || '<span class="st-none">—</span>'}</td>
            <td class="st-col-carrier">${item.carrierCode ? `${escapeHTML(item.carrierCode)}<span class="st-carrier-type">${escapeHTML(item.carrierType || "")}</span>` : '<span class="st-none">—</span>'}</td>
            <td class="st-col-equip st-dim">${escapeHTML(item.equipment || "")}</td>
            <td class="st-col-vr st-mono">${escapeHTML(item.vrId || "")}</td>
            <td class="st-right st-until ${untilClass}">${until}</td>
        </tr>
    `;

}


function doorChip(item, empty) {

    const door = getDoor(item);

    if (!door) {
        return `<span class="st-none">${empty}</span>`;
    }

    return `<span class="st-door ${inYard(item) ? "yard" : ""}">${escapeHTML(door)}</span>`;

}


function fillBar(fill) {
    const width = Math.max(0, Math.min(100, fill));
    return `<span class="st-bar"><i style="width:${width}%"></i></span>`;
}


/* =========================================================
   NOTIFICATIONS
   Checked whenever the schedule changes and every minute.
   Each thing notifies once per tab.
   ========================================================= */

function checkNotes() {

    const loads = studioLoads();

    // Nothing to check while there's no schedule (signed out, etc.)
    if (!loads.length && !appState.schedules.length) {
        studio.baseline = null;
        return;
    }

    const first = studio.firstCheck;
    studio.firstCheck = false;

    let loud = false;

    const add = (key, type, title, text, loadId = "", quiet = false) => {

        if (studio.seen.has(key)) {
            return;
        }

        studio.seen.add(key);

        if (quiet) {
            return;
        }

        studio.notes.unshift({ type, title, text, loadId, at: Date.now() });

        if (["sdt", "soon", "nodoor", "paused", "cpt"].includes(type)) {
            loud = true;
        }

    };

    loads.filter(isOpen).forEach(item => {

        const minutes = minutesTo(item);

        if (minutes === null) {
            return;
        }

        const door = getDoor(item) || "no door";
        const fill = fillText(item);

        if (minutes < 0) {

            add(`sdt:${item.id}`, "sdt", "SDT passed",
                `${routeTime(item)} not finished · ${door}${fill ? ` · ${fill} fill` : ""}`, item.id);

        } else if (minutes <= SOON_MINUTES) {

            add(`soon:${item.id}`, "soon", `Leaving in ${Math.max(1, Math.round(minutes))} min`,
                `${routeTime(item)} at ${door}${fill ? ` · ${fill} fill` : ""}`, item.id);

        }

        if (minutes >= 0 && isPaused(item)) {
            add(`paused:${item.id}`, "paused", "Loading paused",
                `${routeTime(item)} at ${door}`, item.id);
        }

        if (minutes >= 0 && minutes <= NO_DOOR_MINUTES && !hasDockDoor(item)) {
            add(`nodoor:${item.id}`, "nodoor", "No door",
                `${routeTime(item)} has no door, ${minutesText(minutes)} to SDT`, item.id);
        }

        const fillValue = fillOf(item);

        if (minutes >= 0 && minutes <= LOW_FILL_MINUTES && fillValue !== null && fillValue < LOW_FILL_PERCENT) {
            add(`low:${item.id}`, "low", "Low fill",
                `${routeTime(item)} only ${fill} fill, ${minutesText(minutes)} to SDT`, item.id);
        }

    });

    // CPT notes only for 21:00 / 03:00
    groupByCpt(loads.filter(isStudioCpt)).forEach(group => {

        const minutes = cptMinutes(group.cpt);

        const open = group.loads.filter(isOpen);

        // CPT passed with loads still open
        if (minutes !== null && minutes < 0 && open.length) {
            add(`cpt:${group.key}`, "cpt", `CPT ${timeOf(group.cpt)} passed`,
                `${open.length} not finished: ${open.slice(0, 4).map(routeTime).join(", ")}${open.length > 4 ? " …" : ""}`);
        }

        // A route finished everything for this CPT
        const byRoute = new Map();
        group.loads.forEach(item => {
            if (!byRoute.has(item.route)) byRoute.set(item.route, []);
            byRoute.get(item.route).push(item);
        });

        byRoute.forEach((items, route) => {
            if (items.every(item => !isOpen(item))) {
                add(`done:${group.key}:${route}`, "done", "Route done",
                    `${route}: all ${items.length} ${items.length === 1 ? "load" : "loads"} finished for CPT ${timeOf(group.cpt)}`,
                    "", first);   // already done when Studio opened: no note
            }
        });

    });

    watchChanges();

    if (studio.notes.length > NOTES_KEPT) {
        studio.notes.length = NOTES_KEPT;
    }

    writeSession(NOTES_KEY, studio.notes);
    writeSession(SEEN_KEY, [...studio.seen].slice(-800));

    if (loud && !first && studio.sound) {
        beep();
    }

    if (studio.active) {
        renderNotes();
    }

}


/*
 * New CSV / door changes: compares the loads now with the
 * loads before. Waits a moment so one upload = one note.
 */
function watchChanges() {

    const now = snapshotLoads();

    if (!now.size) {
        return;
    }

    if (!studio.baseline) {
        studio.baseline = now;
        studio.baselineUpload = appState.uploadedAt;
        return;
    }

    if (sameLoads(studio.baseline, now)) {
        return;
    }

    clearTimeout(studio.diffTimer);

    studio.diffTimer = setTimeout(() => {

        const before = studio.baseline;
        const after = snapshotLoads();

        if (!after.size || sameLoads(before, after)) {
            return;
        }

        const added = [...after.keys()].filter(id => !before.has(id));
        const gone = [...before.keys()].filter(id => !after.has(id));
        const moved = [...after.entries()].filter(([id, load]) =>
            before.has(id) && before.get(id).door !== load.door && load.door);

        const parts = [];

        if (added.length) parts.push(`${added.length} new ${added.length === 1 ? "load" : "loads"}`);
        if (gone.length) parts.push(`${gone.length} left the schedule`);
        if (moved.length) {
            parts.push(`door changes: ${moved.slice(0, 3)
                .map(([, load]) => `${load.name} → ${load.door}`).join(", ")}${moved.length > 3 ? ` +${moved.length - 3}` : ""}`);
        }

        const uploaded = appState.uploadedAt && appState.uploadedAt !== studio.baselineUpload;

        if (parts.length) {
            studio.notes.unshift({
                type: "csv",
                title: uploaded ? "New CSV" : "Schedule changed",
                text: parts.join(" · "),
                loadId: moved.length === 1 && !added.length && !gone.length ? moved[0][0] : "",
                at: Date.now()
            });
            writeSession(NOTES_KEY, studio.notes);
        }

        studio.baseline = after;
        studio.baselineUpload = appState.uploadedAt;

        if (studio.active) {
            renderNotes();
        }

    }, 2500);

}


function snapshotLoads() {

    const map = new Map();

    appState.schedules.forEach(item => {
        if (!item.removed) {
            map.set(item.id, {
                door: String(getDoor(item) || "").toUpperCase(),
                name: routeTime(item)
            });
        }
    });

    return map;

}


function sameLoads(a, b) {

    if (a.size !== b.size) {
        return false;
    }

    for (const [id, load] of b) {
        if (!a.has(id) || a.get(id).door !== load.door) {
            return false;
        }
    }

    return true;

}


function renderNotes() {

    ui.sound.textContent = studio.sound ? "🔔 Sound on" : "🔕 Sound off";
    ui.sound.classList.toggle("on", studio.sound);

    const notes = studio.notes;

    if (!notes.length) {
        ui.notes.innerHTML = `<li class="st-note-empty">Nothing new. Notifications show up here as things happen.</li>`;
    } else {
        const shown = studio.showAllNotes ? notes : notes.slice(0, NOTES_SHOWN);
        ui.notes.innerHTML = shown.map(note => {
            const time = new Date(note.at);
            const label = formatTime(`${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`);
            return `
                <li class="st-note st-note-${note.type} ${note.loadId ? "link" : ""}" ${note.loadId ? `data-id="${escapeHTML(note.loadId)}"` : ""}>
                    <i></i>
                    <div><b>${escapeHTML(note.title)}</b><p>${escapeHTML(note.text)}</p></div>
                    <time>${label}</time>
                </li>
            `;
        }).join("");
    }

    ui.notes.classList.toggle("all", studio.showAllNotes);

    ui.moreNotes.classList.toggle("hidden", notes.length <= NOTES_SHOWN);
    setText(ui.moreNotes, studio.showAllNotes ? "Show less" : `Show all (${notes.length})`);

    ui.clearNotes.classList.toggle("hidden", !notes.length);

}


/* Short two-tone sound */
let audioContext = null;

function beep() {

    try {

        audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();

        [880, 660].forEach((frequency, index) => {

            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();

            const start = audioContext.currentTime + index * 0.18;

            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

            oscillator.connect(gain).connect(audioContext.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.17);

        });

    } catch (error) {
        // No sound available: notifications still show
    }

}


/* =========================================================
   START
   ========================================================= */

buildStudio();

setupStudioEvents();

updateNav();

window.Studio = {

    render: renderStudio,

    // Every minute (from the app's clock)
    tick: renderStudio,

    // The site locked (idle, closed tab, signed out)
    lock: () => {
        lockStudio(false);
        studio.baseline = null;
    },

    open: () => (studio.open ? enterStudio() : askCode())

};

renderStudio();

})();
