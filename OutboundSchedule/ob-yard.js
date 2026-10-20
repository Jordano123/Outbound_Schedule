/* =========================================================
   RBD5 - OUTBOUND SCHEDULE — YARD BAR
   The bar across the top of the page: is the yard open?

   Follows the same rules as the Kepler51 yard alerts:
     RED    YARD CLOSED  lightning within 6 miles (stays closed
                         30 min after the last strike), or a
                         tornado warning
     ORANGE YARD OPEN    with a warning:
                         gusts above 40 mph -> Significant Wind Warning
                         gusts above 20 mph -> Wind Warning
                         lightning within 10 miles
                         heat index Level 2 / 3 / 4
                         weather service warnings (flash flood, ...)
     GREEN  YARD OPEN    no warnings

   Where the data comes from:
     Wind, gusts, temperature, humidity: Open-Meteo (free, no key)
     Official warnings for the building:  National Weather Service (free)
     Lightning strikes and distance:      Xweather (xweather-config.js)
       - only checked when storms are possible
       - one check every 2 minutes shared by everyone (Firebase)
       - stops at LIGHTNING_MONTHLY_LIMIT so it stays free

   This is a weather-based guide. The TOM team's call is final.

   Needs ob-app.js (loaded first). To remove the yard bar,
   delete the ob-yard.js line in ob-schedule.html.
   ========================================================= */

