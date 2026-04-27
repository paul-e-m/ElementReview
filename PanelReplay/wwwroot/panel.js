(function () {
    // Remote replay client used by panel.html.
    // It stays lightweight by treating /api/status as the source of truth for
    // whether replay media is available, which clip should be shown, and which
    // replay-file token is safe to request from the server.
    const BASE = readApiBase();
    const IS_PANEL_REPLAY_HOST = readPanelReplayHostFlag();
    const END_EPS = 0.02;
    const REPLAY_POLL_INTERVAL_MS = 2500;
    const RAIL_ELEMENT_ROWS = 12;
    const ENTIRE_RECORDING_LABEL = "ENTIRE RECORDING";
    const TIMELINE_INTERVALS_SECONDS = [0.1, 0.5, 1, 5, 15, 30, 60];
    const EMPTY_STATE_WAITING_FOR_SERVER = "WAITING FOR VIDEO REPLAY SERVER / EN ATTENTE DU SERVEUR DE RELECTURE VIDEO";
    const EMPTY_STATE_NO_CLIPS = "WAITING FOR VIDEO DATA / EN ATTENTE DES DONNEES VIDEO";
    const EMPTY_STATE_SELECTED_CLIP_MISSING = "The selected video clip is not currently available";
    const SESSION_INFO_POLL_INTERVAL_MS = 5000;
    const STOPWATCH_PLAYHEAD_CLASSES = ["isStopwatchPending", "isStopwatchPositive", "isStopwatchNegative"];

    const dom = {
        shell: document.getElementById("panelShell"),
        topRow: document.getElementById("panelTopRow"),
        videoPane: document.getElementById("videoPane"),
        panelSessionInfo: document.getElementById("panelSessionInfo"),
        panelSessionInfoText: document.getElementById("panelSessionInfoText"),
        panelServerStatusDot: document.getElementById("panelServerStatusDot"),
        panelSessionRefreshBtn: document.getElementById("panelSessionRefreshBtn"),
        panelSettingsBtn: document.getElementById("panelSettingsBtn"),
        panelLogoBtn: document.getElementById("panelLogoBtn"),
        brandOverlay: document.getElementById("brandOverlay"),
        panelSettingsOverlay: document.getElementById("panelSettingsOverlay"),
        panelSettingsLanguage: document.getElementById("panelSettingsLanguage"),
        panelSettingsServerIp: document.getElementById("panelSettingsServerIp"),
        panelSettingsTimerEnabled: document.getElementById("panelSettingsTimerEnabled"),
        panelSettingsStatus: document.getElementById("panelSettingsStatus"),
        panelSettingsSaveBtn: document.getElementById("panelSettingsSaveBtn"),
        elementRail: document.getElementById("elementRail"),
        video: document.getElementById("v"),
        timelineArea: document.getElementById("timelineArea"),
        stopwatchRange: document.getElementById("stopwatchRange"),
        elementMarkers: document.getElementById("elementMarkers"),
        timelineTicks: document.getElementById("timelineTicks"),
        timelineLabels: document.getElementById("timelineLabels"),
        stopwatchMarker: document.getElementById("stopwatchMarker"),
        stopwatchIndicator: document.getElementById("stopwatchIndicator"),
        outOfClipIndicator: document.getElementById("outOfClipIndicator"),
        playhead: document.getElementById("playhead"),
        relativeIndicator: document.getElementById("relativeIndicator"),
        transportRow: document.getElementById("transportRow"),
        stopwatchBtn: document.getElementById("stopwatchBtn"),
        timingPresetButtons: document.getElementById("timingPresetButtons"),
        transportButtons: document.querySelector(".transportButtons"),
        playPause: document.getElementById("playPause"),
        rew10: document.getElementById("rew10"),
        rew3: document.getElementById("rew3"),
        fwd3: document.getElementById("fwd3"),
        fwd10: document.getElementById("fwd10"),
        emptyState: document.getElementById("emptyState"),
        emptyStateMessage: document.getElementById("emptyStateMessage")
    };

    const state = {
        clip: null,
        clips: [],
        clipMap: new Map(),
        elementMeta: {},
        selectedClipIndex: null,
        // Non-menu mode tracks a specific requested element number so the
        // background monitor can restore that same element if replay returns.
        requestedClipIndex: null,
        recordingDurationSeconds: null,
        // Server-issued token that changes when replay media is invalidated.
        // Keeping the video URL stable for a token lets the browser cache byte
        // ranges, while a new token prevents stale media reuse across sessions.
        replayMediaToken: "",
        sessionHalfwaySeconds: null,
        sessionInfoText: "",
        wantAutoplay: false,
        wantLoop: false,
        wantMenu: false,
        showTimerControl: true,
        loopArmed: false,
        uiRafId: null,
        holdPauseVisual: false,
        // Background monitor watches for replay becoming unavailable after the
        // page has already loaded a clip, e.g. when the operator hits Next.
        monitorTimerId: null,
        isPreparingContext: false,
        seekToken: 0,
        seekInFlight: false,
        stopAtClipEnd: true,
        showOutOfClipIndicator: false,
        showAllMode: false,
        stopwatchEnabled: false,
        stopwatchAnchorSeconds: null,
        isScrubbing: false,
        scrubPointerId: null,
        scrubResumePlayback: false,
        scrubPreviewTimeSeconds: null,
        suppressNextTimelineClick: false,
        lastSessionInfoLoadMs: 0
    };

    const panelTranslations = window.PANEL_I18N || {};
    const panelHostBridge = IS_PANEL_REPLAY_HOST && window.chrome && window.chrome.webview ? window.chrome.webview : null;
    const panelHostRequests = new Map();
    let panelHostRequestId = 0;
    let panelSettingsLanguage = "en";
    let panelSettingsConfig = {};

    panelHostBridge?.addEventListener("message", event => {
        const message = event.data || {};
        const pending = panelHostRequests.get(message.id);
        if (!pending) return;

        panelHostRequests.delete(message.id);
        if (message.ok) {
            pending.resolve(message.data);
        } else {
            pending.reject(new Error(message.error || "Host request failed"));
        }
    });

    dom.video.defaultMuted = true;
    dom.video.muted = true;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function readApiBase() {
        const params = new URLSearchParams(location.search || "");
        const raw = params.get("apiBase") ?? params.get("api");
        if (!raw) return "";
        return raw.trim().replace(/\/+$/, "");
    }

    function readPanelReplayHostFlag() {
        const params = new URLSearchParams(location.search || "");
        return params.get("panelReplay") === "true" || location.hostname === "panel-replay.local";
    }

    function postPanelHostRequest(action, payload = null) {
        if (!panelHostBridge) return null;

        const id = ++panelHostRequestId;
        const promise = new Promise((resolve, reject) => {
            panelHostRequests.set(id, { resolve, reject });
        });
        panelHostBridge.postMessage({ id, action, payload });
        return promise;
    }

    function waitForEvent(target, eventName, timeoutMs = 5000) {
        return new Promise(resolve => {
            let finished = false;

            function done() {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                target.removeEventListener(eventName, done);
                resolve();
            }

            const timer = setTimeout(done, timeoutMs);
            target.addEventListener(eventName, done, { once: true });
        });
    }

    async function fetchJson(path) {
        const hostResponse = postPanelHostRequest("apiGet", { path });
        if (hostResponse) {
            return await hostResponse;
        }

        const response = await fetch(BASE + path, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${response.status} ${await response.text()}`);
        }
        return response.json();
    }

    function setServerStatus(status) {
        if (!dom.panelServerStatusDot) return;
        dom.panelServerStatusDot.className = `replayPingDot ${status || "idle"}`;
    }

    function isFiniteNumber(value) {
        return Number.isFinite(Number(value));
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function parseStatus(status) {
        // Accept both camelCase and PascalCase so the page is tolerant of
        // serializer differences in backend responses.
        const rawClips = Array.isArray(status?.clips ?? status?.Clips)
            ? (status.clips ?? status.Clips)
            : [];

        const clips = rawClips
            .map(clip => ({
                index: Number(clip.index ?? clip.Index),
                startSeconds: Number(clip.startSeconds ?? clip.StartSeconds),
                endSeconds: Number(clip.endSeconds ?? clip.EndSeconds),
                everMarkedForReview: !!(clip.everMarkedForReview ?? clip.EverMarkedForReview)
            }))
            .filter(clip =>
                Number.isInteger(clip.index) &&
                clip.index > 0 &&
                Number.isFinite(clip.startSeconds) &&
                Number.isFinite(clip.endSeconds) &&
                clip.endSeconds > clip.startSeconds
            )
            .sort((a, b) => a.index - b.index);

        return {
            mode: String(status?.mode ?? status?.Mode ?? "").toLowerCase(),
            isRecording: !!(status?.isRecording ?? status?.IsRecording),
            recordingDurationSeconds: Number(status?.recordingDurationSeconds ?? status?.RecordingDurationSeconds),
            replayMediaToken: String(status?.replayMediaToken ?? status?.ReplayMediaToken ?? ""),
            clips
        };
    }

    function normalizeElementMeta(payload) {
        const next = {};
        const elements = payload && typeof payload === "object" ? payload.elements : null;
        if (!elements || typeof elements !== "object") {
            return next;
        }

        for (const [key, value] of Object.entries(elements)) {
            const index = Number(key);
            if (!Number.isInteger(index) || index <= 0) continue;

            const baseCode = value && typeof value === "object"
                ? String(value.base_code ?? "").trim()
                : "";
            const review = !!(value && typeof value === "object" && value.review);

            next[index] = { baseCode, review };
        }

        return next;
    }

    function readSessionInfoTimeSeconds(payload, propertyName) {
        const raw = payload && typeof payload === "object"
            ? String(payload[propertyName] ?? "").trim()
            : "";
        if (!raw) return null;

        if (!raw.includes(":")) {
            const seconds = Number(raw);
            return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
        }

        const parts = raw.split(":").map(part => Number(part));
        if (parts.some(part => !Number.isFinite(part) || part < 0)) return null;

        if (parts.length === 2) return (parts[0] * 60) + parts[1];
        if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        return null;
    }

    function readSessionInfoField(payload, propertyName) {
        if (!payload || typeof payload !== "object") return "";
        return String(payload[propertyName] ?? "").trim();
    }

    function buildSessionInfoText(payload) {
        const leftParts = [
            readSessionInfoField(payload, "categoryName"),
            readSessionInfoField(payload, "categoryDiscipline"),
            readSessionInfoField(payload, "categoryFlight"),
            readSessionInfoField(payload, "segmentName")
        ].filter(Boolean);

        const competitor = [
            readSessionInfoField(payload, "competitorFirstName"),
            readSessionInfoField(payload, "competitorLastName")
        ].filter(Boolean).join(" ");

        const leftText = leftParts.join(" / ");
        if (leftText && competitor) return `${leftText} - ${competitor}`;
        return leftText || competitor;
    }

    function updateSessionInfoBar() {
        const emptyStateActive = Boolean(dom.emptyState && !dom.emptyState.classList.contains("hidden"));
        const text = emptyStateActive ? "" : (state.sessionInfoText || "");
        if (dom.panelSessionInfoText) {
            dom.panelSessionInfoText.textContent = text;
        }
        if (dom.panelSessionInfo) {
            dom.panelSessionInfo.classList.toggle("hidden", !IS_PANEL_REPLAY_HOST && !(text || emptyStateActive));
        }
    }

    function readOptions() {
        const search = location.search || "";
        const params = new URLSearchParams(search);

        function readBooleanWithDefault(value, defaultValue) {
            if (value == null) return defaultValue;
            const normalized = String(value).trim().toLowerCase();
            if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y" || normalized === "on") {
                return true;
            }
            if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "n" || normalized === "off") {
                return false;
            }
            return defaultValue;
        }

        let clipIndex = 0;
        const shortForm = search.match(/^\?(\d+)(?:&|$)/);
        if (shortForm) {
            clipIndex = parseInt(shortForm[1], 10);
        }

        if (clipIndex == null) {
            const raw = params.get("clip") ?? params.get("c");
            if (raw && /^\d+$/.test(raw)) {
                clipIndex = parseInt(raw, 10);
            }
        }

        return {
            clipIndex,
            // Autoplay/loop default to on; users only need query params to turn
            // those behaviors off.
            autoplay: readBooleanWithDefault(params.get("autoplay") ?? params.get("ap") ?? params.get("a"), true),
            loop: readBooleanWithDefault(params.get("loop") ?? params.get("lp") ?? params.get("l"), true),
            timer: readBooleanWithDefault(params.get("timer") ?? params.get("tm"), false)
        };
    }

    function updateUrlClipIndex(index) {
        if (state.wantMenu) {
            history.replaceState(null, "", "?0");
            return;
        }

        if (!Number.isInteger(index) || index <= 0) return;

        const parts = [`?${index}`];
        if (!state.wantAutoplay) parts.push("autoplay=false");
        if (!state.wantLoop) parts.push("loop=false");
        const next = parts.join("&");
        history.replaceState(null, "", next);
    }

    function cleanupOldPanelMediaCache() {
        const request = postPanelHostRequest("cleanupMediaCache");
        if (request) {
            request.catch(() => { });
        }
    }

    function clearTimelineSurface() {
        if (dom.timelineTicks) dom.timelineTicks.innerHTML = "";
        if (dom.timelineLabels) dom.timelineLabels.innerHTML = "";
        if (dom.elementMarkers) dom.elementMarkers.innerHTML = "";
        dom.playhead?.classList.add("hidden");
        dom.playhead?.classList.remove("isOutOfClip", ...STOPWATCH_PLAYHEAD_CLASSES);
        if (dom.relativeIndicator) {
            dom.relativeIndicator.classList.add("hidden");
            dom.relativeIndicator.classList.remove("isOutOfClip");
            dom.relativeIndicator.textContent = "";
        }
        hideOutOfClipIndicator();
        hideStopwatchVisuals(true);
    }

    function setEmptyState(active, message = EMPTY_STATE_NO_CLIPS) {
        const wasActive = !!dom.emptyState && !dom.emptyState.classList.contains("hidden");
        if (dom.emptyStateMessage) {
            dom.emptyStateMessage.textContent = message;
        }
        if (dom.emptyState) {
            dom.emptyState.classList.toggle("hidden", !active);
        }
        updateSessionInfoBar();
        if (active) {
            // Drop any currently loaded media immediately so an old frame cannot
            // linger on screen while the session is back in record mode.
            clearVideoSource();
            clearTimelineSurface();
            if (!wasActive) {
                cleanupOldPanelMediaCache();
            }
        }
        requestAnimationFrame(layoutVideoArea);
    }

    function clearVideoSource() {
        if (!dom.video) return;
        stopUiTicker();
        state.holdPauseVisual = false;
        clearStopwatch();
        state.isScrubbing = false;
        state.scrubPointerId = null;
        state.scrubResumePlayback = false;
        state.scrubPreviewTimeSeconds = null;
        state.showOutOfClipIndicator = false;
        state.suppressNextTimelineClick = false;
        dom.video.pause();
        // Invalidate any in-flight seek continuation from the previous asset.
        state.seekToken++;
        dom.video.removeAttribute("src");
        dom.video.load();
        setPlayPauseVisual(false);
        updateButtonDisabledState(false);
    }

    function loadFreshVideoSource() {
        return loadFreshVideoSourceAsync();
    }

    async function loadFreshVideoSourceAsync() {
        if (!dom.video) return;
        dom.video.pause();
        if (!state.replayMediaToken) return;
        const mediaCache = postPanelHostRequest("cacheMedia", { token: state.replayMediaToken });
        if (mediaCache) {
            const cached = await mediaCache;
            dom.video.src = `${cached.url}?v=${encodeURIComponent(state.replayMediaToken)}`;
            dom.video.load();
            return;
        }

        // Tokenized URL gives us the best of both worlds:
        // - stable URL within one replay session, so the browser can reuse
        //   already fetched byte ranges
        // - different URL across sessions, so old competitor media is never
        //   treated as current
        dom.video.src = `${BASE}/api/recording/file?kind=low-res&v=${encodeURIComponent(state.replayMediaToken)}`;
        dom.video.load();
    }

    function layoutVideoArea() {
        // Explicitly size the video row from the available space instead of
        // letting the video element grow freely. This keeps the timeline in its
        // own row even in very small windows.
        const { topRow, videoPane, timelineArea, transportRow, elementRail } = dom;
        if (!topRow || !videoPane || !timelineArea || !transportRow) return;

        const topRowStyles = getComputedStyle(topRow);
        const isMenuVisible = state.wantMenu && !elementRail?.classList.contains("hidden");
        const columnGap = parseFloat(topRowStyles.columnGap || "0") || 0;
        const railWidth = isMenuVisible
            ? (elementRail?.getBoundingClientRect().width || parseFloat(getComputedStyle(elementRail).width || "0") || 0)
            : 0;

        const totalWidth = topRow.clientWidth || topRow.getBoundingClientRect().width || 0;
        const timelineHeight = timelineArea.offsetHeight || 32;
        const transportHeight = transportRow.offsetHeight || 150;
        const totalHeight = topRow.clientHeight || topRow.getBoundingClientRect().height || 0;
        const videoWidth = Math.max(0, totalWidth - railWidth - (isMenuVisible ? columnGap : 0));
        const availableVideoHeight = Math.max(
            120,
            totalHeight - timelineHeight - transportHeight
        );
        const idealVideoHeight = videoWidth > 0 ? (videoWidth * 9) / 16 : availableVideoHeight;
        const videoHeight = Math.max(120, Math.min(availableVideoHeight, idealVideoHeight));

        topRow.style.gridTemplateRows = `${Math.round(videoHeight)}px ${timelineHeight}px ${transportHeight}px`;
        videoPane.style.height = `${Math.round(videoHeight)}px`;

        if (elementRail) {
            elementRail.style.height = isMenuVisible ? `${Math.round(videoHeight)}px` : "";
        }
    }

    function formatRelativeOffset(seconds) {
        const raw = Number(seconds) || 0;
        const negative = raw < 0;
        const safe = Math.abs(raw);
        const totalWhole = Math.floor(safe);
        const minutes = Math.floor(totalWhole / 60);
        const secondsWhole = totalWhole - (minutes * 60);

        let hundredths = Math.floor((safe - totalWhole) * 100 + 1e-6);
        if (hundredths > 99) hundredths = 99;

        return `${negative ? "-" : ""}${minutes}:${String(secondsWhole).padStart(2, "0")}:${String(hundredths).padStart(2, "0")}`;
    }

    function formatSignedClipOffset(seconds) {
        const raw = Number(seconds) || 0;
        const sign = raw < 0 ? "-" : "+";
        const safe = Math.abs(raw);
        const totalWhole = Math.floor(safe);
        const minutes = Math.floor(totalWhole / 60);
        const secondsWhole = totalWhole - (minutes * 60);

        let hundredths = Math.floor((safe - totalWhole) * 100 + 1e-6);
        if (hundredths > 99) hundredths = 99;

        return `${sign}${String(minutes).padStart(2, "0")}:${String(secondsWhole).padStart(2, "0")}:${String(hundredths).padStart(2, "0")}`;
    }

    function formatStopwatchOffset(seconds) {
        const raw = Number(seconds) || 0;
        const negative = raw < 0;
        const safe = Math.abs(raw);
        const totalWhole = Math.floor(safe);
        const minutes = Math.floor(totalWhole / 60);
        const secondsWhole = totalWhole - (minutes * 60);

        let hundredths = Math.floor((safe - totalWhole) * 100 + 1e-6);
        if (hundredths > 99) hundredths = 99;

        const formatted = `${String(minutes).padStart(2, "0")}:${String(secondsWhole).padStart(2, "0")}:${String(hundredths).padStart(2, "0")}`;
        return negative ? `-${formatted}` : formatted;
    }

    function timelineMarkerInterval(durationSeconds) {
        const duration = Math.max(0, Number(durationSeconds) || 0);
        const candidates = TIMELINE_INTERVALS_SECONDS.map(interval => ({
            interval,
            count: Math.floor((duration / interval) + 1e-6) + 1
        }));
        return (
            candidates.find(candidate => candidate.count >= 6 && candidate.count <= 15) ??
            candidates.find(candidate => candidate.count <= 15) ??
            candidates[candidates.length - 1]
        ).interval;
    }

    function formatTimelineMarker(seconds, intervalSeconds) {
        const raw = Number(seconds) || 0;
        const safe = Math.abs(raw);

        if (intervalSeconds < 1) {
            return raw.toFixed(1);
        }

        if (intervalSeconds < 30) {
            return String(Math.round(raw));
        }

        const totalSeconds = Math.round(safe);
        const minutes = Math.floor(totalSeconds / 60);
        const secondsPart = totalSeconds % 60;
        return `${raw < 0 ? "-" : ""}${minutes}:${String(secondsPart).padStart(2, "0")}`;
    }

    function clipPercentForTime(timeSeconds, clip = state.clip) {
        if (!clip) return 0;

        const duration = Math.max(0, clip.endSeconds - clip.startSeconds);
        if (duration <= 0.001) return 0;

        const relative = clamp(Number(timeSeconds || 0) - clip.startSeconds, 0, duration);
        return relative / duration;
    }

    function buildShowAllClip() {
        const recordingEnd = maxRecordingTime();
        if (!Number.isFinite(recordingEnd) || recordingEnd <= END_EPS) {
            return null;
        }

        return {
            index: 0,
            startSeconds: 0,
            endSeconds: recordingEnd,
            everMarkedForReview: false
        };
    }

    function isShowAllClip(clip = state.clip) {
        return !!clip && Number(clip.index) === 0;
    }

    function firstAvailableClip() {
        return state.clips.slice().sort((a, b) => a.index - b.index)[0] ?? null;
    }

    function isHalfwayTimingActive() {
        return Number.isFinite(Number(state.sessionHalfwaySeconds)) &&
            Number(state.sessionHalfwaySeconds) > 0;
    }

    function refreshShowAllClipBounds() {
        if (!state.showAllMode) return;

        const showAllClip = buildShowAllClip();
        if (showAllClip) {
            state.clip = showAllClip;
        }
    }

    function clearStopwatch() {
        state.stopwatchEnabled = false;
        state.stopwatchAnchorSeconds = null;
        dom.stopwatchBtn?.classList.remove("isActive");
        dom.stopwatchBtn?.setAttribute("aria-pressed", "false");
        setStopwatchButtonText(false);
        syncTimingPresetButtons();
        hideStopwatchVisuals(true);
    }

    function applyTimerControlVisibility() {
        const visible = state.showTimerControl;
        dom.stopwatchBtn?.classList.toggle("isTimerControlHidden", !visible);
        dom.stopwatchBtn?.setAttribute("aria-hidden", visible ? "false" : "true");
        syncTimingPresetButtons();
        if (!visible) {
            clearStopwatch();
        }
        requestAnimationFrame(layoutVideoArea);
    }

    function setStopwatchButtonText(enabled) {
        const label = enabled ? "Timer Off" : "Timer On";
        dom.stopwatchBtn?.setAttribute("title", label);
        dom.stopwatchBtn?.setAttribute("aria-label", label);
    }

    function syncTimingPresetButtons() {
        const visible = state.showTimerControl && state.stopwatchEnabled;
        dom.timingPresetButtons?.classList.toggle("hidden", !visible);
        requestAnimationFrame(adjustTransportButtonOverlap);
    }

    function showBrandOverlay() {
        dom.brandOverlay?.classList.remove("hidden");
        dom.brandOverlay?.setAttribute("aria-hidden", "false");
    }

    function hideBrandOverlay() {
        dom.brandOverlay?.classList.add("hidden");
        dom.brandOverlay?.setAttribute("aria-hidden", "true");
    }

    function normalizePanelSettingsLanguage(value) {
        return value === "fr" ? "fr" : "en";
    }

    function panelSettingsText(key) {
        return panelTranslations[panelSettingsLanguage]?.[key] ?? panelTranslations.en?.[key] ?? key;
    }

    function setPanelSettingsStatus(textOrKey, kind = "", translate = false) {
        if (!dom.panelSettingsStatus) return;
        dom.panelSettingsStatus.textContent = translate ? panelSettingsText(textOrKey) : textOrKey;
        dom.panelSettingsStatus.className = `panelSettingsStatus ${kind}`.trim();
    }

    function applyPanelSettingsI18n() {
        dom.panelSettingsOverlay?.querySelectorAll("[data-panel-i18n]").forEach(element => {
            const key = element.getAttribute("data-panel-i18n");
            if (!key) return;
            element.textContent = panelSettingsText(key);
        });
        if (dom.panelSettingsLanguage) {
            dom.panelSettingsLanguage.value = panelSettingsLanguage;
            dom.panelSettingsLanguage.setAttribute("aria-label", panelSettingsText("languageSelectorAria"));
        }
    }

    function writePanelSettingsForm(config) {
        panelSettingsConfig = { ...config };
        panelSettingsLanguage = normalizePanelSettingsLanguage(config?.Language ?? "en");
        if (dom.panelSettingsServerIp) {
            dom.panelSettingsServerIp.value = String(config?.ServerIp ?? "127.0.0.1");
        }
        if (dom.panelSettingsTimerEnabled) {
            dom.panelSettingsTimerEnabled.checked = !!config?.TimerEnabled;
        }
        applyPanelSettingsI18n();
    }

    function readPanelSettingsForm() {
        return {
            ...panelSettingsConfig,
            ServerIp: dom.panelSettingsServerIp?.value.trim() || "127.0.0.1",
            TimerEnabled: !!dom.panelSettingsTimerEnabled?.checked,
            Language: panelSettingsLanguage
        };
    }

    async function loadPanelSettings() {
        setPanelSettingsStatus("loadingSettings", "", true);
        const hostResponse = postPanelHostRequest("loadConfig");
        if (hostResponse) {
            writePanelSettingsForm(await hostResponse);
            setPanelSettingsStatus("settingsLoaded", "ok", true);
            return;
        }

        const response = await fetch("/api/panelconfig", { cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        writePanelSettingsForm(await response.json());
        setPanelSettingsStatus("settingsLoaded", "ok", true);
    }

    async function savePanelSettings() {
        setPanelSettingsStatus("savingSettings", "", true);
        const config = readPanelSettingsForm();
        const hostResponse = postPanelHostRequest("saveConfig", config);
        if (hostResponse) {
            const saved = await hostResponse;
            writePanelSettingsForm(saved);
            applySavedPanelSettings(saved);
            setPanelSettingsStatus("settingsSaved", "ok", true);
            return;
        }

        const response = await fetch("/api/panelconfig", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        });
        if (!response.ok) throw new Error(await response.text());
        const saved = await response.json();
        writePanelSettingsForm(saved);
        applySavedPanelSettings(saved);
        setPanelSettingsStatus("settingsSaved", "ok", true);
    }

    function applySavedPanelSettings(config) {
        state.showTimerControl = !!config?.TimerEnabled;
        applyTimerControlVisibility();
    }

    function showPanelSettings() {
        dom.panelSettingsOverlay?.classList.remove("hidden");
        dom.panelSettingsOverlay?.setAttribute("aria-hidden", "false");
        applyPanelSettingsI18n();
        void loadPanelSettings().catch(error => {
            setPanelSettingsStatus(`${panelSettingsText("loadFailed")}: ${error?.message || error}`, "error");
        });
    }

    function hidePanelSettings() {
        dom.panelSettingsOverlay?.classList.add("hidden");
        dom.panelSettingsOverlay?.setAttribute("aria-hidden", "true");
        setPanelSettingsStatus("");
    }

    function adjustTransportButtonOverlap() {
        if (!dom.timingPresetButtons || !dom.transportButtons) return;

        dom.transportButtons.style.transform = "";

        if (dom.timingPresetButtons.classList.contains("hidden")) return;

        const presetRect = dom.timingPresetButtons.getBoundingClientRect();
        const transportRect = dom.transportButtons.getBoundingClientRect();
        const minGap = 6;
        const overlap = presetRect.right + minGap - transportRect.left;

        if (overlap > 0) {
            dom.transportButtons.style.transform = `translateX(${Math.ceil(overlap)}px)`;
        }
    }

    function setStopwatchPlayheadState(nextClass = null) {
        dom.playhead?.classList.remove(...STOPWATCH_PLAYHEAD_CLASSES);
        if (nextClass) {
            dom.playhead?.classList.add(nextClass);
        }
    }

    function hideStopwatchVisuals(resetIndicatorText = false) {
        setStopwatchPlayheadState();
        dom.stopwatchRange?.classList.add("hidden");
        dom.stopwatchRange?.classList.remove("isPositive", "isNegative");
        dom.stopwatchMarker?.classList.add("hidden");
        dom.stopwatchIndicator?.classList.add("hidden");
        if (resetIndicatorText && dom.stopwatchIndicator) {
            dom.stopwatchIndicator.textContent = "00:00:00";
        }
    }

    function hideOutOfClipIndicator() {
        dom.outOfClipIndicator?.classList.add("hidden");
        dom.outOfClipIndicator?.classList.remove("isBeforeClip", "isAfterClip");
    }

    function syncOutOfClipIndicator(current, clip, shouldShow) {
        if (!shouldShow || !dom.outOfClipIndicator || !clip || isShowAllClip(clip)) {
            hideOutOfClipIndicator();
            return;
        }

        if (current < clip.startSeconds - END_EPS) {
            dom.outOfClipIndicator.textContent = formatSignedClipOffset(current - clip.startSeconds);
            dom.outOfClipIndicator.classList.remove("hidden", "isAfterClip");
            dom.outOfClipIndicator.classList.add("isBeforeClip");
            return;
        }

        if (current > clip.endSeconds + END_EPS) {
            dom.outOfClipIndicator.textContent = formatSignedClipOffset(current - clip.endSeconds);
            dom.outOfClipIndicator.classList.remove("hidden", "isBeforeClip");
            dom.outOfClipIndicator.classList.add("isAfterClip");
            return;
        }

        hideOutOfClipIndicator();
    }

    function pausePlaybackForScrub() {
        dom.video.pause();
        state.holdPauseVisual = false;
        stopUiTicker();
        setPlayPauseVisual(false);
    }

    function timelineTimeFromClientX(clientX) {
        const clip = state.clip;
        if (!clip) return null;

        const rect = dom.timelineArea.getBoundingClientRect();
        if (rect.width <= 0) return null;

        const x = clamp(clientX - rect.left, 0, rect.width);
        const percent = x / rect.width;
        const duration = clip.endSeconds - clip.startSeconds;
        return clip.startSeconds + (percent * duration);
    }

    function applyScrubPreview(targetTime) {
        const clip = state.clip;
        if (!clip) return;

        const clamped = clampToRecordingBounds(targetTime);
        state.scrubPreviewTimeSeconds = clamped;
        state.stopAtClipEnd = clamped <= clip.endSeconds - END_EPS;

        if (Math.abs((dom.video.currentTime || 0) - clamped) > 0.01) {
            dom.video.currentTime = clamped;
        }

        syncVideoUI();
    }

    function beginTimelineScrub(event) {
        if (!state.clip || event.button !== 0) return;

        state.seekToken++;
        state.seekInFlight = false;
        state.isScrubbing = true;
        state.scrubPointerId = event.pointerId;
        state.scrubResumePlayback = !dom.video.paused;
        state.suppressNextTimelineClick = true;
        pausePlaybackForScrub();
        dom.timelineArea.setPointerCapture?.(event.pointerId);

        const targetTime = timelineTimeFromClientX(event.clientX);
        if (targetTime != null) {
            applyScrubPreview(targetTime);
        }

        event.preventDefault();
    }

    async function endTimelineScrub(event) {
        if (!state.isScrubbing || event.pointerId !== state.scrubPointerId) return;

        dom.timelineArea.releasePointerCapture?.(event.pointerId);

        const finalTime = Number.isFinite(state.scrubPreviewTimeSeconds)
            ? Number(state.scrubPreviewTimeSeconds)
            : Number(dom.video.currentTime || 0);
        const resumePlayback = state.scrubResumePlayback;

        state.isScrubbing = false;
        state.scrubPointerId = null;
        state.scrubResumePlayback = false;

        try {
            await goToTime(finalTime, resumePlayback);
        } finally {
            state.scrubPreviewTimeSeconds = null;
            window.setTimeout(() => {
                state.suppressNextTimelineClick = false;
            }, 0);
            syncVideoUI();
        }
    }

    function toggleStopwatch() {
        if (!state.clip) return;

        if (state.stopwatchEnabled) {
            clearStopwatch();
            syncVideoUI();
            return;
        }

        state.stopwatchEnabled = true;
        state.stopwatchAnchorSeconds = Number(dom.video.currentTime || 0);
        dom.stopwatchBtn?.classList.add("isActive");
        dom.stopwatchBtn?.setAttribute("aria-pressed", "true");
        setStopwatchButtonText(true);
        syncTimingPresetButtons();
        setStopwatchPlayheadState("isStopwatchPending");

        if (!dom.video.paused) {
            pausePlaybackForScrub();
        }

        syncVideoUI();
    }

    function applyReplayStatus(parsed) {
        state.recordingDurationSeconds = Number.isFinite(parsed.recordingDurationSeconds)
            ? parsed.recordingDurationSeconds
            : null;
        state.replayMediaToken = String(parsed.replayMediaToken ?? "");
        state.clips = parsed.clips;
        state.clipMap = new Map(state.clips.map(clip => [clip.index, clip]));
        refreshShowAllClipBounds();
    }

    function clipsSignature(clips = state.clips) {
        return JSON.stringify((clips || []).map(clip => ({
            index: Number(clip.index),
            startSeconds: Math.round(Number(clip.startSeconds || 0) * 1000),
            endSeconds: Math.round(Number(clip.endSeconds || 0) * 1000),
            everMarkedForReview: !!clip.everMarkedForReview
        })));
    }

    function resolveTargetClip(requestedClipIndex) {
        if (!state.clips.length) return null;
        if (state.wantMenu) {
            return Number(requestedClipIndex) > 0
                ? state.clipMap.get(requestedClipIndex) ?? firstAvailableClip()
                : firstAvailableClip();
        }
        return state.clipMap.get(requestedClipIndex) ?? null;
    }

    async function activateShowAllView(options = {}) {
        const showAllClip = buildShowAllClip();
        if (!showAllClip) return;

        state.showAllMode = true;
        state.selectedClipIndex = null;
        state.clip = showAllClip;
        drawTimeline();
        renderRail();
        clearStopwatch();

        const shouldAutoplay = options.autoplay ?? !dom.video.paused;
        state.loopArmed = false;
        await goToTime(showAllClip.startSeconds, shouldAutoplay);
    }

    async function startFirstClipInMenuMode() {
        if (!state.wantMenu || !state.clips.length) return;
        const firstClip = firstAvailableClip();
        if (!firstClip) return;

        state.showAllMode = false;
        state.selectedClipIndex = firstClip.index;
        state.clip = firstClip;
        state.loopArmed = false;
        drawTimeline();
        renderRail();
        await goToTime(firstClip.startSeconds, false);
    }

    async function waitForReplayContext(clipIndex) {
        // Startup wait loop: stay on the empty screen until the host has
        // finished recording, entered replay mode, and exposed clips.
        while (true) {
            try {
                const parsed = parseStatus(await fetchJson("/api/status"));
                setServerStatus("green");

                if (parsed.mode === "replay" && !parsed.isRecording) {
                    applyReplayStatus(parsed);
                    renderRail();

                    if (!state.clips.length) {
                        state.clip = null;
                        setEmptyState(true, EMPTY_STATE_NO_CLIPS);
                        await sleep(REPLAY_POLL_INTERVAL_MS);
                        continue;
                    }

                    const clip = resolveTargetClip(clipIndex);
                    if (clip) {
                        state.showAllMode = false;
                        state.selectedClipIndex = null;
                        setEmptyState(false);
                        return {
                            clip,
                            clips: state.clips,
                            recordingDurationSeconds: state.recordingDurationSeconds
                        };
                    }

                    setEmptyState(true, EMPTY_STATE_SELECTED_CLIP_MISSING);
                    await sleep(REPLAY_POLL_INTERVAL_MS);
                    continue;
                }
            } catch {
                setServerStatus("red");
                state.clip = null;
                state.clips = [];
                state.clipMap = new Map();
                state.replayMediaToken = "";
                renderRail();
                setEmptyState(true, EMPTY_STATE_WAITING_FOR_SERVER);
                await sleep(REPLAY_POLL_INTERVAL_MS);
                continue;
            }

            state.clip = null;
            state.clips = [];
            state.clipMap = new Map();
            state.replayMediaToken = "";
            renderRail();
            setEmptyState(true, EMPTY_STATE_NO_CLIPS);
            await sleep(REPLAY_POLL_INTERVAL_MS);
        }
    }

    async function pollReplayAvailabilityOnce() {
        if (state.isPreparingContext) return;

        try {
            const parsed = parseStatus(await fetchJson("/api/status"));
            setServerStatus("green");

            if (parsed.mode !== "replay" || parsed.isRecording || !parsed.clips.length) {
                // As soon as the operator leaves replay mode, clear the client
                // back to the blue waiting screen instead of freezing the last
                // decoded frame.
                state.clip = null;
                state.clips = [];
                state.clipMap = new Map();
                state.replayMediaToken = "";
                renderRail();
                setEmptyState(true, EMPTY_STATE_NO_CLIPS);
                return;
            }

            const replayTokenChanged = parsed.replayMediaToken !== state.replayMediaToken;
            const clipsChanged = clipsSignature(parsed.clips) !== clipsSignature();
            applyReplayStatus(parsed);
            await loadSessionInfo(replayTokenChanged);
            const fallbackIndex = state.wantMenu ? (state.selectedClipIndex ?? 0) : state.requestedClipIndex;
            const targetClip = resolveTargetClip(fallbackIndex);

            if (!targetClip) {
                state.clip = null;
                renderRail();
                setEmptyState(true, EMPTY_STATE_SELECTED_CLIP_MISSING);
                return;
            }

            const isCurrentlyEmpty = !dom.emptyState || !dom.emptyState.classList.contains("hidden");
            const currentClipIndex = state.clip?.index ?? null;

            if (isCurrentlyEmpty) {
                // Replay has become available again after an empty period.
                state.isPreparingContext = true;
                try {
                    state.showAllMode = false;
                    state.selectedClipIndex = null;
                    state.clip = targetClip;
                    renderRail();
                    await prepareVideo();
                    await startFirstClipInMenuMode();
                    setEmptyState(false);
                } finally {
                    state.isPreparingContext = false;
                }
                return;
            }

            if (state.showAllMode) {
                refreshShowAllClipBounds();
                renderRail();
                if (clipsChanged) {
                    drawTimeline();
                } else {
                    syncVideoUI();
                }
                return;
            }

            if (currentClipIndex != null && state.clipMap.has(currentClipIndex)) {
                state.clip = state.clipMap.get(currentClipIndex) ?? targetClip;
                renderRail();
                if (clipsChanged) {
                    drawTimeline();
                } else {
                    syncVideoUI();
                }
                return;
            }

            state.isPreparingContext = true;
            try {
                state.showAllMode = false;
                state.selectedClipIndex = null;
                state.clip = targetClip;
                renderRail();
                await prepareVideo();
                await startFirstClipInMenuMode();
                setEmptyState(false);
            } finally {
                state.isPreparingContext = false;
            }
        } catch {
            setServerStatus("red");
            state.clip = null;
            state.clips = [];
            state.clipMap = new Map();
            state.replayMediaToken = "";
            renderRail();
            setEmptyState(true, EMPTY_STATE_WAITING_FOR_SERVER);
        }
    }

    function startReplayMonitor() {
        if (state.monitorTimerId != null) {
            clearInterval(state.monitorTimerId);
        }

        // Lightweight heartbeat keeps the remote client aligned with the host
        // session after initial load.
        state.monitorTimerId = window.setInterval(() => {
            void pollReplayAvailabilityOnce();
        }, REPLAY_POLL_INTERVAL_MS);
    }

    async function loadSessionInfo(force = false) {
        const now = Date.now();
        if (!force && now - state.lastSessionInfoLoadMs < SESSION_INFO_POLL_INTERVAL_MS) {
            return;
        }

        state.lastSessionInfoLoadMs = now;
        try {
            const payload = await fetchJson(`/api/sessionInfo?ts=${now}`);
            state.elementMeta = normalizeElementMeta(payload);
            state.sessionInfoText = buildSessionInfoText(payload);
            const halfwaySeconds = readSessionInfoTimeSeconds(payload, "segmentProgHalfTime");
            state.sessionHalfwaySeconds = Number.isFinite(halfwaySeconds) && halfwaySeconds > 0
                ? halfwaySeconds
                : null;
        } catch {
            state.elementMeta = {};
            state.sessionHalfwaySeconds = null;
            state.sessionInfoText = "";
        }

        updateSessionInfoBar();
    }

    function maxRecordingTime() {
        const candidates = [];

        if (isFiniteNumber(state.recordingDurationSeconds) && Number(state.recordingDurationSeconds) > 0) {
            candidates.push(Number(state.recordingDurationSeconds));
        }

        if (Number.isFinite(dom.video.duration) && dom.video.duration > 0) {
            candidates.push(dom.video.duration);
        }

        const maxClipEnd = state.clips.reduce((max, clip) => Math.max(max, Number(clip.endSeconds) || 0), 0);
        if (maxClipEnd > 0) {
            candidates.push(maxClipEnd);
        }

        if (!candidates.length) return null;
        return Math.max(...candidates);
    }

    function clampToRecordingBounds(timeSeconds) {
        const maxTime = maxRecordingTime();
        if (!Number.isFinite(maxTime)) {
            return Math.max(0, Number(timeSeconds) || 0);
        }

        return clamp(Number(timeSeconds) || 0, 0, Math.max(0, maxTime - END_EPS));
    }

    function bufferedEnough(timeSeconds, minAheadSeconds = 0.35) {
        const ranges = dom.video.buffered;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges.start(i) <= timeSeconds + 0.02 && ranges.end(i) >= timeSeconds + minAheadSeconds) {
                return true;
            }
        }
        return false;
    }

    function setPlayPauseVisual(isPlaying) {
        dom.playPause.title = isPlaying ? "Pause" : "Play";
        dom.playPause.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
        dom.playPause?.classList.toggle("isPause", isPlaying);
        dom.playPause?.classList.toggle("isPlay", !isPlaying);
    }

    function isForwardPlaying() {
        return !!dom.video && !dom.video.paused && !dom.video.ended;
    }

    function stopUiTicker() {
        if (state.uiRafId != null) {
            cancelAnimationFrame(state.uiRafId);
            state.uiRafId = null;
        }
    }

    function startUiTicker() {
        if (state.uiRafId != null) return;

        const tick = () => {
            state.uiRafId = null;
            syncVideoUI();

            if (isForwardPlaying() || state.seekInFlight) {
                state.uiRafId = requestAnimationFrame(tick);
            }
        };

        state.uiRafId = requestAnimationFrame(tick);
    }

    function isOutsideClip(currentTime, clip = state.clip) {
        if (!clip) return false;
        const time = Number(currentTime || 0);
        return time < clip.startSeconds - END_EPS || time > clip.endSeconds + END_EPS;
    }

    function syncVideoUI() {
        refreshShowAllClipBounds();
        const clip = state.clip;
        const isPlaying = state.holdPauseVisual || isForwardPlaying();
        setPlayPauseVisual(isPlaying);

        if (!clip) {
            state.selectedClipIndex = null;
            clearTimelineSurface();
            return;
        }

        dom.playhead?.classList.remove("hidden");
        dom.relativeIndicator?.classList.remove("hidden");
        const current = Number.isFinite(state.scrubPreviewTimeSeconds) && (state.isScrubbing || state.seekInFlight)
            ? Number(state.scrubPreviewTimeSeconds)
            : Number(dom.video.currentTime || 0);
        const duration = Math.max(0, clip.endSeconds - clip.startSeconds);
        const actualOutsideClip = isShowAllClip(clip) ? false : isOutsideClip(current, clip);
        if (!actualOutsideClip) {
            state.showOutOfClipIndicator = false;
        }

        const outsideClip = actualOutsideClip && state.showOutOfClipIndicator;
        dom.playhead.classList.toggle("isOutOfClip", outsideClip);

        if (duration <= 0.001) {
            dom.playhead.style.left = "0%";
            if (dom.relativeIndicator) {
                dom.relativeIndicator.textContent = "0:00:00";
                dom.relativeIndicator.classList.remove("isOutOfClip");
            }
            hideOutOfClipIndicator();
            hideStopwatchVisuals();
            return;
        }

        if (dom.relativeIndicator) {
            dom.relativeIndicator.textContent = formatRelativeOffset(current);
            dom.relativeIndicator.classList.remove("isOutOfClip");
        }
        syncOutOfClipIndicator(current, clip, outsideClip);
        const playheadPercent = clipPercentForTime(current, clip);
        dom.playhead.style.left = `${playheadPercent * 100}%`;

        if (state.stopwatchEnabled && Number.isFinite(state.stopwatchAnchorSeconds)) {
            const markerPercent = clipPercentForTime(state.stopwatchAnchorSeconds, clip);
            const elapsed = current - Number(state.stopwatchAnchorSeconds);
            const rangeLeftPercent = Math.min(markerPercent, playheadPercent);
            const rangeWidthPercent = Math.abs(playheadPercent - markerPercent);

            if (elapsed > 0.001) {
                setStopwatchPlayheadState("isStopwatchPositive");
            } else if (elapsed < -0.001) {
                setStopwatchPlayheadState("isStopwatchNegative");
            } else {
                setStopwatchPlayheadState("isStopwatchPending");
            }

            if (dom.stopwatchRange) {
                dom.stopwatchRange.classList.remove("hidden", "isPositive", "isNegative");
                dom.stopwatchRange.classList.add(elapsed >= 0 ? "isPositive" : "isNegative");
                dom.stopwatchRange.style.left = `${rangeLeftPercent * 100}%`;
                dom.stopwatchRange.style.width = `${rangeWidthPercent * 100}%`;
            }

            if (dom.stopwatchMarker) {
                dom.stopwatchMarker.classList.remove("hidden");
                dom.stopwatchMarker.style.left = `${markerPercent * 100}%`;
            }

            if (dom.stopwatchIndicator) {
                dom.stopwatchIndicator.classList.remove("hidden");
                dom.stopwatchIndicator.textContent = formatStopwatchOffset(elapsed);
                dom.stopwatchIndicator.style.left = `${playheadPercent * 100}%`;
            }
        } else {
            hideStopwatchVisuals();
        }
    }

    function drawTimeline() {
        dom.timelineTicks.innerHTML = "";
        dom.timelineLabels.innerHTML = "";
        if (dom.elementMarkers) {
            dom.elementMarkers.innerHTML = "";
        }

        refreshShowAllClipBounds();

        const clip = state.clip;
        if (!clip) {
            clearTimelineSurface();
            return;
        }

        dom.playhead?.classList.remove("hidden");
        dom.relativeIndicator?.classList.remove("hidden");
        const duration = Math.max(0, clip.endSeconds - clip.startSeconds);
        if (duration <= 0.001) {
            syncVideoUI();
            return;
        }

        const interval = timelineMarkerInterval(duration);
        const timelineOrigin = 0;
        const firstMarker = timelineOrigin + (Math.ceil((0 - timelineOrigin) / interval) * interval);

        if (dom.elementMarkers && isShowAllClip(clip)) {
            for (const elementClip of state.clips) {
                const start = Number(elementClip.startSeconds);
                const end = Number(elementClip.endSeconds);
                const index = Number(elementClip.index);
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(index)) continue;

                const marker = document.createElement("div");
                const leftPercent = (clamp(start, 0, duration) / duration) * 100;
                const rightPercent = (clamp(end, 0, duration) / duration) * 100;
                const meta = getClipMeta(index);

                marker.className = `elementMarker${meta.review ? " isReview" : ""}`;
                marker.style.left = `${leftPercent}%`;
                marker.style.width = `${Math.max(0.1, rightPercent - leftPercent)}%`;
                marker.textContent = String(index);
                dom.elementMarkers.appendChild(marker);
            }
        }

        for (let t = Math.max(0, firstMarker); t <= duration + 0.001; t += interval) {
            const percent = (t / duration) * 100;

            const tick = document.createElement("div");
            tick.className = "tick big";
            tick.style.left = `${percent}%`;
            dom.timelineTicks.appendChild(tick);

            const label = document.createElement("div");
            label.className = "tickLabel";
            label.style.left = `${percent}%`;
            const labelSeconds = t - timelineOrigin;
            label.textContent = formatTimelineMarker(labelSeconds, interval);
            dom.timelineLabels.appendChild(label);
        }

        syncVideoUI();
    }

    function updateButtonDisabledState(enabled) {
        dom.stopwatchBtn.disabled = !enabled || !state.showTimerControl;
        dom.timingPresetButtons?.querySelectorAll("button").forEach(button => {
            button.disabled = !enabled;
        });
        dom.playPause.disabled = !enabled;
        dom.rew10.disabled = !enabled;
        dom.rew3.disabled = !enabled;
        dom.fwd3.disabled = !enabled;
        dom.fwd10.disabled = !enabled;
    }

    function getClipMeta(index) {
        const meta = state.elementMeta[index] ?? null;
        return {
            baseCode: String(meta?.baseCode ?? "").trim(),
            review: !!meta?.review
        };
    }

    function scrollSelectedRailIntoView() {
        const selected = dom.elementRail.querySelector(".elementRailButton[aria-pressed='true']");
        selected?.scrollIntoView({ block: "nearest" });
    }

    function renderRail() {
        dom.elementRail.innerHTML = "";
        dom.elementRail.classList.toggle("hidden", !state.wantMenu);
        dom.shell.classList.toggle("withMenu", state.wantMenu);
        updateSessionInfoBar();

        if (!state.wantMenu) return;

        for (let index = 1; index <= RAIL_ELEMENT_ROWS; index++) {
            const clip = state.clipMap.get(index);
            if (!clip) {
                const placeholder = document.createElement("div");
                placeholder.className = "elementRailPlaceholder";
                dom.elementRail.appendChild(placeholder);
                continue;
            }

            const meta = getClipMeta(clip.index);
            const button = document.createElement("button");
            button.type = "button";
            button.className = `elementRailButton${meta.review ? " isReview" : ""}`;
            button.dataset.clipIndex = String(clip.index);
            button.setAttribute("aria-pressed", state.selectedClipIndex === clip.index ? "true" : "false");

            const num = document.createElement("div");
            num.className = "elementRailNum";
            num.textContent = String(clip.index);

            const info = document.createElement("div");
            info.className = "elementRailInfo";

            const code = document.createElement("div");
            code.className = "elementRailCode";
            code.textContent = meta.baseCode || "[ element ]";

            info.appendChild(code);
            button.appendChild(num);
            button.appendChild(info);
            dom.elementRail.appendChild(button);
        }

        const showAllClip = buildShowAllClip();
        if (!showAllClip) {
            const placeholder = document.createElement("div");
            placeholder.className = "elementRailPlaceholder";
            dom.elementRail.appendChild(placeholder);
            scrollSelectedRailIntoView();
            requestAnimationFrame(layoutVideoArea);
            return;
        }

        const entireButton = document.createElement("button");
        entireButton.type = "button";
        entireButton.className = "elementRailButton elementRailEntireButton";
        entireButton.dataset.showAll = "true";
        entireButton.setAttribute("aria-pressed", state.showAllMode ? "true" : "false");

        const entireInfo = document.createElement("div");
        entireInfo.className = "elementRailInfo";

        const entireCode = document.createElement("div");
        entireCode.className = "elementRailCode";
        entireCode.textContent = ENTIRE_RECORDING_LABEL;

        entireInfo.appendChild(entireCode);
        entireButton.appendChild(entireInfo);
        dom.elementRail.appendChild(entireButton);

        scrollSelectedRailIntoView();
        requestAnimationFrame(layoutVideoArea);
    }

    function startPlayback() {
        if (state.clip) {
            const current = Number(dom.video.currentTime || 0);
            state.stopAtClipEnd = current <= state.clip.endSeconds - END_EPS;
        }

        state.holdPauseVisual = false;
        const playPromise = dom.video.play();
        setPlayPauseVisual(true);
        startUiTicker();

        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {
                state.holdPauseVisual = false;
                syncVideoUI();
            });
        }
    }

    async function goToTime(targetTime, keepPlaying = !dom.video.paused, options = {}) {
        const clip = state.clip;
        if (!clip) return;

        const preservePlayingVisual = !!options.preservePlayingVisual;
        const clamped = clampToRecordingBounds(targetTime);
        const token = ++state.seekToken;
        const needSeek = Math.abs((dom.video.currentTime || 0) - clamped) > 0.01;

        state.seekInFlight = true;
        state.scrubPreviewTimeSeconds = clamped;
        state.stopAtClipEnd = clamped <= clip.endSeconds - END_EPS;
        state.showOutOfClipIndicator = !!options.allowOutOfClipIndicator && !isShowAllClip(clip) && isOutsideClip(clamped, clip);
        state.holdPauseVisual = keepPlaying && preservePlayingVisual;
        dom.video.pause();
        if (!state.holdPauseVisual) {
            setPlayPauseVisual(false);
        }
        startUiTicker();

        if (needSeek) {
            dom.video.currentTime = clamped;
            await waitForEvent(dom.video, "seeked", 1200);
            // Ignore stale completions when another seek started after this one.
            if (token !== state.seekToken) return;
        }

        if (keepPlaying) {
            const bufferWaitStarted = Date.now();
            while (!bufferedEnough(clamped, 0.35) && Date.now() - bufferWaitStarted < 800) {
                await sleep(50);
                if (token !== state.seekToken) return;
            }

            if (state.loopArmed && state.stopAtClipEnd && (dom.video.currentTime || 0) >= clip.endSeconds - END_EPS) {
                dom.video.currentTime = clip.startSeconds;
            }

            startPlayback();
        } else {
            state.holdPauseVisual = false;
            setPlayPauseVisual(false);
        }

        if (token === state.seekToken) {
            state.seekInFlight = false;
            state.scrubPreviewTimeSeconds = null;
        }
        syncVideoUI();
    }

    async function applyTimingPreset(seconds) {
        if (!state.stopwatchEnabled || !Number.isFinite(state.stopwatchAnchorSeconds)) return;

        await goToTime(Number(state.stopwatchAnchorSeconds) + seconds, false, { allowOutOfClipIndicator: true });
    }

    async function selectClipByIndex(index, options = {}) {
        const targetClip = state.clipMap.get(index);
        if (!targetClip) return;

        if (state.wantMenu) {
            state.showAllMode = false;
            state.selectedClipIndex = index;
            state.clip = targetClip;
            state.loopArmed = false;
            drawTimeline();
            renderRail();
            clearStopwatch();
            await goToTime(targetClip.startSeconds, options.autoplay ?? true);
            return;
        }

        state.showAllMode = false;
        state.selectedClipIndex = index;
        state.clip = targetClip;
        drawTimeline();
        renderRail();
        updateUrlClipIndex(index);
        clearStopwatch();

        const shouldAutoplay = options.autoplay ?? state.wantAutoplay;
        await goToTime(targetClip.startSeconds, shouldAutoplay);
    }

    function togglePlayPause() {
        const clip = state.clip;
        if (!clip) return;

        const recordingMax = maxRecordingTime();
        const current = Number(dom.video.currentTime || 0);
        const atRecordingEnd = Number.isFinite(recordingMax) && current >= recordingMax - END_EPS;

        if (dom.video.paused) {
            if (atRecordingEnd || (state.stopAtClipEnd && current >= clip.endSeconds - END_EPS)) {
                void goToTime(clip.startSeconds, true);
                return;
            }

            dom.video.playbackRate = 1.0;
            state.stopAtClipEnd = current <= clip.endSeconds - END_EPS;
            startPlayback();
        } else {
            dom.video.pause();
            state.holdPauseVisual = false;
            stopUiTicker();
            setPlayPauseVisual(false);
            state.loopArmed = false;
        }

        syncVideoUI();
    }

    function targetElementFromShortcut(event) {
        const codeMap = {
            Digit1: 1,
            Digit2: 2,
            Digit3: 3,
            Digit4: 4,
            Digit5: 5,
            Digit6: 6,
            Digit7: 7,
            Digit8: 8,
            Digit9: 9,
            Digit0: 10,
            Minus: 11,
            Equal: 12,
            Numpad1: 1,
            Numpad2: 2,
            Numpad3: 3,
            Numpad4: 4,
            Numpad5: 5,
            Numpad6: 6,
            Numpad7: 7,
            Numpad8: 8,
            Numpad9: 9,
            Numpad0: 10
        };

        return codeMap[event.code] ?? null;
    }

    function handlePanelShortcut(event) {
        if (event.defaultPrevented) return;
        if (event.repeat) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;

        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target && (
            target.isContentEditable ||
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT"
        )) {
            return;
        }

        if (event.code === "Space") {
            if (dom.playPause?.disabled) return;
            event.preventDefault();
            togglePlayPause();
            return;
        }

        if (event.code === "KeyT") {
            if (!state.showTimerControl || dom.stopwatchBtn?.disabled) return;
            event.preventDefault();
            toggleStopwatch();
            return;
        }

        const elementIndex = targetElementFromShortcut(event);
        if (!Number.isInteger(elementIndex) || elementIndex <= 0) return;

        const clip = state.clipMap.get(elementIndex);
        if (!clip) return;

        event.preventDefault();
        void selectClipByIndex(elementIndex, { autoplay: true });
    }

    async function prepareVideo() {
        refreshShowAllClipBounds();
        const clip = state.clip;
        if (!clip) return;

        await loadFreshVideoSource();
        requestAnimationFrame(layoutVideoArea);

        if (dom.video.readyState < 1) {
            await waitForEvent(dom.video, "loadedmetadata", 5000);
        }

        if (!Number.isFinite(state.recordingDurationSeconds) && Number.isFinite(dom.video.duration)) {
            state.recordingDurationSeconds = dom.video.duration;
        }

        dom.video.pause();
        dom.video.playbackRate = 1.0;
        drawTimeline();
        updateButtonDisabledState(true);
        state.loopArmed = state.wantMenu ? false : state.wantLoop;
        state.stopAtClipEnd = true;

        // Prime the player at the clip start so transport state, playhead, and
        // the clip-relative time indicator all begin in sync.
        await goToTime(clip.startSeconds, false);

        const bufferWaitStarted = Date.now();
        while (!bufferedEnough(clip.startSeconds, 0.75) && Date.now() - bufferWaitStarted < 4000) {
            await sleep(100);
        }

        updateButtonDisabledState(true);

        if (state.wantAutoplay) {
            startPlayback();
        } else {
            setPlayPauseVisual(false);
        }

        syncVideoUI();
    }

    dom.video.addEventListener("timeupdate", () => {
        const clip = state.clip;
        if (!clip || state.seekInFlight) return;

        const current = Number(dom.video.currentTime || 0);
        if (state.stopAtClipEnd && current >= clip.endSeconds - END_EPS) {
            if (state.loopArmed && !dom.video.paused) {
                void goToTime(clip.startSeconds, true, { preservePlayingVisual: true });
            } else {
                dom.video.pause();
                dom.video.currentTime = clip.endSeconds;
                state.holdPauseVisual = false;
                stopUiTicker();
                setPlayPauseVisual(false);
                syncVideoUI();
            }
            return;
        }

        syncVideoUI();
    });

    dom.video.addEventListener("loadedmetadata", () => {
        if (!Number.isFinite(state.recordingDurationSeconds) && Number.isFinite(dom.video.duration)) {
            state.recordingDurationSeconds = dom.video.duration;
        }
        layoutVideoArea();
        syncVideoUI();
    });

    dom.video.addEventListener("seeked", syncVideoUI);
    dom.video.addEventListener("pause", () => {
        if (!state.holdPauseVisual) {
            stopUiTicker();
        } else {
            startUiTicker();
        }
        syncVideoUI();
    });
    dom.video.addEventListener("play", () => {
        state.holdPauseVisual = false;
        startUiTicker();
        syncVideoUI();
    });
    dom.video.addEventListener("ended", () => {
        if (state.clip && state.loopArmed && state.stopAtClipEnd) {
            void goToTime(state.clip.startSeconds, true, { preservePlayingVisual: true });
            return;
        }

        state.holdPauseVisual = false;
        stopUiTicker();
        setPlayPauseVisual(false);
        syncVideoUI();
    });

    window.addEventListener("resize", () => {
        layoutVideoArea();
        drawTimeline();
        requestAnimationFrame(adjustTransportButtonOverlap);
    });

    dom.timelineArea.addEventListener("click", async event => {
        if (state.suppressNextTimelineClick) {
            state.suppressNextTimelineClick = false;
            return;
        }

        const clip = state.clip;
        if (!clip) return;

        const targetTime = timelineTimeFromClientX(event.clientX);
        if (targetTime == null) return;

        await goToTime(targetTime, !dom.video.paused);
    });

    dom.timelineArea.addEventListener("pointerdown", beginTimelineScrub);
    dom.timelineArea.addEventListener("pointermove", event => {
        if (!state.isScrubbing || event.pointerId !== state.scrubPointerId) return;

        const targetTime = timelineTimeFromClientX(event.clientX);
        if (targetTime != null) {
            applyScrubPreview(targetTime);
        }
    });
    dom.timelineArea.addEventListener("pointerup", event => {
        void endTimelineScrub(event);
    });
    dom.timelineArea.addEventListener("pointercancel", event => {
        void endTimelineScrub(event);
    });

    dom.elementRail.addEventListener("click", event => {
        const showAllButton = event.target instanceof Element
            ? event.target.closest(".elementRailButton[data-show-all='true']")
            : null;
        if (showAllButton instanceof HTMLButtonElement) {
            if (showAllButton.disabled) return;
            void activateShowAllView({ autoplay: false });
            return;
        }

        const button = event.target instanceof Element
            ? event.target.closest(".elementRailButton[data-clip-index]")
            : null;
        if (!(button instanceof HTMLButtonElement)) return;
        if (button.disabled) return;

        const index = Number(button.dataset.clipIndex);
        if (!Number.isInteger(index) || index <= 0) return;

        void selectClipByIndex(index, { autoplay: true });
    });

    dom.playPause.addEventListener("click", togglePlayPause);
    dom.panelSessionRefreshBtn?.addEventListener("click", () => window.location.reload());
    dom.panelSettingsBtn?.addEventListener("click", showPanelSettings);
    dom.panelSettingsSaveBtn?.addEventListener("click", () => {
        void savePanelSettings().then(hidePanelSettings).catch(error => {
            setPanelSettingsStatus(`${panelSettingsText("saveFailed")}: ${error?.message || error}`, "error");
        });
    });
    dom.panelSettingsOverlay?.addEventListener("click", event => {
        if (event.target === dom.panelSettingsOverlay) hidePanelSettings();
    });
    dom.panelSettingsLanguage?.addEventListener("change", () => {
        panelSettingsLanguage = normalizePanelSettingsLanguage(dom.panelSettingsLanguage.value);
        applyPanelSettingsI18n();
    });
    dom.panelLogoBtn?.addEventListener("click", showBrandOverlay);
    dom.brandOverlay?.addEventListener("click", hideBrandOverlay);
    dom.stopwatchBtn?.addEventListener("click", toggleStopwatch);
    dom.timingPresetButtons?.addEventListener("click", event => {
        const button = event.target.closest("button[data-timing-seconds]");
        if (!button || button.disabled) return;

        const seconds = Number(button.dataset.timingSeconds);
        if (!Number.isFinite(seconds)) return;

        void applyTimingPreset(seconds);
    });
    dom.rew10.addEventListener("click", () => void goToTime((dom.video.currentTime || 0) - 10, !dom.video.paused, { allowOutOfClipIndicator: true }));
    dom.rew3.addEventListener("click", () => void goToTime((dom.video.currentTime || 0) - 3, !dom.video.paused, { allowOutOfClipIndicator: true }));
    dom.fwd3.addEventListener("click", () => void goToTime((dom.video.currentTime || 0) + 3, !dom.video.paused, { allowOutOfClipIndicator: true }));
    dom.fwd10.addEventListener("click", () => void goToTime((dom.video.currentTime || 0) + 10, !dom.video.paused, { allowOutOfClipIndicator: true }));
    window.addEventListener("keydown", handlePanelShortcut);
    window.addEventListener("keydown", event => {
        if (event.key === "Escape" && dom.panelSettingsOverlay && !dom.panelSettingsOverlay.classList.contains("hidden")) {
            hidePanelSettings();
        }
    });

    async function init() {
        const options = readOptions();

        if (options.clipIndex == null || options.clipIndex < 0) {
            alert("Invalid element number in URL. Example: panel.html, ?0, or ?2&autoplay=false&loop=false");
            return;
        }

        state.wantMenu = options.clipIndex === 0;
        state.wantAutoplay = state.wantMenu ? false : options.autoplay;
        state.wantLoop = state.wantMenu ? false : options.loop;
        state.showTimerControl = options.timer;
        state.loopArmed = state.wantLoop;
        state.showAllMode = false;
        state.selectedClipIndex = null;
        state.requestedClipIndex = state.wantMenu ? 0 : options.clipIndex;
        applyTimerControlVisibility();
        renderRail();

        const targetClipIndex = state.requestedClipIndex;

        setEmptyState(true, EMPTY_STATE_WAITING_FOR_SERVER);
        await loadSessionInfo();

        const replayContext = await waitForReplayContext(targetClipIndex);
        state.recordingDurationSeconds = replayContext.recordingDurationSeconds;
        state.clips = replayContext.clips;
        state.clipMap = new Map(state.clips.map(clip => [clip.index, clip]));
        state.clip = state.wantMenu ? firstAvailableClip() ?? replayContext.clip : state.clipMap.get(targetClipIndex) ?? replayContext.clip;

        renderRail();
        await prepareVideo();
        await startFirstClipInMenuMode();
        layoutVideoArea();
        setEmptyState(false);
        startReplayMonitor();
    }

    init().catch(error => {
        console.error(error);
        alert(error?.message || "Panel replay client failed.");
    });
})();
