/* =========================================================
   RBD5 - OUTBOUND SCHEDULE — PREFERENCES (themes)

   Adds "Preferences" under Schedule / Routes in the sidebar.

   Schedule:  10 two-color themes (left = sidebar, right = buttons
              and page) + Original, and a mode: Original or Black.
   Studio:    White or Black only (Studio keeps its own colors).

   Everything is saved on this device (like starred routes),
   so each person keeps their own look.

   To remove: delete the ob-theme.js line in ob-schedule.html.
   Needs ob-app.js (loaded first).
   ========================================================= */

(function () {

"use strict";


/* =========================================================
   SETTINGS
   left  = sidebar color
   right = buttons, active toggles, door chips, page tint
   ========================================================= */

const THEMES = [
    { id: "original", name: "Original", left: "#172033", right: "#172033" },
    { id: "ocean",    name: "Ocean",    left: "#0c4a6e", right: "#0284c7" },
    { id: "forest",   name: "Forest",   left: "#14532d", right: "#15803d" },
    { id: "sunset",   name: "Sunset",   left: "#7c2d12", right: "#ea580c" },
    { id: "royal",    name: "Royal",    left: "#3b0764", right: "#7c3aed" },
    { id: "pink",     name: "Pink",     left: "#9d174d", right: "#ec4899" },
    { id: "crimson",  name: "Crimson",  left: "#7f1d1d", right: "#dc2626" },
    { id: "teal",     name: "Teal",     left: "#134e4a", right: "#0d9488" },
    { id: "orange",   name: "Orange",   left: "#232f3e", right: "#ff9900" },
    { id: "indigo",   name: "Indigo",   left: "#1e1b4b", right: "#4f46e5" },
    { id: "coffee",   name: "Coffee",   left: "#3b2414", right: "#b45309" }
];

// Saved on this device
const THEME_KEY = "outboundTheme";              // theme id
const MODE_KEY = "outboundMode";                // "original" | "black"
const STUDIO_MODE_KEY = "outboundStudioMode";   // "white" | "black"


/* =========================================================
   SAVED CHOICES
   ========================================================= */

function read(key, fallback) {
    try {
        return localStorage.getItem(key) || fallback;
    } catch (error) {
        return fallback;
    }
}

function save(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        // Storage blocked: the choice still works until the page closes
    }
}

const prefs = {
    theme: read(THEME_KEY, "original"),
    mode: read(MODE_KEY, "original"),
    studioMode: read(STUDIO_MODE_KEY, "white")
};

const body = document.body;


function currentTheme() {
    return THEMES.find(theme => theme.id === prefs.theme) || THEMES[0];
}

function inStudio() {
    return body.classList.contains("studio-mode");
}


/* Dark text on light colors (Orange), white text on the rest */
function inkFor(hex) {

    const value = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map(start => parseInt(value.slice(start, start + 2), 16) / 255)
        .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));

    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    return luminance > 0.35 ? "#172033" : "#ffffff";

}


/* =========================================================
   APPLY
   ========================================================= */

function wantDark() {
    return inStudio() ? prefs.studioMode === "black" : prefs.mode === "black";
}

function apply() {

    const theme = currentTheme();

    body.classList.toggle("themed", theme.id !== "original");

    body.style.setProperty("--t-left", theme.left);
    body.style.setProperty("--t-right", theme.right);
    body.style.setProperty("--t-right-ink", inkFor(theme.right));

    body.classList.toggle("dark", wantDark());

    // Phone browser bar matches the sidebar
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.content = inStudio() || theme.id === "original" ? "#172033" : theme.left;
    }

}


/* Studio opening or closing switches between the two modes */
new MutationObserver(() => {

    if (body.classList.contains("dark") !== wantDark()) {
        body.classList.toggle("dark", wantDark());
    }

    if (ui.overlay && !ui.overlay.classList.contains("hidden")) {
        renderPanel();
    }

}).observe(body, { attributes: true, attributeFilter: ["class"] });


/* =========================================================
   PAGE PARTS
   ========================================================= */

const ui = {};

