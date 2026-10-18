/* =========================================================
   RBD5 - OUTBOUND SCHEDULE (v4) — STUDIO
   Manager view: every load in the shift window, what needs
   attention, what's leaving next, and notifications.

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
       (or delete the ob-studio-v4.js line in ob-schedule-v4.html)

   Needs ob-app-v4.js (loaded first).
   ========================================================= */

(function () {

"use strict";


/* =========================================================
   SETTINGS
   ========================================================= */

const STUDIO_ENABLED = true;

// The code that opens Studio. "" = no code needed.
const STUDIO_CODE = "12345";

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
    route: null,          // route picked on the left
    search: "",

    expanded: new Set(),  // CPT groups showing their finished loads

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
                </div>

            </div>

            <div class="st-filter-line hidden" id="stFilterLine"></div>

            <div class="st-table-wrap">
                <table class="st-table">
                    <thead>
                        <tr>
                            <th>SDT</th>
                            <th>Route</th>
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
            studio.route = studio.route === button.dataset.route ? null : button.dataset.route;
            renderStudio();
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

    ui.filterLine.addEventListener("click", event => {
        if (event.target.closest("[data-clear]")) {
            clearFilters();
        }
    });

    // Rows, "show finished" and "Leaving next hour" rows
    ui.body.addEventListener("click", event => {

        const fold = event.target.closest("[data-expand]");

        if (fold) {
            const key = fold.dataset.expand;
            studio.expanded.has(key) ? studio.expanded.delete(key) : studio.expanded.add(key);
            renderTable();
            return;
        }

        const row = event.target.closest("[data-id]");

        if (row) {
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


function setChip(chip) {
    studio.chip = studio.chip === chip ? null : chip;
    renderStudio();
}


function clearFilters() {
    studio.side = "all";
    studio.chip = null;
    studio.route = null;
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
    setText(sub, "Floor overview · every load in this shift window");

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

/* Every load Studio shows: shift window, not removed */
function studioLoads() {

    const oldest = Date.now() - STALE_HOURS * 3600000;

    return appState.schedules
        .filter(item => {
            if (item.removed || !isInShiftWindow(item)) return false;
            const departure = getDepartureTime(item);
            return departure === null || departure >= oldest;
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
    return /paused/i.test(item.csvStatus || "");
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

function statusLabel(item) {
    if (item.status === "finished") return "Finished";
    if (isPaused(item)) return "Paused";
    if (item.status === "in-progress") return "Loading";
    return "Scheduled";
}

function statusClass(item) {
    if (item.status === "finished") return "st-st-fin";
    if (isPaused(item)) return "st-st-paused";
    if (item.status === "in-progress") return "st-st-prog";
    return "st-st-sch";
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


/* Filters from the toolbar (not the route on the left) */
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
                        <tr data-id="${escapeHTML(item.id)}" class="${flag ? "bad" : ""}" title="${flag ? escapeHTML(flag.label) : ""}">
                            <td class="st-t">${timeOf(item.sdt)}</td>
                            <td><b>${escapeHTML(item.route)}</b></td>
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

    const groups = groupByCpt(studioLoads());

    if (!groups.length) {
        ui.routes.innerHTML = `<div class="no-data">No schedule loaded</div>`;
        return;
    }

    ui.routes.innerHTML = groups.map(group => {

        const minutes = cptMinutes(group.cpt);

        const byRoute = new Map();

        group.loads.forEach(item => {
            if (!byRoute.has(item.route)) byRoute.set(item.route, []);
            byRoute.get(item.route).push(item);
        });

        const routes = [...byRoute.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        return `
            <div class="st-cpt-head">
                <b>${timeOf(group.cpt)}</b>
                <span class="${minutes !== null && minutes < 0 ? "passed" : ""}">
                    ${minutes === null ? "" : minutes < 0 ? "passed" : `in ${minutesText(minutes)}`}
                </span>
            </div>
            ${routes.map(([route, items]) => {
                const left = items.filter(isOpen).length;
                const bad = items.some(flagOf);
                const active = studio.route === route;
                return `
                    <button type="button" data-route="${escapeHTML(route)}"
                        class="st-route ${active ? "active" : ""} ${left ? "" : "done"}"
                        aria-pressed="${active}" title="${active ? "Show all routes" : `Show only ${escapeHTML(route)}`}">
                        <span>${bad ? '<i class="st-route-dot"></i>' : ""}${escapeHTML(route)}</span>
                        <em>${left || "✓"}</em>
                    </button>
                `;
            }).join("")}
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

    const parts = [];

    if (studio.route) parts.push(`<b>${escapeHTML(studio.route)}</b> only`);
    if (studio.chip === "late") parts.push("<b>SDT passed</b>");

    ui.filterLine.classList.toggle("hidden", !parts.length);
    ui.filterLine.innerHTML = parts.length
        ? `Showing ${parts.join(" · ")} <button type="button" data-clear class="st-link">✕ Show everything</button>`
        : "";

}


function renderTable() {

    if (!studio.active) {
        return;
    }

    let loads = studioLoads();

    if (studio.route) {
        loads = loads.filter(item => item.route === studio.route);
    }

    if (studio.search) {
        const terms = parseSearch(studio.search);
        if (terms.length) {
            loads = loads.filter(item => matchesSearch(item, terms));
        }
    }

    loads = loads.filter(passesFilters);

    // A picked route or a search shows finished loads too
    const showAllFinished = Boolean(studio.route || studio.search);

    const groups = groupByCpt(loads);

    if (!groups.length) {
        ui.body.innerHTML = `
            <tr><td colspan="11">
                <div class="st-empty">
                    <b>${appState.schedules.length ? "No loads match" : "No schedule loaded"}</b>
                    <span>${appState.schedules.length ? "Try a different filter or search." : "Upload the CSV to begin."}</span>
                </div>
            </td></tr>`;
        return;
    }

    ui.body.innerHTML = groups.map(group => {

        const all = group.loads;
        const finished = all.filter(item => !isOpen(item));
        const loading = all.filter(item => item.status === "in-progress").length;
        const notStarted = all.length - finished.length - loading;

        const minutes = cptMinutes(group.cpt);
        const passed = minutes !== null && minutes < 0;

        const expanded = showAllFinished || studio.expanded.has(group.key);

        const shown = expanded ? all : all.filter(isOpen);

        const packages = all.reduce((sum, item) => sum + (Number(item.packages) || 0), 0);

        return `
            <tr class="st-group">
                <td colspan="11">
                    <div class="st-group-line">
                        <b>CPT ${timeOf(group.cpt)}</b>
                        <span class="${passed && finished.length < all.length ? "st-red" : ""}">
                            ${minutes === null ? "" : passed ? "passed" : `in ${minutesText(minutes)}`}
                        </span>
                        <span>${all.length} loads · ${finished.length} finished · ${loading} loading · ${notStarted} not started${packages ? ` · ${packages.toLocaleString()} pkgs` : ""}</span>
                        <span class="st-group-bar">
                            <i class="st-fin" style="flex:${finished.length}"></i>
                            <i class="st-prog" style="flex:${loading}"></i>
                            <i class="st-sch" style="flex:${notStarted}"></i>
                        </span>
                    </div>
                </td>
            </tr>
            ${shown.map(renderRow).join("")}
            ${finished.length && !showAllFinished ? `
                <tr class="st-fold">
                    <td colspan="11">
                        ${expanded
                            ? `<button type="button" class="st-link" data-expand="${escapeHTML(group.key)}">Hide ${finished.length} finished</button>`
                            : `✓ ${finished.length} finished: ${finished.slice(0, 8).map(item => escapeHTML(routeTime(item))).join(", ")}${finished.length > 8 ? " …" : ""}
                               <button type="button" class="st-link" data-expand="${escapeHTML(group.key)}">show</button>`}
                    </td>
                </tr>` : ""}
        `;

    }).join("");

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
                <b>${escapeHTML(item.route)}</b>${item.carrierType === "3P" ? '<span class="st-3p">3P</span>' : ""}${flag ? `<span class="st-why st-why-${flag.key}">${flag.label}</span>` : ""}
            </td>
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

    groupByCpt(loads).forEach(group => {

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