(function () {

"use strict";


/* =========================================================
   SETTINGS
   ========================================================= */

const YARD = {
    name: "RBD5",
    address: "3500 S Airfield Dr, Irving, TX 75038",
    lat: 32.8655,
    lon: -97.0193
};

// Wind (gusts, mph) — same as Kepler
const WIND_WARN_GUST = 20;      // Wind Warning
const WIND_SIGNIFICANT_GUST = 40; // Significant Wind Warning

// Heat index levels (°F) — same as Kepler
const HEAT_LEVELS = [
    { min: 115, level: 4, range: "115°F+" },
    { min: 100, level: 3, range: "100–115°F" },
    { min: 90,  level: 2, range: "90–100°F" }
];

// Lightning (miles)
const LIGHTNING_CLOSE_MI = 6;    // yard closed
const LIGHTNING_WARN_MI = 10;    // lightning warning
const LIGHTNING_CLEAR_MINUTES = 30; // closed until 30 min after the last close strike

// How often to look
const WEATHER_EVERY_MS = 5 * 60 * 1000;
const LIGHTNING_EVERY_MS = 2 * 60 * 1000;

// Xweather free plan: 15,000 accesses a month, lightning counts 10 each
// -> 1,500 checks. Stop a little before that so it never costs money.
const LIGHTNING_MONTHLY_LIMIT = 1400;

// The day Xweather's monthly count resets (from the Xweather dashboard)
const XWEATHER_RESET_DAY = 20;

// Shared lightning result (Firebase), so everyone uses one check
const YARD_COLLECTION = "yardV4";
const YARD_DOC = "lightning";
const LOCAL_LIGHTNING_KEY = "obYardLightning";


/* =========================================================
   STATE
   ========================================================= */

const yard = {
    weather: null,       // { temp, humidity, wind, gust, code, codesAhead, at }
    alerts: [],          // National Weather Service events, e.g. "Flash Flood Warning"
    weatherError: false,
    lightning: {         // shared between everyone
        checkedAt: 0,
        nearestMi: null,     // closest strike in the last check (within 10 mi)
        lastCloseAt: 0,      // last strike within 6 mi
        lastWarnAt: 0,       // last strike within 10 mi
        cycle: "",
        count: 0
    },
    checking: false,
    unsubscribe: null
};

const hasKey = () =>
    typeof XWEATHER_CLIENT_ID === "string" && XWEATHER_CLIENT_ID.trim() !== "" &&
    typeof XWEATHER_CLIENT_SECRET === "string" && XWEATHER_CLIENT_SECRET.trim() !== "";


/* =========================================================
   THE BAR
   ========================================================= */

const ui = {};

function buildBar() {

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "ob-yard.css";
    document.head.appendChild(css);

    ui.bar = document.createElement("div");
    ui.bar.className = "yard-bar checking";
    ui.bar.setAttribute("role", "status");
    ui.bar.innerHTML = `
        <div class="yard-pill"><i aria-hidden="true">…</i><span>YARD</span></div>
        <div class="yard-msg"><b>Checking the yard weather…</b><span></span></div>
        <div class="yard-tags"></div>
        <div class="yard-stats">
            <div class="yard-stat"><small>Temp</small><b data-temp>--</b></div>
            <div class="yard-stat"><small>Wind / gusts</small><b data-wind>--</b></div>
            <div class="yard-stat" data-heat-box><small>Heat index</small><b data-heat>--</b></div>
        </div>
        <div class="yard-addr"><b>${YARD.name}</b><span>${YARD.address}</span></div>
    `;

    document.body.insertBefore(ui.bar, document.body.firstChild);
    document.body.classList.add("has-yard-bar");

    ui.icon = ui.bar.querySelector(".yard-pill i");
    ui.pillText = ui.bar.querySelector(".yard-pill span");
    ui.title = ui.bar.querySelector(".yard-msg b");
    ui.sub = ui.bar.querySelector(".yard-msg span");
    ui.tags = ui.bar.querySelector(".yard-tags");
    ui.temp = ui.bar.querySelector("[data-temp]");
    ui.wind = ui.bar.querySelector("[data-wind]");
    ui.heat = ui.bar.querySelector("[data-heat]");
    ui.heatBox = ui.bar.querySelector("[data-heat-box]");

}


/* =========================================================
   RULES -> WHAT THE BAR SAYS
   ========================================================= */

function heatLevel(heatIndex) {
    if (heatIndex === null) return null;
    return HEAT_LEVELS.find(level => heatIndex >= level.min) || null;
}

function isThunderCode(code) {
    return code >= 95 && code <= 99;
}

/* Any warning containing this word ("thunderstorm", "tornado") */
function hasAlert(word) {
    return yard.alerts.some(event => event.toLowerCase().includes(word));
}

/* This exact warning ("Flash Flood Warning") */
function hasEvent(name) {
    return yard.alerts.some(event => event.toLowerCase() === name.toLowerCase());
}

function minutesSince(time) {
    return time ? (Date.now() - time) / 60000 : Infinity;
}

/* Lightning checks only run when a storm is possible */
function stormPossible() {

    const w = yard.weather;

    return Boolean(
        (w && (isThunderCode(w.code) || w.codesAhead.some(isThunderCode))) ||
        hasAlert("thunderstorm") || hasAlert("tornado") ||
        minutesSince(yard.lightning.lastWarnAt) < LIGHTNING_CLEAR_MINUTES
    );

}

function lightningWorking() {
    return hasKey() && !lightningPaused();
}

function lightningPaused() {
    const l = yard.lightning;
    return l.cycle === currentCycle() && l.count >= LIGHTNING_MONTHLY_LIMIT;
}


/*
 * { state: "open" | "warn" | "closed" | "checking" | "offline",
 *   title, sub, tags: [] }
 */
function decide() {

    const w = yard.weather;
    const l = yard.lightning;

    if (!w) {
        return yard.weatherError
            ? { state: "offline", title: "Yard weather unavailable", sub: "Can't reach the weather service right now. Check Kepler.", tags: [] }
            : { state: "checking", title: "Checking the yard weather…", sub: "", tags: [] };
    }

    const warnings = [];   // most serious first

    // ---- Closed ----
    const closeMin = minutesSince(l.lastCloseAt);

    if (closeMin < LIGHTNING_CLEAR_MINUTES) {
        const left = Math.max(1, Math.ceil(LIGHTNING_CLEAR_MINUTES - closeMin));
        return {
            state: "closed",
            title: `Lightning Alert · strike within ${LIGHTNING_CLOSE_MI} miles` +
                (l.nearestMi !== null && minutesSince(l.checkedAt) < 6 ? ` (${l.nearestMi.toFixed(1)} mi)` : ""),
            sub: `No yard moves · reopens in ${left} min if no more strikes`,
            tags: otherTags(w)
        };
    }

    if (hasEvent("Tornado Warning")) {
        return { state: "closed", title: "Tornado Warning", sub: "No yard moves · National Weather Service warning for the building", tags: otherTags(w) };
    }

    // Without lightning data, a thunderstorm at the building closes it
    if (!lightningWorking() && (isThunderCode(w.code) || hasEvent("Severe Thunderstorm Warning"))) {
        return {
            state: "closed",
            title: "Thunderstorm / lightning in the area",
            sub: "No yard moves until it clears" + (hasEvent("Severe Thunderstorm Warning") ? " · Severe Thunderstorm Warning" : ""),
            tags: otherTags(w)
        };
    }

    // ---- Warnings ----
    if (minutesSince(l.lastWarnAt) < LIGHTNING_CLEAR_MINUTES) {
        warnings.push({
            title: `Lightning Warning · strike within ${LIGHTNING_WARN_MI} miles` +
                (l.nearestMi !== null && minutesSince(l.checkedAt) < 6 ? ` (${l.nearestMi.toFixed(1)} mi)` : ""),
            sub: "Lightning detected in the surrounding area",
            tag: "Lightning nearby"
        });
    }

    if (hasEvent("Severe Thunderstorm Warning")) {
        warnings.push({ title: "Severe Thunderstorm Warning", sub: "National Weather Service · hail and strong wind possible", tag: "Severe T-storm" });
    }

    if (w.gust !== null && w.gust > WIND_SIGNIFICANT_GUST) {
        warnings.push({
            title: `Significant Wind Warning · gusts above ${WIND_SIGNIFICANT_GUST} mph`,
            sub: "Hostlers stop moving empty trailers · partial yard audits only",
            tag: `Gusts ${Math.round(w.gust)} mph`
        });
    } else if (w.gust !== null && w.gust > WIND_WARN_GUST) {
        warnings.push({
            title: `Wind Warning · gusts above ${WIND_WARN_GUST} mph`,
            sub: "Partial yard audits only · no going behind trailers or opening trailer doors",
            tag: `Gusts ${Math.round(w.gust)} mph`
        });
    }

    const heat = heatLevel(w.heatIndex);

    if (heat) {
        warnings.push({
            title: `High Heat Index · Level ${heat.level} (${heat.range})`,
            sub: `Heat index ${Math.round(w.heatIndex)}°F · follow heat safety procedures`,
            tag: `Heat Level ${heat.level}`
        });
    }

    ["Flash Flood Warning", "Tornado Watch", "Severe Thunderstorm Watch", "High Wind Warning",
     "Wind Advisory", "Excessive Heat Warning", "Heat Advisory", "Flood Warning"]
        .filter(event => hasEvent(event))
        .forEach(event => warnings.push({ title: event, sub: "National Weather Service", tag: event }));

    if (warnings.length) {
        const [top, ...rest] = warnings;
        return { state: "warn", title: top.title, sub: top.sub, tags: rest.map(item => item.tag) };
    }

    return {
        state: "open",
        title: "No weather warnings",
        sub: lightningPaused()
            ? "Yard moves and audits as normal · lightning check paused until next month"
            : "Yard moves and audits as normal",
        tags: []
    };

}


/* Extra tags shown next to a closed message */
function otherTags(w) {
    const tags = [];
    if (w.gust !== null && w.gust > WIND_WARN_GUST) tags.push(`Gusts ${Math.round(w.gust)} mph`);
    const heat = heatLevel(w.heatIndex);
    if (heat) tags.push(`Heat Level ${heat.level}`);
    if (hasEvent("Flash Flood Warning")) tags.push("Flash Flood Warning");
    return tags;
}


function render() {

    if (!ui.bar) return;

    const status = decide();
    const w = yard.weather;

    ui.bar.className = `yard-bar ${status.state}`;

    const pill = {
        open: ["✓", "YARD OPEN"],
        warn: ["!", "YARD OPEN"],
        closed: ["✕", "YARD CLOSED"],
        checking: ["…", "YARD"],
        offline: ["?", "YARD"]
    }[status.state];

    ui.icon.textContent = pill[0];
    ui.pillText.textContent = pill[1];
    ui.title.textContent = status.title;
    ui.sub.textContent = status.sub;

    ui.tags.innerHTML = status.tags
        .map(tag => `<span>+ ${escapeHTML(tag)}</span>`)
        .join("");

    ui.temp.textContent = w && w.temp !== null ? `${Math.round(w.temp)}°F` : "--";
    ui.wind.textContent = w && w.wind !== null
        ? `${Math.round(w.wind)} / ${Math.round(w.gust ?? w.wind)} mph`
        : "--";
    ui.heat.textContent = w && w.heatIndex !== null ? `${Math.round(w.heatIndex)}°F` : "--";
    ui.heatBox.classList.toggle("hot", Boolean(w && heatLevel(w.heatIndex)));

}


/* =========================================================
   WEATHER (Open-Meteo) + WARNINGS (National Weather Service)
   ========================================================= */

async function loadWeather() {

    const url = "https://api.open-meteo.com/v1/forecast" +
        `?latitude=${YARD.lat}&longitude=${YARD.lon}` +
        "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code" +
        "&hourly=weather_code&forecast_hours=3" +
        "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago";

    try {

        const response = await fetch(url, { cache: "no-store" });

        if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);

        const data = await response.json();
        const now = data.current || {};

        const temp = numberOrNull(now.temperature_2m);
        const humidity = numberOrNull(now.relative_humidity_2m);

        yard.weather = {
            temp,
            humidity,
            wind: numberOrNull(now.wind_speed_10m),
            gust: numberOrNull(now.wind_gusts_10m),
            code: numberOrNull(now.weather_code) ?? 0,
            codesAhead: (data.hourly?.weather_code || []).map(Number),
            heatIndex: heatIndexF(temp, humidity),
            at: Date.now()
        };

        yard.weatherError = false;

    } catch (error) {

        console.warn("[Yard] weather failed", error);

        // Keep showing the last good reading for a while
        if (!yard.weather || Date.now() - yard.weather.at > 30 * 60000) {
            yard.weather = null;
            yard.weatherError = true;
        }

    }

    try {

        const response = await fetch(
            `https://api.weather.gov/alerts/active?point=${YARD.lat},${YARD.lon}`,
            { headers: { Accept: "application/geo+json" }, cache: "no-store" }
        );

        if (!response.ok) throw new Error(`NWS ${response.status}`);

        const data = await response.json();

        yard.alerts = (data.features || [])
            .map(feature => feature?.properties?.event)
            .filter(Boolean);

    } catch (error) {
        console.warn("[Yard] weather warnings failed", error);
    }

    render();

    checkLightning();

}


function numberOrNull(value) {
    const number = Number(value);
    return value === null || value === undefined || isNaN(number) ? null : number;
}


/* National Weather Service heat index formula (°F) */
function heatIndexF(t, rh) {

    if (t === null || rh === null) return null;

    const simple = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);

    if ((simple + t) / 2 < 80) return simple;

    let hi = -42.379 + 2.04901523 * t + 10.14333127 * rh
        - 0.22475541 * t * rh - 0.00683783 * t * t
        - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
        + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;

    if (rh < 13 && t >= 80 && t <= 112) {
        hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
    } else if (rh > 85 && t >= 80 && t <= 87) {
        hi += ((rh - 85) / 10) * ((87 - t) / 5);
    }

    return hi;

}