function build() {

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "ob-theme.css";
    document.head.appendChild(css);

    // Sidebar button
    ui.nav = document.createElement("button");
    ui.nav.type = "button";
    ui.nav.id = "prefNav";
    ui.nav.className = "nav-item pref-nav";
    ui.nav.innerHTML = '<span aria-hidden="true">⚙</span><span class="pref-nav-text">Preferences</span>';
    document.querySelector(".navigation")?.appendChild(ui.nav);

    // Panel
    ui.overlay = document.createElement("div");
    ui.overlay.className = "pref-overlay hidden";
    ui.overlay.innerHTML = `
        <div class="pref-box" role="dialog" aria-modal="true" aria-labelledby="prefTitle">
            <div class="pref-head">
                <div>
                    <h2 id="prefTitle">Preferences</h2>
                    <p id="prefSub"></p>
                </div>
                <button type="button" class="pref-close" aria-label="Close">✕</button>
            </div>
            <div class="pref-body" id="prefBody"></div>
            <div class="pref-foot">Saved on this device only. Everyone picks their own.</div>
        </div>
    `;
    body.appendChild(ui.overlay);

    ui.box = ui.overlay.querySelector(".pref-box");
    ui.sub = ui.overlay.querySelector("#prefSub");
    ui.body = ui.overlay.querySelector("#prefBody");

    ui.nav.addEventListener("click", openPanel);

    ui.overlay.addEventListener("click", event => {

        if (event.target === ui.overlay || event.target.closest(".pref-close")) {
            closePanel();
            return;
        }

        const theme = event.target.closest("[data-theme]");
        const mode = event.target.closest("[data-mode]");
        const studioMode = event.target.closest("[data-studio-mode]");

        if (theme) {
            prefs.theme = theme.dataset.theme;
            save(THEME_KEY, prefs.theme);
        } else if (mode) {
            prefs.mode = mode.dataset.mode;
            save(MODE_KEY, prefs.mode);
        } else if (studioMode) {
            prefs.studioMode = studioMode.dataset.studioMode;
            save(STUDIO_MODE_KEY, prefs.studioMode);
        } else {
            return;
        }

        apply();
        renderPanel();

    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !ui.overlay.classList.contains("hidden")) {
            closePanel();
        }
    });

}


function openPanel() {

    if (isLockedNow()) {
        return;
    }

    renderPanel();

    ui.overlay.classList.remove("hidden");

    ui.box.querySelector(".pref-close")?.focus();

}


function closePanel() {
    ui.overlay.classList.add("hidden");
}


function segment(attr, value, options) {

    return `
        <div class="pref-seg" role="group">
            ${options.map(([key, label, icon]) => `
                <button type="button" data-${attr}="${key}" class="${value === key ? "on" : ""}" aria-pressed="${value === key}">
                    <i class="pref-mode-dot pref-mode-${key}" aria-hidden="true">${icon || ""}</i>${label}
                </button>
            `).join("")}
        </div>
    `;

}


function renderPanel() {

    // Studio: only White / Black
    if (inStudio()) {

        ui.sub.textContent = "Studio";

        ui.body.innerHTML = `
            <section class="pref-section">
                <div class="pref-label">Studio mode</div>
                ${segment("studio-mode", prefs.studioMode, [["white", "White"], ["black", "Black"]])}
                <p class="pref-hint">Themes are for the schedule. Studio keeps its own colors.</p>
            </section>
        `;

        return;

    }

    ui.sub.textContent = "Schedule";

    ui.body.innerHTML = `
        <section class="pref-section">
            <div class="pref-label">Theme <span>Left = sidebar · Right = buttons</span></div>
            <div class="pref-themes">
                ${THEMES.map(theme => `
                    <button type="button" data-theme="${theme.id}"
                        class="pref-theme ${theme.id === prefs.theme ? "on" : ""}"
                        aria-pressed="${theme.id === prefs.theme}"
                        style="--sw-left:${theme.left};--sw-right:${theme.right}">
                        <span class="pref-swatch" aria-hidden="true">
                            <i class="sw-left"><b></b><b></b><b></b></i>
                            <i class="sw-right"><b></b><em></em></i>
                        </span>
                        <span class="pref-theme-name">${theme.name}${theme.id === prefs.theme ? "<em>✓</em>" : ""}</span>
                    </button>
                `).join("")}
            </div>
        </section>

        <section class="pref-section">
            <div class="pref-label">Mode</div>
            ${segment("mode", prefs.mode, [["original", "Original"], ["black", "Black"]])}
        </section>
    `;

}


/* =========================================================
   START
   ========================================================= */

build();

apply();

window.Preferences = { open: openPanel, apply };

})();