/* =========================================================
   LIGHTNING (Xweather) — one shared check for everyone
   ========================================================= */

/* Xweather's count resets on the 20th (UTC): "2026-10" = Oct 20 – Nov 19 */
function currentCycle() {
    const now = new Date();
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    if (now.getUTCDate() < XWEATHER_RESET_DAY) {
        month -= 1;
        if (month < 0) { month = 11; year -= 1; }
    }
    return `${year}-${String(month + 1).padStart(2, "0")}`;
}


function sharedDoc() {
    if (typeof USE_FIREBASE !== "undefined" && USE_FIREBASE && firebaseState?.db && appState?.signedIn) {
        return firebaseState.db.collection(YARD_COLLECTION).doc(YARD_DOC);
    }
    return null;
}


/* Listen to the shared result (Firebase) */
function listenToLightning() {

    stopListening();

    const ref = sharedDoc();

    if (!ref) {
        // Simple mode: this device only
        try {
            Object.assign(yard.lightning, JSON.parse(localStorage.getItem(LOCAL_LIGHTNING_KEY)) || {});
        } catch (error) { /* ignore */ }
        render();
        return;
    }

    yard.unsubscribe = ref.onSnapshot(doc => {
        if (doc.exists) {
            Object.assign(yard.lightning, doc.data());
        }
        render();
    }, error => console.warn("[Yard] lightning listener", error));

}


function stopListening() {
    yard.unsubscribe?.();
    yard.unsubscribe = null;
}


async function saveLightning(changes) {

    Object.assign(yard.lightning, changes);

    const ref = sharedDoc();

    if (ref) {
        try {
            await ref.set(changes, { merge: true });
        } catch (error) {
            console.warn("[Yard] couldn't save lightning", error);
        }
    } else {
        try {
            localStorage.setItem(LOCAL_LIGHTNING_KEY, JSON.stringify(yard.lightning));
        } catch (error) { /* ignore */ }
    }

}


async function checkLightning() {

    if (yard.checking || !hasKey() || !stormPossible()) return;
    if (typeof isLockedNow === "function" && isLockedNow()) return;

    const l = yard.lightning;
    const cycle = currentCycle();
    const count = l.cycle === cycle ? (l.count || 0) : 0;

    if (count >= LIGHTNING_MONTHLY_LIMIT) return;

    // Someone checked recently: use theirs
    if (Date.now() - (l.checkedAt || 0) < LIGHTNING_EVERY_MS - 5000) return;

    yard.checking = true;

    try {

        // Claim this check first so other screens skip it
        await saveLightning({ checkedAt: Date.now(), cycle, count: count + 1 });

        const url = "https://data.api.xweather.com/lightning/closest" +
            `?p=${YARD.lat},${YARD.lon}&radius=${LIGHTNING_WARN_MI}mi&limit=1` +
            `&client_id=${encodeURIComponent(XWEATHER_CLIENT_ID.trim())}` +
            `&client_secret=${encodeURIComponent(XWEATHER_CLIENT_SECRET.trim())}`;

        const response = await fetch(url, { cache: "no-store" });
        const data = await response.json();

        // "No strikes" comes back as success with an empty list
        if (!data.success && data.error && data.error.code !== "warn_no_data") {
            throw new Error(`${data.error.code}: ${data.error.description}`);
        }

        const strike = Array.isArray(data.response) ? data.response[0] : null;
        const miles = strike?.relativeTo?.distanceMI ?? null;
        const when = strike?.ob?.timestamp ? strike.ob.timestamp * 1000 : Date.now();

        const changes = { nearestMi: miles };

        if (miles !== null && miles <= LIGHTNING_CLOSE_MI) changes.lastCloseAt = when;
        if (miles !== null && miles <= LIGHTNING_WARN_MI) changes.lastWarnAt = when;

        await saveLightning(changes);

    } catch (error) {

        console.warn("[Yard] lightning check failed", error);

    } finally {

        yard.checking = false;
        render();

    }

}


/* =========================================================
   START
   ========================================================= */

buildBar();
render();
loadWeather();

setInterval(loadWeather, WEATHER_EVERY_MS);

// Every 30 s: redraw (countdowns) and see if a lightning check is due
setInterval(() => {
    render();
    checkLightning();
}, 30000);

// Follow sign-in / sign-out (the shared result lives in Firebase)
let wasSignedIn = null;
setInterval(() => {
    const signedIn = typeof appState !== "undefined" ? Boolean(appState.signedIn) : false;
    if (signedIn !== wasSignedIn) {
        wasSignedIn = signedIn;
        if (signedIn || !USE_FIREBASE) listenToLightning();
        else stopListening();
    }
}, 1000);

window.YardBar = { refresh: loadWeather, state: yard };

})();
