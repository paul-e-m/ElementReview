import { el, BTN_SIZE, clamp, apiGet, apiPost } from "./app-utils.js";
import { TimelineRenderer } from "./app-timeline.js";
import { ReplayController } from "./app-replay.js?v=20260417-replayindicator2";
import { ShortcutKeysController } from "./app-shortcut-keys.js";

// ElementReviewApp is the main browser-side coordinator for index.html.
// It owns the shared application state fetched from the backend, wires that
// state into the DOM, and delegates specialized behavior to:
// - TimelineRenderer for canvas drawing
// - ReplayController for replay-only transport and edit interactions
//
// A useful mental model is:
// - backend = source of truth for recording mode, clips, and session state
// - this class = source of truth for current DOM/UI state
// - ReplayController = source of truth for replay-local interaction state
const LS_EDIT_KEY = "ElementReview_EditMode";

export class ElementReviewApp {
    constructor() {
        // Cache the DOM once up front so the rest of the code can focus on
        // state transitions instead of repeated querySelector calls.
        this.refs = {
            recordMode: el("recordMode"),
            replayMode: el("replayMode"),
            recordTopRow: el("recordTopRow"),
            replayTopRow: el("replayTopRow"),
            mainBtn: el("mainBtn"),
            mainBtnHostRecord: el("mainBtnHostRecord"),
            mainBtnHostReplay: el("mainBtnHostReplay"),
            recordSessionEncoderDot: el("recordSessionEncoderDot"),
            recordSessionCssDot: el("recordSessionCssDot"),
            replaySessionEncoderDot: el("replaySessionEncoderDot"),
            replaySessionCssDot: el("replaySessionCssDot"),
            leftControls: el("leftControls"),
            replayElementsLabel: el("replayElementsLabel"),
            replayElementsValue: el("replayElementsValue"),
            replayReviewsLabel: el("replayReviewsLabel"),
            replayReviewsValue: el("replayReviewsValue"),
            clipList: el("clipList"),
            clipToggleRailHost: el("clipToggleRailHost"),
            clipToggleBtn: el("clipToggleBtn"),
            undoClipBtn: el("undoClipBtn"),
            redoClipBtn: el("redoClipBtn"),
            recordTimerCard: el("recordTimerCard"),
            programTimerCard: el("programTimerCard"),
            clipTimerCard: el("clipTimerCard"),
            clipTime: el("clipTime"),
            recordTimerPrefix: el("recordTimerPrefix"),
            recordTimerValue: el("recordTimerValue"),
            programTimerPrefix: el("programTimerPrefix"),
            programTimerDisplay: el("programTimerDisplay"),
            reviewTimerEl: el("reviewTimer"),
            recordShortcutHint: el("recordShortcutHint"),
            replayShortcutHint: el("replayShortcutHint"),
            settingsBtn: el("settingsBtn"),
            recLamp: el("recLamp"),
            liveFrame: el("liveFrame"),
            liveWrap: el("liveWrap"),
            timelineRow: el("timelineRow"),
            timelineOverlay: el("timelineOverlay"),
            replayProgramTimeIndicator: el("replayProgramTimeIndicator"),
            recordCanvas: el("recordCanvas"),
            replayVideo: el("replayVideo"),
            replayScrub: el("replayScrub"),
            replayZoomHint: el("replayZoomHint"),
            replayControlsRow: el("replayControlsRow"),
            replayControlsInner: document.querySelector(".replayControlsInner"),
            replayLeftGroup: document.querySelector(".replayLeftGroup"),
            replayButtonsWrap: el("replayButtons"),
            replayRightGroup: document.querySelector(".replayRightGroup"),
            loopInBtn: el("loopInBtn"),
            loopOutBtn: el("loopOutBtn"),
            loopClearBtn: el("loopClearBtn"),
            trimInBtn: el("trimInBtn"),
            trimOutBtn: el("trimOutBtn"),
            deleteBtn: el("deleteBtn"),
            insertBtn: el("insertBtn"),
            splitBtn: el("splitBtn"),
            confirmModal: el("confirmModal"),
            confirmText: el("confirmText"),
            confirmYes: el("confirmYes"),
            confirmCancel: el("confirmCancel"),
            editButtons: el("editButtons"),
            loopButtons: document.querySelector(".loopButtons"),
            shortcutOverlay: el("shortcutOverlay"),
            shortcutTitle: el("shortcutTitle"),
            shortcutModeLabel: el("shortcutModeLabel"),
            shortcutList: el("shortcutList"),
            recordSessionInfo: el("recordSessionInfo"),
            recordSessionInfoText: el("recordSessionInfoText"),
            replaySessionInfo: el("replaySessionInfo"),
            replaySessionInfoText: el("replaySessionInfoText"),
        };

        this.refs.recordCtx = this.refs.recordCanvas?.getContext("2d") || null;

        // `state` mirrors `/api/status` and should be treated as authoritative
        // for the current session/recording lifecycle.
        this.state = null;
        this.currentLiveMode = "rtsp";
        this.localRecStartPerf = null;
        this.currentDomMode = null;

        // Small UI-only pending states so the app reacts immediately while
        // the backend is still working.
        this.isStartPending = false;
        this.isStopPending = false;
        this.isClipPending = false;
        this.lastRecordStartRequestPerf = 0;
        this.pendingDemoResume = null;
        this.pendingOpenClipSlotIndex = null;
        this.suppressOpenClipPlaceholder = false;

        // Cache appconfig once up front so the first clip button press does
        // not need to fetch it on demand.
        this.appConfig = null;
        this.currentLanguage = "en";
        this.i18n = window.INDEX_I18N || {};
        this.buttonImageUrlCache = new Map();
        this.buttonImageMetaCache = new Map();
        this.currentMainButtonKind = "start";

        this.editModeEnabled = false;
        this.editToggleWrap = null;
        this.editToggleInput = null;

        this.selectedClipIdx = null;
        this.selectedClipSeg = null;

        this.programTimerStartOffsetSeconds = null;
        this.programTimerStopOffsetSeconds = null;
        this.programTimerRunning = false;
        this.pendingRecordShortcut = null;

        // Element metadata comes from `/api/elements` / SessionInfo.json and is
        // intentionally kept separate from clip timing returned by `/api/status`.
        this.elementMeta = {};
        this.elementMetaVersion = 0;
        this.elementMetaSig = "";
        this.sessionInfoText = "";
        this.sessionInfoPayload = null;
        this.replayHostPollTimerId = null;
        this.replayHostPollInFlight = false;
        this.replayPingStatus = {
            encoder: { state: "idle" },
            css: { state: "idle" },
        };

        this.confirmResolve = null;

        this.ro = null;
        this.layoutScheduled = false;

        this.timeline = new TimelineRenderer(this);
        this.replay = new ReplayController(this);
        this.shortcuts = new ShortcutKeysController(this);
    }

    async init() {
        document.documentElement.style.setProperty("--btnSize", `${BTN_SIZE}px`);

        this.editModeEnabled = this.loadEditModeSetting();
        this.ensureEditToggle();
        if (this.editToggleInput) this.editToggleInput.checked = this.editModeEnabled;

        if (this.refs.recordTimerValue) this.refs.recordTimerValue.textContent = this.formatRecordingTimerDisplay(0);
        if (this.refs.clipTime) this.refs.clipTime.textContent = this.formatClipTimerDisplay(0);
        if (this.refs.programTimerDisplay) this.refs.programTimerDisplay.textContent = this.formatProgramTimerDisplay(0);
        this.applyTranslations();
        this.preloadButtonImages();

        this.bindAppEvents();
        this.replay.init();
        this.replay.bindEvents();
        this.shortcuts.bindEvents();

        this.applyEditModeUI();
        this.updateEditButtonsUI();

        await this.pollStatus();
        await this.pollElementNames();
        await Promise.all([
            this.refreshLiveUrl(),
            this.warmAppConfig(),
        ]);
        this.updateReplayStatusPanel();
        this.startReplayHostPolling();

        this.ensureLayoutObserver();
        this.scheduleLayout();

        // Status and element metadata are polled independently because they
        // change at different times and come from different backend sources.
        setInterval(() => {
            this.pollStatus().catch(() => { });
            this.pollElementNames().catch(() => { });
        }, 500);

        // Recording mode updates the timeline and timers locally between polls
        // so the UI feels continuous even though the backend is polled.
        setInterval(() => {
            if (!this.state) return;
            if (this.state.mode !== "record" || !this.state.isRecording) return;

            this.timeline.draw();
            if (this.refs.recordTimerValue) {
                this.refs.recordTimerValue.textContent = this.formatRecordingTimerDisplay(this.currentRecordSeconds());
            }
            this.updateClipTimerUI();
            this.updateProgramTimerUI();
            this.renderClipList();
        }, 60);

        this.replay.startRafLoop();
    }

    async warmAppConfig() {
        try {
            this.appConfig = await apiGet("/api/appconfig");
        } catch {
            // Keep going. The app can still fetch config later if needed.
        }

        this.currentLanguage = this.normalizeLanguage(
            this.appConfig?.Language ?? this.appConfig?.language ?? this.currentLanguage
        );
        this.applyTranslations();
        this.preloadButtonImages();
    }

    normalizeLanguage(language) {
        return String(language || "").trim().toLowerCase() === "fr" ? "fr" : "en";
    }

    t(key) {
        const fallback = this.i18n?.en || {};
        const current = this.i18n?.[this.currentLanguage] || fallback;
        return current[key] ?? fallback[key] ?? key;
    }

    setText(ref, value) {
        if (ref) ref.textContent = value;
    }

    setAriaLabel(ref, value) {
        if (ref) ref.setAttribute("aria-label", value);
    }

    getDemoLiveVideoElement() {
        try {
            return this.refs.liveFrame?.contentWindow?.document?.getElementById("demoVideo") ?? null;
        } catch {
            return null;
        }
    }

    pauseDemoLiveAt(seconds) {
        const video = this.getDemoLiveVideoElement();
        if (!video) return;

        const anchor = Math.max(0, Number(seconds) || 0);

        try {
            video.pause();
            video.currentTime = anchor;
            this.pendingDemoResume = anchor;
        } catch {
            this.pendingDemoResume = null;
        }
    }

    resumeDemoLiveAfterStart() {
        const video = this.getDemoLiveVideoElement();
        if (!video) {
            this.pendingDemoResume = null;
            return;
        }

        try {
            if (this.pendingDemoResume != null) {
                video.currentTime = Math.max(0, Number(this.pendingDemoResume) || 0);
            }
            video.play().catch(() => { });
        } catch {
            // ignore
        } finally {
            this.pendingDemoResume = null;
        }
    }

    setTitleAndAria(ref, value) {
        if (!ref) return;
        ref.title = value;
        ref.setAttribute("aria-label", value);
    }

    applyTranslatedButtonState(button, textKey, ariaKey, imageKind) {
        if (!button) return;
        button.textContent = this.t(textKey);
        button.setAttribute("aria-label", this.t(ariaKey));
        this.applyButtonImage(button, imageKind);
    }

    getButtonLanguageSuffix() {
        return this.currentLanguage === "fr" ? "fr" : "en";
    }

    getButtonImageCandidates(kind) {
        const lang = this.getButtonLanguageSuffix();

        switch (kind) {
        case "start":
            return ["/img/i18-buttons/record_" + lang + ".png"];
        case "starting":
            return ["/img/i18-buttons/starting_" + lang + ".png"];
        case "timer":
            return ["/img/i18-buttons/timer_" + lang + ".png"];
        case "stop":
            return ["/img/i18-buttons/stop_" + lang + ".png"];
        case "stopping":
            return ["/img/i18-buttons/stop_" + lang + ".png"];
        case "next":
            return ["/img/i18-buttons/next_" + lang + ".png"];
        case "clipStart":
            return [
                "/img/i18-buttons/start_clip_" + lang + ".png",
                "/img/i18-buttons/start_cli_" + lang + ".png",
            ];
        case "clipStop":
            return ["/img/i18-buttons/end_clip_" + lang + ".png"];
        case "undo":
            return ["/img/i18-buttons/undo_" + lang + ".png"];
        case "redo":
            return ["/img/i18-buttons/redo_" + lang + ".png"];
        default:
            return [];
        }
    }

    async loadButtonImageMeta(path) {
        if (!path) return null;
        if (!this.buttonImageMetaCache.has(path)) {
            this.buttonImageMetaCache.set(path, new Promise((resolve) => {
                const probe = new Image();
                probe.onload = () => resolve({
                    url: path,
                    width: probe.naturalWidth || probe.width || 0,
                    height: probe.naturalHeight || probe.height || 0,
                });
                probe.onerror = () => resolve(null);
                probe.src = path;
            }));
        }

        return await this.buttonImageMetaCache.get(path);
    }

    async resolveButtonImageAsset(kind) {
        const cacheKey = `${kind}:${this.getButtonLanguageSuffix()}`;

        if (!this.buttonImageUrlCache.has(cacheKey)) {
            this.buttonImageUrlCache.set(cacheKey, (async () => {
                const candidates = this.getButtonImageCandidates(kind);
                for (const candidate of candidates) {
                    const asset = await this.loadButtonImageMeta(candidate);
                    if (asset) return asset;
                }
                return null;
            })());
        }

        return await this.buttonImageUrlCache.get(cacheKey);
    }

    preloadButtonImages() {
        for (const kind of ["start", "starting", "timer", "stop", "stopping", "next", "clipStart", "clipStop", "undo", "redo"]) {
            this.resolveButtonImageAsset(kind).catch(() => { });
        }
    }

    applyButtonImage(button, kind) {
        if (!button) return;

        const requestKey = `${kind}:${this.getButtonLanguageSuffix()}`;
        button.dataset.buttonSkinKey = requestKey;

        this.resolveButtonImageAsset(kind).then((asset) => {
            if (!button || button.dataset.buttonSkinKey !== requestKey) return;

            if (asset?.url) {
                const ratio = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : null;
                button.style.backgroundImage = `url("${asset.url}")`;
                if (ratio) {
                    button.style.setProperty("--button-ratio", String(ratio));
                } else {
                    button.style.removeProperty("--button-ratio");
                }
                button.classList.add("btnImg");
                button.dataset.imageReady = "true";
                return;
            }

            button.dataset.imageReady = "false";
            button.style.removeProperty("background-image");
            button.style.removeProperty("--button-ratio");
        }).catch(() => {
            if (button.dataset.buttonSkinKey !== requestKey) return;

            button.dataset.imageReady = "false";
            button.style.removeProperty("background-image");
            button.style.removeProperty("--button-ratio");
        });
    }

    formatProgramTimerDisplay(seconds) {
        return this.fmtProgramTimer(seconds);
    }

    formatClipTimerDisplay(seconds) {
        return this.fmtProgramTimer(seconds);
    }

    formatRecordingTimerDisplay(seconds) {
        return this.fmtTimeFrames(seconds);
    }

    applyTranslations() {
        document.documentElement.lang = this.currentLanguage;
        document.title = this.t("pageTitle");
        this.applyStaticTranslations();

        if (this.state) {
            this.updateUI();
            return;
        }

        this.applyTranslatedDefaults();
    }

    applyStaticTranslations() {
        this.setAriaLabel(this.refs.clipList, this.t("elementsListAria"));
        this.setTitleAndAria(this.refs.settingsBtn, this.t("settings"));
        this.setText(this.refs.recordShortcutHint, this.t("shortcutHint"));
        this.setText(this.refs.replayShortcutHint, this.t("shortcutHint"));
        this.setText(this.refs.recordTimerPrefix, this.t("recordTimerPrefix"));
        this.setText(this.refs.programTimerPrefix, this.t("programTimerPrefix"));
        this.setText(this.refs.recordTimerValue, this.formatRecordingTimerDisplay(this.currentRecordSeconds()));
        this.setText(this.refs.programTimerDisplay, this.formatProgramTimerDisplay(this.currentProgramTimerElapsedSeconds?.() ?? 0));

        if (this.editToggleWrap) {
            this.setText(this.editToggleWrap.querySelector(".editToggleLabel"), this.t("editToggleLabel"));
        }
        this.setAriaLabel(this.editToggleInput, this.t("editToggleAria"));
        this.setAriaLabel(this.refs.editButtons, this.t("editControlsAria"));
        this.setAriaLabel(this.refs.loopButtons, this.t("loopControlsAria"));

        for (const [button, key] of [
            [this.refs.trimInBtn, "trimIn"],
            [this.refs.trimOutBtn, "trimOut"],
            [this.refs.splitBtn, "split"],
            [this.refs.insertBtn, "insert"],
            [this.refs.deleteBtn, "delete"],
        ]) {
            this.setTitleAndAria(button, this.t(key));
        }

        if (!this.confirmResolve) {
            this.setText(this.refs.confirmText, this.t("confirmGenericText"));
            this.setText(this.refs.confirmYes, this.t("confirmYes"));
            this.setText(this.refs.confirmCancel, this.t("confirmCancel"));
        }

        for (const [ref, key] of [
            [this.refs.replayElementsLabel, "statusElementsLabel"],
            [this.refs.replayReviewsLabel, "statusReviewsLabel"],
        ]) {
            this.setText(ref, `${this.t(key)}:`);
        }
    }

    applyTranslatedDefaults() {
        this.setMainButtonVisual("start");
        this.applyTranslatedButtonState(this.refs.clipToggleBtn, "clipStart", "clipStartAria", "clipStart");
        this.applyTranslatedButtonState(this.refs.undoClipBtn, "undo", "undoAria", "undo");
        this.applyTranslatedButtonState(this.refs.redoClipBtn, "redo", "redoAria", "redo");
        this.setText(this.refs.recordTimerValue, this.formatRecordingTimerDisplay(0));
        this.setText(this.refs.clipTime, this.formatClipTimerDisplay(0));
        this.setText(this.refs.reviewTimerEl, `${this.t("reviewLabel")}: 00:00`);
        this.updateReplayStatusPanel();
        this.updateProgramTimerUI();
        this.replay.updateReviewTimer();
        this.replay.updateLoopButtonsUI();
        this.replay.updateZoomHint();
        this.shortcuts.refreshOverlay();
    }

    getClipMarkerAdvanceSeconds() {
        const cfg = this.appConfig;
        const advanceMsec = Number(cfg?.clipMarkerAdvanceMsec ?? cfg?.ClipMarkerAdvanceMsec ?? 0);
        return Math.max(0, advanceMsec / 1000);
    }

    refreshBusyCursor() {
        const busy = this.isStartPending || this.isStopPending || this.isClipPending;
        document.body.style.cursor = busy ? "progress" : "";
    }

    syncPendingUi() {
        this.refreshBusyCursor();
        this.updateUI();
    }

    isSuppressedFocusTarget(target) {
        if (!(target instanceof HTMLElement)) return false;
        return target.matches("button, input, video");
    }

    bindAppEvents() {
        const bindRecordAction = (button, action) => {
            button?.addEventListener("click", () => {
                if (this.state?.mode === "record" && this.state?.isRecording) {
                    action().catch(alert);
                }
            });
        };

        document.addEventListener("focusin", (event) => {
            const target = event.target;
            if (!this.isSuppressedFocusTarget(target)) return;
            target.blur();
        }, true);

        document.addEventListener("pointerup", (event) => {
            const target = event.target;
            if (!this.isSuppressedFocusTarget(target)) return;
            requestAnimationFrame(() => target.blur());
        }, true);

        this.refs.confirmYes?.addEventListener("click", () => this.hideConfirm(true));
        this.refs.confirmCancel?.addEventListener("click", () => this.hideConfirm(false));

        this.refs.confirmModal?.addEventListener("click", (event) => {
            if (event.target === this.refs.confirmModal) this.hideConfirm(false);
        });

        this.refs.mainBtn?.addEventListener("click", async () => {
            if (!this.state) return;

            if (this.state.mode === "record") {
                // The record-side main button advances through:
                // 1. start recording
                // 2. start program timer
                // 3. stop recording
                if (!this.state.isRecording) {
                    if (this.isStartPending || this.state.isArming) {
                        this.pendingRecordShortcut = "timer";
                        return;
                    }
                    this.startRecording().catch(alert);
                } else if (this.hasProgramTimerStarted()) {
                    this.stopRecording().catch(alert);
                } else {
                    this.startProgramTimer();
                }
                return;
            }

            const ok = await this.showConfirm({
                text: this.t("confirmNextCompetitorText"),
                yesText: this.t("confirmNextCompetitorYes"),
                cancelText: this.t("confirmCancel"),
            });

            if (ok) this.clearSession().catch(alert);
        });

        bindRecordAction(this.refs.clipToggleBtn, () => this.toggleClip());
        bindRecordAction(this.refs.undoClipBtn, () => this.undoClipAction());
        bindRecordAction(this.refs.redoClipBtn, () => this.redoClipAction());

        this.refs.clipList?.addEventListener("click", async (event) => {
            if (!this.state || this.state.mode !== "replay") return;

            const empty = event.target.closest(".clipSlotEmpty");
            if (empty) {
                this.replay.clearElementLoop();
                this.setSelectedClipIdx(null);
                this.timeline.draw();
                this.replay.updateReplayTimerAndSpeed();
                return;
            }

            const button = event.target.closest("button[data-clip-index]");
            if (!button) return;

            const idx = parseInt(button.dataset.clipIndex, 10);
            if (!Number.isFinite(idx)) return;

            await this.replay.selectClipAndAutoPlay(idx);
        });
    }

    loadEditModeSetting() {
        try {
            return localStorage.getItem(LS_EDIT_KEY) === "1";
        } catch {
            return false;
        }
    }

    saveEditModeSetting(on) {
        try {
            localStorage.setItem(LS_EDIT_KEY, on ? "1" : "0");
        } catch {
            // ignore
        }
    }

    ensureEditToggle() {
        if (this.editToggleWrap) return;
        if (!this.refs.deleteBtn || !this.refs.deleteBtn.parentElement) return;

        // The toggle is injected next to the edit buttons so replay markup can
        // stay simple and the control only exists when the page needs it.
        const wrap = document.createElement("div");
        wrap.className = "editToggleWrap";
        wrap.innerHTML = `
      <span class="editToggleLabel">${this.t("editToggleLabel")}</span>
      <label class="editToggleSwitch">
        <input type="checkbox" id="editToggle" aria-label="${this.t("editToggleAria")}">
        <span class="editToggleSlider"></span>
      </label>
    `;

        this.refs.deleteBtn.insertAdjacentElement("afterend", wrap);

        this.editToggleWrap = wrap;
        this.editToggleInput = wrap.querySelector("#editToggle");

        if (this.editToggleInput) {
            this.editToggleInput.checked = !!this.editModeEnabled;
            this.editToggleInput.addEventListener("change", () => {
                this.setEditModeEnabled(!!this.editToggleInput.checked);
            });
        }
    }

    setEditModeEnabled(on) {
        this.editModeEnabled = !!on;
        this.saveEditModeSetting(this.editModeEnabled);

        if (this.editToggleInput) this.editToggleInput.checked = this.editModeEnabled;

        this.applyEditModeUI();
        this.updateEditButtonsUI();
        this.scheduleLayout();
    }

    applyEditModeUI() {
        this.ensureEditToggle();

        const inReplay = this.state?.mode === "replay";
        if (this.editToggleWrap) {
            this.editToggleWrap.classList.toggle("hidden", !inReplay);
        }

        const showButtons = inReplay && this.editModeEnabled;
        const editButtons = [
            this.refs.trimInBtn,
            this.refs.trimOutBtn,
            this.refs.splitBtn,
            this.refs.insertBtn,
            this.refs.deleteBtn,
        ];

        const editDividers = Array.from(document.querySelectorAll("#editButtons .speedDivider"));

        for (const button of editButtons) {
            if (!button) continue;
            button.classList.toggle("editHidden", !showButtons);
            if (!showButtons) button.disabled = true;
        }

        for (const divider of editDividers) {
            divider.classList.toggle("editHidden", !showButtons);
        }
    }

    updateEditButtonsUI() {
        const inReplay = this.state?.mode === "replay";
        const showButtons = inReplay && this.editModeEnabled;

        if (!showButtons) {
            if (this.refs.trimInBtn) this.refs.trimInBtn.disabled = true;
            if (this.refs.trimOutBtn) this.refs.trimOutBtn.disabled = true;
            if (this.refs.deleteBtn) this.refs.deleteBtn.disabled = true;
            if (this.refs.splitBtn) this.refs.splitBtn.disabled = true;
            if (this.refs.insertBtn) this.refs.insertBtn.disabled = true;
            return;
        }

        const hasSelection = inReplay && this.selectedClipIdx != null && !!this.getClipByIndex(this.selectedClipIdx);

        if (this.refs.trimInBtn) this.refs.trimInBtn.disabled = !hasSelection;
        if (this.refs.trimOutBtn) this.refs.trimOutBtn.disabled = !hasSelection;
        if (this.refs.deleteBtn) this.refs.deleteBtn.disabled = !hasSelection;
        if (this.refs.splitBtn) this.refs.splitBtn.disabled = !hasSelection;
        if (this.refs.insertBtn) this.refs.insertBtn.disabled = !inReplay;
    }

    clipIdx(clip) {
        return Number(clip?.index ?? clip?.Index ?? 0);
    }

    clipStart(clip) {
        return Number(clip?.startSeconds ?? clip?.StartSeconds ?? 0);
    }

    clipEnd(clip) {
        return Number(clip?.endSeconds ?? clip?.EndSeconds ?? 0);
    }

    getClips() {
        return Array.isArray(this.state?.clips) ? this.state.clips : [];
    }

    isRenderableClip(clip) {
        const start = this.clipStart(clip);
        const end = this.clipEnd(clip);
        return Number.isFinite(start) && Number.isFinite(end) && end > start;
    }

    getNextAvailableClipSlotIndex() {
        const occupied = new Set();

        for (const clip of this.getClips()) {
            const idx = this.clipIdx(clip);
            if (!Number.isFinite(idx) || idx < 1 || idx > 15) continue;
            if (!this.isRenderableClip(clip)) continue;
            occupied.add(idx);
        }

        for (let i = 1; i <= 15; i++) {
            if (!occupied.has(i)) return i;
        }

        return null;
    }

    getOpenClipPlaceholderIndex() {
        if (this.suppressOpenClipPlaceholder) return null;

        const hasOpenClip =
            this.state?.mode === "record" &&
            !!this.state?.isRecording &&
            this.state?.openClipStartSeconds != null &&
            Number.isFinite(Number(this.state.openClipStartSeconds));

        if (hasOpenClip) {
            return this.getNextAvailableClipSlotIndex();
        }

        const pendingIdx = Number(this.pendingOpenClipSlotIndex);
        if (this.isClipPending && Number.isFinite(pendingIdx) && pendingIdx >= 1 && pendingIdx <= 15) {
            return pendingIdx;
        }

        return null;
    }

    getClipByIndex(idx) {
        return this.getClips().find((clip) => this.clipIdx(clip) === Number(idx)) ?? null;
    }

    findClipBySegment(seg, tolSec = 0.02) {
        if (!seg) return null;

        const start0 = Number(seg.startSeconds);
        const end0 = Number(seg.endSeconds);
        if (!Number.isFinite(start0) || !Number.isFinite(end0)) return null;

        for (const clip of this.getClips()) {
            const start = this.clipStart(clip);
            const end = this.clipEnd(clip);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (Math.abs(start - start0) < tolSec && Math.abs(end - end0) < tolSec) {
                return clip;
            }
        }

        return null;
    }

    setSelectedClipIdx(idxOrNull) {
        if (idxOrNull == null) {
            this.selectedClipIdx = null;
            this.selectedClipSeg = null;
            this.updateEditButtonsUI();
            return;
        }

        // Keep the numeric index when possible because much of the UI is
        // organized around element numbers, but pair it with exact segment
        // data elsewhere so selection can survive edits and reordering.
        const idx = Number(idxOrNull);
        this.selectedClipIdx = Number.isFinite(idx) ? idx : null;
        if (this.selectedClipIdx == null) this.selectedClipSeg = null;
        this.updateEditButtonsUI();
    }

    syncSelectedClipToState() {
        // Replay edit operations can cause the backend to return a slightly
        // different clip list. Try to reattach the current selection using the
        // exact segment first, then fall back to clip index when possible.
        if (!this.state || this.state.mode !== "replay") {
            this.updateEditButtonsUI();
            return;
        }

        if (this.selectedClipSeg) {
            const clip = this.findClipBySegment(this.selectedClipSeg, 0.02);
            if (clip) {
                this.selectedClipIdx = this.clipIdx(clip);
                this.selectedClipSeg = {
                    startSeconds: this.clipStart(clip),
                    endSeconds: this.clipEnd(clip),
                };
                this.updateEditButtonsUI();
                return;
            }

            this.selectedClipIdx = null;
            this.selectedClipSeg = null;
            this.updateEditButtonsUI();
            return;
        }

        if (this.selectedClipIdx != null) {
            const clip = this.getClipByIndex(this.selectedClipIdx);
            if (clip) {
                this.selectedClipSeg = {
                    startSeconds: this.clipStart(clip),
                    endSeconds: this.clipEnd(clip),
                };
            } else {
                this.selectedClipIdx = null;
                this.selectedClipSeg = null;
            }
        }

        this.updateEditButtonsUI();
    }

    isSelectedClip(idx, startSeconds, endSeconds) {
        if (
            this.selectedClipSeg &&
            Number.isFinite(this.selectedClipSeg.startSeconds) &&
            Number.isFinite(this.selectedClipSeg.endSeconds)
        ) {
            const eps = 0.02;
            return (
                Math.abs(Number(this.selectedClipSeg.startSeconds) - Number(startSeconds)) < eps &&
                Math.abs(Number(this.selectedClipSeg.endSeconds) - Number(endSeconds)) < eps
            );
        }

        if (this.selectedClipIdx == null) return false;
        if (!Number.isFinite(idx) || idx !== this.selectedClipIdx) return false;
        return true;
    }

    isLoopingClip(idx, startSeconds, endSeconds) {
        const loop = this.replay?.elementLoop;
        if (
            !loop ||
            !Number.isFinite(loop.startSeconds) ||
            !Number.isFinite(loop.endSeconds)
        ) {
            return false;
        }

        const eps = 0.02;
        return (
            Number.isFinite(idx) &&
            idx === this.selectedClipIdx &&
            Math.abs(Number(loop.startSeconds) - Number(startSeconds)) < eps &&
            Math.abs(Number(loop.endSeconds) - Number(endSeconds)) < eps
        );
    }

    findClipAtTime(timeSeconds) {
        const t = Number(timeSeconds) || 0;
        const eps = 0.0005;

        for (const clip of this.getClips()) {
            const start = this.clipStart(clip);
            const end = this.clipEnd(clip);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
            if (t >= start - eps && t < end - eps) return clip;
        }

        return null;
    }

    getValidClipIndices() {
        const out = [];

        for (const clip of this.getClips()) {
            const idx = this.clipIdx(clip);
            const start = this.clipStart(clip);
            const end = this.clipEnd(clip);
            if (Number.isFinite(idx) && Number.isFinite(start) && Number.isFinite(end) && end > start) {
                out.push(idx);
            }
        }

        out.sort((a, b) => a - b);
        return out.filter((value, index) => index === 0 || value !== out[index - 1]);
    }

    segEquals(seg, start, end, eps = 0.03) {
        if (!seg) return false;

        return (
            Math.abs(Number(seg.startSeconds) - Number(start)) < eps &&
            Math.abs(Number(seg.endSeconds) - Number(end)) < eps
        );
    }

    restoreSelectionFromSeg(seg) {
        const hit = this.findClipBySegment(seg, 0.03);
        if (!hit) return false;

        this.selectedClipIdx = this.clipIdx(hit);
        this.selectedClipSeg = {
            startSeconds: this.clipStart(hit),
            endSeconds: this.clipEnd(hit),
        };
        this.updateEditButtonsUI();
        return true;
    }

    segmentsOverlap(a1, a2, b1, b2) {
        const eps = 0.0005;
        return a1 < b2 - eps && a2 > b1 + eps;
    }

    canInsertSegment(start, end) {
        for (const clip of this.getClips()) {
            const a = this.clipStart(clip);
            const b = this.clipEnd(clip);
            if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
            if (this.segmentsOverlap(start, end, a, b)) return false;
        }
        return true;
    }

    normalizeElementsPayload(payload) {
        // SessionInfo/elements data has evolved over time and can arrive in
        // camelCase, PascalCase, array form, or object form. Normalize it once
        // here so the rest of the UI can use a single shape.
        const out = {};
        if (!payload) return out;

        const elements = payload.elements ?? payload.Elements ?? payload;
        const toBool = (value) =>
            value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";

        if (Array.isArray(elements)) {
            for (const item of elements) {
                const idx = parseInt(item?.index ?? item?.Index ?? item?.id ?? item?.Id, 10);
                if (!Number.isFinite(idx) || idx <= 0) continue;

                const code = (item?.code ?? item?.Code ?? item?.name ?? item?.Name ?? "").toString().trim();
                const review = toBool(item?.review ?? item?.Review ?? item?.reviewed ?? item?.Reviewed);

                if (code) out[idx] = { code, review };
            }
            return out;
        }

        if (elements && typeof elements === "object") {
            for (const [key, value] of Object.entries(elements)) {
                const idx = parseInt(key, 10);
                if (!Number.isFinite(idx) || idx <= 0) continue;

                if (typeof value === "string" || typeof value === "number") {
                    const code = String(value).trim();
                    if (code) out[idx] = { code, review: false };
                    continue;
                }

                const code = (value?.code ?? value?.Code ?? value?.name ?? value?.Name ?? "").toString().trim();
                const review = toBool(value?.review ?? value?.Review ?? value?.reviewed ?? value?.Reviewed);

                if (code) out[idx] = { code, review };
            }
        }

        return out;
    }

    getSessionInfoField(payload, camelName) {
        if (!payload || typeof payload !== "object") return "";

        const pascalName = camelName.charAt(0).toUpperCase() + camelName.slice(1);
        return (payload[camelName] ?? payload[pascalName] ?? "").toString().trim();
    }

    getSessionInfoTimeSeconds(payload, camelName) {
        const raw = this.getSessionInfoField(payload, camelName);
        if (!raw) return null;

        if (!raw.includes(":")) {
            const seconds = Number(raw);
            return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
        }

        const parts = raw.split(":").map((part) => Number(part));
        if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;

        let seconds = 0;
        if (parts.length === 2) {
            seconds = parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
            seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else {
            return null;
        }

        return Math.max(0, seconds);
    }

    buildSessionInfoText(payload) {
        // Build the compact session banner shown over the video. This is
        // intentionally a plain text summary rather than a structured widget.
        const leftParts = [
            this.getSessionInfoField(payload, "categoryName"),
            this.getSessionInfoField(payload, "categoryDiscipline"),
            this.getSessionInfoField(payload, "categoryFlight"),
            this.getSessionInfoField(payload, "segmentName"),
        ].filter(Boolean);

        const competitor = [
            this.getSessionInfoField(payload, "competitorFirstName"),
            this.getSessionInfoField(payload, "competitorLastName"),
        ].filter(Boolean).join(" ");

        if (!leftParts.length && !competitor) return "";

        const leftText = leftParts.join(" / ");
        if (leftText && competitor) return `${leftText} — ${competitor}`;
        return leftText || competitor;
    }

    updateSessionInfoOverlay() {
        const text = this.sessionInfoText;

        if (this.refs.replaySessionInfoText) {
            this.refs.replaySessionInfoText.textContent = text;
        }
        if (this.refs.replaySessionInfo) {
            this.refs.replaySessionInfo.classList.remove("hidden");
        }

        if (this.refs.recordSessionInfoText) {
            this.refs.recordSessionInfoText.textContent = text;
        }
        if (this.refs.recordSessionInfo) {
            this.refs.recordSessionInfo.classList.remove("hidden");
        }

    }

    async pollElementNames() {
        try {
            const payload = await apiGet(`/api/elements?ts=${Date.now()}`);
            const nextMap = this.normalizeElementsPayload(payload);
            const nextSessionInfoText = this.buildSessionInfoText(payload);

            // Use a lightweight signature so we only rerender the clip list and
            // overlays when the visible element metadata actually changed.
            const signature = JSON.stringify({
                elements: nextMap,
                sessionInfoText: nextSessionInfoText,
            });

            this.sessionInfoPayload = payload;

            if (signature === this.elementMetaSig) {
                return;
            }

            this.elementMetaSig = signature;
            this.elementMeta = nextMap;
            this.sessionInfoText = nextSessionInfoText;
            this.elementMetaVersion++;

            this.renderClipList();
            this.updateSessionInfoOverlay();
            this.updateReplayStatusPanel();
        } catch {
            // silent fail; we'll try again on the next poll
        }
    }

    getFps() {
        const value = this.state?.sourceFps ?? this.state?.SourceFps ?? 60;
        return Math.max(1, Math.round(Number(value) || 60));
    }

    fmtTimeFrames(sec) {
        const fps = this.getFps();
        const safeSec = Math.max(0, sec || 0);

        const totalWhole = Math.floor(safeSec);
        const minutes = Math.floor(totalWhole / 60);
        const secondsWhole = totalWhole - minutes * 60;

        let frame = Math.floor((safeSec - totalWhole) * fps);
        frame = clamp(frame, 0, fps - 1);

        return `${String(minutes).padStart(2, "0")}:${String(secondsWhole).padStart(2, "0")}:${String(frame).padStart(2, "0")}`;
    }

    fmtMss(sec) {
        const safeSec = Math.max(0, sec || 0);
        const whole = Math.floor(safeSec);
        const minutes = Math.floor(whole / 60);
        const seconds = whole - minutes * 60;
        return `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    fmtSignedMss(sec) {
        const numeric = Number(sec) || 0;
        const sign = numeric < 0 ? "-" : "";
        return `${sign}${this.fmtMss(Math.abs(numeric))}`;
    }

    fmtMmss(sec) {
        const safeSec = Math.max(0, Math.floor(Number(sec) || 0));
        const minutes = Math.floor(safeSec / 60);
        const seconds = safeSec - minutes * 60;
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    currentRecordSeconds() {
        if (!this.state?.isRecording) return 0;
        if (this.localRecStartPerf == null) return 0;
        return (performance.now() - this.localRecStartPerf) / 1000.0;
    }

    resetProgramTimerState() {
        this.programTimerStartOffsetSeconds = null;
        this.programTimerStopOffsetSeconds = null;
        this.programTimerRunning = false;
    }

    clearPendingRecordShortcut() {
        this.pendingRecordShortcut = null;
    }

    hasProgramTimerStarted() {
        return (
            this.programTimerStartOffsetSeconds != null &&
            Number.isFinite(Number(this.programTimerStartOffsetSeconds))
        );
    }

    startProgramTimer() {
        if (this.state?.mode !== "record" || !this.state?.isRecording) return;

        this.programTimerStartOffsetSeconds = this.currentRecordSeconds();
        this.programTimerStopOffsetSeconds = null;
        this.programTimerRunning = true;
        this.updateProgramTimerUI();
    }

    async flushPendingRecordShortcut() {
        if (this.state?.mode !== "record" || !this.state?.isRecording) return;
        if (this.isStartPending || this.isStopPending || this.isClipPending) return;
        if (!this.pendingRecordShortcut) return;

        const pending = this.pendingRecordShortcut;
        if (!this.hasProgramTimerStarted()) {
            this.startProgramTimer();
        }

        this.clearPendingRecordShortcut();

        if (pending === "clip" && this.hasProgramTimerStarted()) {
            await this.toggleClip();
        }
    }

    handleProgramTimerShortcut() {
        if (this.state?.mode !== "record" || this.isStopPending) return;

        this.clearPendingRecordShortcut();

        if (this.state?.isRecording) {
            if (this.hasProgramTimerStarted()) {
                this.stopRecording().catch(console.error);
                return;
            }

            this.startProgramTimer();
            return;
        }

        if (this.isStartPending || this.state?.isArming) {
            // Preserve the keyboard sequence while the backend finishes
            // transitioning into active recording.
            this.pendingRecordShortcut = "timer";
        }
    }

    handleRecordSpaceShortcut() {
        if (this.state?.mode !== "record" || this.isStopPending) return;

        if (this.state?.isRecording && this.hasProgramTimerStarted()) {
            this.clearPendingRecordShortcut();
            this.toggleClip().catch(console.error);
            return;
        }

        if ((this.isStartPending || this.state?.isArming) && this.pendingRecordShortcut === "timer") {
            // If Space arrives just before recording or the program timer is
            // fully ready, carry that intent forward instead of dropping it.
            this.pendingRecordShortcut = "clip";
        }
    }

    stopProgramTimer(stopOffsetSeconds = this.currentRecordSeconds()) {
        if (this.programTimerStartOffsetSeconds == null) return;

        this.programTimerStopOffsetSeconds = Math.max(
            Number(this.programTimerStartOffsetSeconds) || 0,
            Number(stopOffsetSeconds) || 0
        );
        this.programTimerRunning = false;
        this.updateProgramTimerUI();
    }

    currentProgramTimerElapsedSeconds() {
        if (this.programTimerStartOffsetSeconds == null) return 0;

        const start = Number(this.programTimerStartOffsetSeconds);
        if (!Number.isFinite(start)) return 0;

        if (this.programTimerRunning && this.state?.mode === "record" && this.state?.isRecording) {
            return Math.max(0, this.currentRecordSeconds() - start);
        }

        if (this.programTimerStopOffsetSeconds != null) {
            const stop = Number(this.programTimerStopOffsetSeconds);
            if (!Number.isFinite(stop)) return 0;
            return Math.max(0, stop - start);
        }

        return 0;
    }

    getHalfwaySeconds() {
        const seconds = this.getSessionInfoTimeSeconds(this.sessionInfoPayload, "segmentProgHalfTime");
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }

    setReplayPingStatus(kind, state) {
        if (!this.replayPingStatus[kind]) return;

        this.replayPingStatus[kind] = {
            state,
        };
        this.updateReplayStatusPanel();
    }
    getElementCount() {
        return Object.values(this.elementMeta || {}).filter((meta) => {
            const code = (meta?.code ?? "").toString().trim();
            return !!code;
        }).length;
    }

    getReviewCount() {
        return Object.values(this.elementMeta || {}).filter((meta) => {
            const code = (meta?.code ?? "").toString().trim();
            return !!code && !!meta?.review;
        }).length;
    }

    updateReplayStatusPanel() {
        const elementCount = String(this.getElementCount());
        const reviewCount = String(this.getReviewCount());

        const countPairs = [
            [this.refs.replayElementsValue, elementCount],
            [this.refs.replayReviewsValue, reviewCount],
        ];

        for (const [el, value] of countPairs) {
            if (el) el.textContent = value;
        }

        const dotPairs = [
            [this.refs.recordSessionEncoderDot, this.replayPingStatus.encoder],
            [this.refs.replaySessionEncoderDot, this.replayPingStatus.encoder],
            [this.refs.recordSessionCssDot, this.replayPingStatus.css],
            [this.refs.replaySessionCssDot, this.replayPingStatus.css],
        ];

        for (const [dotEl, status] of dotPairs) {
            if (!dotEl || !status) continue;
            dotEl.className = `replayPingDot ${status.state || "idle"}`;
        }
    }

    normalizeCssLinkValue(value) {
        const normalized = String(value || "").trim().toLowerCase();
        if (normalized === "legacy") return "Legacy";
        if (normalized === "custom") return "Custom";
        if (normalized === "new" || normalized === "online css" || normalized === "onlinecss") return "Online CSS";
        if (normalized === "offline css" || normalized === "offlinecss") return "Offline CSS";
        return "None";
    }

    getHostFromDatabaseLocation(value) {
        value = String(value || "").trim();
        if (!value) return "";

        if (/^[A-Za-z]:[\\/]/.test(value)) {
            return "";
        }

        if (/^[a-z]+:\/\//i.test(value)) {
            try {
                return new URL(value).hostname.trim();
            } catch {
            }
        }

        value = value.replace(/^\\\\/, "");

        if (value.includes("\\")) value = value.split("\\")[0];
        if (value.includes("/")) value = value.split("/")[0];
        if (value.includes(",")) value = value.split(",")[0];
        if (value.includes(":")) value = value.split(":")[0];

        return value.trim();
    }

    getHostFromRtspUrl(value) {
        value = String(value || "").trim();
        if (!value) return "";

        try {
            const url = new URL(value);
            return (url.hostname || "").trim();
        } catch {
        }

        value = value.replace(/^rtsp:\/\//i, "");
        value = value.replace(/^rtsps:\/\//i, "");

        const atIndex = value.lastIndexOf("@");
        if (atIndex >= 0) {
            value = value.substring(atIndex + 1);
        }

        if (value.includes("/")) value = value.split("/")[0];

        if (value.startsWith("[")) {
            const endBracket = value.indexOf("]");
            if (endBracket > 0) return value.substring(1, endBracket).trim();
        }

        if (value.includes(":")) value = value.split(":")[0];

        return value.trim();
    }

    async pingHost(host) {
        return await apiGet(`/api/hostping?host=${encodeURIComponent(host)}`);
    }

    applyReplayPingResult(kind, result) {
        if (!result?.ok || typeof result.roundTripMs !== "number") {
            this.setReplayPingStatus(kind, "red");
            return;
        }

        const ms = Math.max(1, Math.round(result.roundTripMs));
        const state = ms < 100 ? "green" : (ms <= 500 ? "yellow" : "red");
        this.setReplayPingStatus(kind, state);
    }

    syncLanguageFromConfig(config) {
        const nextLanguage = this.normalizeLanguage(
            config?.Language ?? config?.language ?? this.currentLanguage
        );

        this.currentLanguage = nextLanguage;
        this.applyTranslations();
    }

    async refreshReplayHostStatuses() {
        if (this.replayHostPollInFlight) return;
        this.replayHostPollInFlight = true;

        try {
            const config = await apiGet(`/api/appconfig?ts=${Date.now()}`);
            this.appConfig = config;
            this.syncLanguageFromConfig(config);

            if (config?.DemoMode) {
                this.setReplayPingStatus("encoder", "disabled");
            } else {
                const encoderHost = this.getHostFromRtspUrl(config?.RtspUrl ?? config?.rtspUrl);
                if (!encoderHost) {
                    this.setReplayPingStatus("encoder", "red");
                } else {
                    try {
                        const result = await this.pingHost(encoderHost);
                        this.applyReplayPingResult("encoder", result);
                    } catch {
                        this.setReplayPingStatus("encoder", "red");
                    }
                }
            }

            const cssLink = this.normalizeCssLinkValue(config?.CSSLink ?? config?.cssLink);

            let cssHost = "";
            let cssDisabled = false;
            if (cssLink === "Legacy") {
                cssHost = this.getHostFromDatabaseLocation(config?.DatabaseLocation ?? config?.databaseLocation);
            } else if (cssLink === "Online CSS") {
                cssHost = this.getHostFromDatabaseLocation("http://css.skatecanada.ca/en");
            } else if (cssLink === "Offline CSS") {
                cssHost = this.getHostFromDatabaseLocation(config?.CSSServerHost ?? config?.cssServerHost);
            } else {
                cssDisabled = true;
            }

            if (cssDisabled) {
                this.setReplayPingStatus("css", "disabled");
            } else if (!cssHost) {
                this.setReplayPingStatus("css", "red");
            } else {
                try {
                    const result = await this.pingHost(cssHost);
                    this.applyReplayPingResult("css", result);
                } catch {
                    this.setReplayPingStatus("css", "red");
                }
            }
        } catch {
            this.setReplayPingStatus("encoder", "red");
            this.setReplayPingStatus("css", "red");
        } finally {
            this.replayHostPollInFlight = false;
        }
    }

    startReplayHostPolling() {
        this.stopReplayHostPolling();
        this.refreshReplayHostStatuses().catch(() => { });
        this.replayHostPollTimerId = window.setInterval(() => {
            this.refreshReplayHostStatuses().catch(() => { });
        }, 5000);
    }

    stopReplayHostPolling() {
        if (this.replayHostPollTimerId != null) {
            clearInterval(this.replayHostPollTimerId);
            this.replayHostPollTimerId = null;
        }
    }

    hasHalfwayMarker() {
        const halfwaySeconds = this.getHalfwaySeconds();
        if (!Number.isFinite(halfwaySeconds) || halfwaySeconds <= 0) return false;

        if (this.programTimerRunning) {
            return this.currentProgramTimerElapsedSeconds() >= halfwaySeconds;
        }

        if (this.programTimerStartOffsetSeconds != null && this.programTimerStopOffsetSeconds != null) {
            return this.currentProgramTimerElapsedSeconds() >= halfwaySeconds;
        }

        return false;
    }

    getHalfwayMarkerAnchorIndex() {
        if (!this.hasHalfwayMarker()) return null;
        if (this.programTimerStartOffsetSeconds == null) return null;

        const cutoffRecordingSeconds =
            Number(this.programTimerStartOffsetSeconds) + Number(this.getHalfwaySeconds() || 0);
        if (!Number.isFinite(cutoffRecordingSeconds)) return null;

        const eps = 0.0005;
        const clips = this.getClips()
            .filter((clip) => {
                const idx = this.clipIdx(clip);
                const start = this.clipStart(clip);
                const end = this.clipEnd(clip);
                return Number.isFinite(idx) && Number.isFinite(start) && Number.isFinite(end) && end > start;
            })
            .sort((a, b) => this.clipIdx(a) - this.clipIdx(b));

        const rawOpenClipStartSeconds = this.state?.openClipStartSeconds;
        const hasOpenClip =
            this.state?.mode === "record" &&
            this.state?.isRecording &&
            rawOpenClipStartSeconds != null &&
            Number.isFinite(Number(rawOpenClipStartSeconds));
        const openClipStartSeconds = hasOpenClip ? Number(rawOpenClipStartSeconds) : null;

        for (const clip of clips) {
            const idx = this.clipIdx(clip);
            const start = this.clipStart(clip);
            const end = this.clipEnd(clip);

            if (cutoffRecordingSeconds < start - eps) {
                return Math.max(0, idx - 1);
            }

            if (cutoffRecordingSeconds <= end + eps) {
                return idx;
            }
        }

        if (
            hasOpenClip &&
            openClipStartSeconds != null &&
            openClipStartSeconds <= cutoffRecordingSeconds + eps &&
            this.currentRecordSeconds() >= cutoffRecordingSeconds - eps
        ) {
            return Math.min(15, clips.length + 1);
        }

        if (clips.length > 0) {
            return this.clipIdx(clips[clips.length - 1]);
        }

        // If halfway is reached before any clip starts, place the marker above
        // the first element slot so the operator still gets a visible boundary.
        return 0;
    }

    fmtProgramTimer(sec) {
        const safeSec = Math.max(0, Number(sec) || 0);
        const totalWhole = Math.floor(safeSec);
        const minutes = Math.floor(totalWhole / 60);
        const secondsWhole = totalWhole - minutes * 60;

        let hundredths = Math.floor((safeSec - totalWhole) * 100 + 1e-6);
        if (hundredths > 99) hundredths = 99;

        return `${String(minutes).padStart(2, "0")}:${String(secondsWhole).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
    }

    updateProgramTimerUI() {
        const { programTimerDisplay, programTimerCard } = this.refs;
        if (!programTimerDisplay) return;

        programTimerDisplay.textContent = this.formatProgramTimerDisplay(this.currentProgramTimerElapsedSeconds());
        programTimerCard?.classList.toggle(
            "stateArmed",
            this.state?.mode === "record" && !!this.state?.isRecording && !this.hasProgramTimerStarted()
        );
        programTimerCard?.classList.toggle("stateRunning", this.hasProgramTimerStarted());
    }

    elementOuterHeight(node) {
        if (!node) return 0;
        if (node.classList?.contains("hidden")) return 0;

        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const marginTop = parseFloat(style.marginTop) || 0;
        const marginBottom = parseFloat(style.marginBottom) || 0;
        return rect.height + marginTop + marginBottom;
    }

    applyHeightIfChanged(node, px) {
        if (!node) return;

        const current = parseFloat(node.style.height || "0") || 0;
        if (Math.abs(current - px) <= 1) return;
        node.style.height = `${px}px`;
    }

    fitModeHeights() {
        if (!this.state) return;

        const container = document.querySelector(".container");
        const containerH = container?.clientHeight || window.innerHeight;
        const style = container ? getComputedStyle(container) : null;
        const padTop = style ? parseFloat(style.paddingTop) || 0 : 0;
        const padBottom = style ? parseFloat(style.paddingBottom) || 0 : 0;

        // Top-row media area expands to fill whatever space remains after the
        // timeline and replay controls take their share.
        const below =
            this.elementOuterHeight(this.refs.timelineRow) +
            (this.state.mode === "replay" ? this.elementOuterHeight(this.refs.replayControlsRow) : 0);

        const available = Math.max(140, Math.floor(containerH - below - padTop - padBottom));

        if (this.state.mode === "record") {
            if (!this.refs.recordTopRow || !this.refs.liveWrap) return;
            this.applyHeightIfChanged(this.refs.recordTopRow, available);
            this.applyHeightIfChanged(this.refs.liveWrap, available);
            return;
        }

        if (!this.refs.replayTopRow) return;
        this.applyHeightIfChanged(this.refs.replayTopRow, available);

        const wrap = this.replay.ensureReplayVideoWrap();
        if (wrap) this.applyHeightIfChanged(wrap, available);
        this.replay.applyZoom();
    }

    syncClipListHeightToVideo() {
        if (!this.refs.leftControls || !this.refs.clipList) return;

        let availableHeight = 0;
        if (this.state?.mode === "record") {
            availableHeight =
                this.refs.recordTopRow?.getBoundingClientRect().height ||
                this.refs.liveWrap?.getBoundingClientRect().height ||
                0;
        } else {
            availableHeight =
                this.refs.replayTopRow?.getBoundingClientRect().height ||
                this.replay.ensureReplayVideoWrap()?.getBoundingClientRect().height ||
                0;
        }

        if (!availableHeight || availableHeight < 50) return;

        const target = Math.max(120, Math.floor(availableHeight));
        this.refs.leftControls.style.height = `${target}px`;
    }

    updateReplayButtonOffset() {
        const {
            replayControlsRow,
            replayControlsInner,
            replayLeftGroup,
            replayButtonsWrap,
            replayRightGroup,
        } = this.refs;

        if (
            !replayControlsRow ||
            replayControlsRow.classList.contains("hidden") ||
            !replayControlsInner ||
            !replayLeftGroup ||
            !replayButtonsWrap ||
            !replayRightGroup
        ) {
            if (replayButtonsWrap) replayButtonsWrap.style.transform = "";
            return;
        }

        // Keep the transport cluster visually centered while nudging it just
        // enough to avoid colliding with the left/right control groups.
        // Measure at the natural centered position first to avoid oscillation
        // across repeated layout passes.
        const innerRect = replayControlsInner.getBoundingClientRect();
        const leftRect = replayLeftGroup.getBoundingClientRect();
        const rightRect = replayRightGroup.getBoundingClientRect();
        const middleWidth = replayButtonsWrap.offsetWidth || replayButtonsWrap.getBoundingClientRect().width;

        const centeredLeft = innerRect.left + (innerRect.width - middleWidth) / 2;
        const centeredRight = centeredLeft + middleWidth;

        const gap = 8;
        const needRight = Math.max(0, (leftRect.right + gap) - centeredLeft);
        const roomRight = Math.max(0, (rightRect.left - gap) - centeredRight);
        const shift = Math.max(0, Math.min(needRight, roomRight));

        replayButtonsWrap.style.transform =
            shift > 0.5 ? `translateX(${Math.round(shift)}px)` : "";
    }

    scheduleLayout() {
        if (this.layoutScheduled) return;
        this.layoutScheduled = true;

        requestAnimationFrame(() => {
            this.layoutScheduled = false;
            this.fitModeHeights();
            this.syncClipListHeightToVideo();
            this.updateReplayButtonOffset();
        });
    }

    refreshLiveSurfaceAfterModeChange() {
        const { liveWrap, liveFrame } = this.refs;
        if (!liveWrap || !liveFrame) return;

        requestAnimationFrame(() => {
            this.scheduleLayout();

            // WebView/iframe composition can occasionally leave stale pixels
            // behind after switching back from replay. Briefly toggling the
            // live container and iframe forces a repaint without changing app state.
            const previousWrapDisplay = liveWrap.style.display;
            const previousDisplay = liveFrame.style.display;
            liveWrap.style.display = "none";
            liveFrame.style.display = "none";
            void liveWrap.offsetHeight;
            liveWrap.style.display = previousWrapDisplay;
            liveFrame.style.display = previousDisplay;

            requestAnimationFrame(() => this.scheduleLayout());
        });
    }

    ensureLayoutObserver() {
        if (this.ro) return;

        this.ro = new ResizeObserver(() => this.scheduleLayout());

        if (this.refs.recordMode) this.ro.observe(this.refs.recordMode);
        if (this.refs.replayMode) this.ro.observe(this.refs.replayMode);

        const rightContent = document.querySelector(".rightContent");
        if (rightContent) this.ro.observe(rightContent);

        if (this.refs.timelineRow) this.ro.observe(this.refs.timelineRow);
        if (this.refs.replayControlsRow) this.ro.observe(this.refs.replayControlsRow);

        window.addEventListener("resize", () => this.scheduleLayout());
    }

    setMode(mode) {
        // Record and replay share many DOM nodes, so switching modes is mostly
        // a matter of moving the shared widgets into the right host containers.
        document.body.classList.toggle("replayActive", mode === "replay");

        if (this.currentDomMode !== mode) {
            if (mode === "record") {
                this.refs.recordMode.classList.remove("hidden");
                this.refs.replayMode.classList.add("hidden");
                this.replay.resetZoom();
                this.refreshLiveSurfaceAfterModeChange();
            } else {
                this.refs.recordMode.classList.add("hidden");
                this.refs.replayMode.classList.remove("hidden");
                this.replay.ensureReplayVideoWrap();
                this.replay.applyZoom();
            }
            this.currentDomMode = mode;
        }

        if (mode === "record") {
            if (
                this.refs.mainBtnHostRecord &&
                this.refs.mainBtn &&
                this.refs.mainBtn.parentElement !== this.refs.mainBtnHostRecord
            ) {
                this.refs.mainBtnHostRecord.appendChild(this.refs.mainBtn);
            }
        } else {
            if (
                this.refs.mainBtnHostReplay &&
                this.refs.mainBtn &&
                this.refs.mainBtn.parentElement !== this.refs.mainBtnHostReplay
            ) {
                this.refs.mainBtnHostReplay.appendChild(this.refs.mainBtn);
            }
        }

        if (this.refs.replayControlsRow) {
            this.refs.replayControlsRow.classList.toggle("hidden", mode !== "replay");
        }

        if (this.refs.replayScrub) {
            this.refs.replayScrub.classList.toggle("hidden", mode !== "replay");
            this.refs.replayScrub.disabled = mode !== "replay";
        }

        this.applyEditModeUI();
        this.updateEditButtonsUI();
        this.updateSessionInfoOverlay();
        this.shortcuts.refreshOverlay();
        this.scheduleLayout();
    }

    setMainButtonVisual(kind) {
        const button = this.refs.mainBtn;
        if (!button) return;

        this.currentMainButtonKind = kind;
        button.classList.remove("btnGreen", "btnRed", "btnBlue", "btnTimerArm", "btnStarting");

        if (kind === "start") {
            button.classList.add("btnGreen");
            button.innerHTML = this.t("mainStartRecordingHtml");
            button.setAttribute("aria-label", this.t("mainStartRecordingAria"));
        } else if (kind === "timer") {
            button.classList.add("btnGreen", "btnTimerArm");
            button.innerHTML = this.t("mainStartTimerHtml");
            button.setAttribute("aria-label", this.t("mainStartTimerAria"));
        } else if (kind === "starting") {
            button.classList.add("btnBlue", "btnStarting");
            button.innerHTML = this.t("mainStartingHtml");
            button.setAttribute("aria-label", this.t("mainStartingAria"));
        } else if (kind === "stop") {
            button.classList.add("btnRed");
            button.innerHTML = this.t("mainStopRecordingHtml");
            button.setAttribute("aria-label", this.t("mainStopRecordingAria"));
        } else if (kind === "stopping") {
            button.classList.add("btnRed");
            button.innerHTML = this.t("mainStoppingHtml");
            button.setAttribute("aria-label", this.t("mainStoppingAria"));
        } else {
            button.classList.add("btnBlue");
            button.innerHTML = this.t("mainNextCompetitorHtml");
            button.setAttribute("aria-label", this.t("mainNextCompetitorAria"));
        }

        this.applyButtonImage(button, kind);
    }

    renderClipList() {
        const clipList = this.refs.clipList;
        if (!clipList) return;

        clipList.style.gridTemplateRows = "repeat(15, minmax(0, 1fr))";
        const clips = this.getClips();
        const clipMap = new Map();

        // Build a cheap render key so we can skip rebuilding the list when the
        // clip geometry and element metadata are unchanged.
        let key = "";
        for (const clip of clips) {
            const idx = this.clipIdx(clip);
            const start = this.clipStart(clip);
            const end = this.clipEnd(clip);
            if (Number.isFinite(idx) && Number.isFinite(start) && Number.isFinite(end) && end > start) {
                key += `${idx}:${Math.round(start * 1000)}-${Math.round(end * 1000)}|`;
                clipMap.set(idx, clip);
            }
        }
        const halfwayMarkerAnchorIndex = this.getHalfwayMarkerAnchorIndex();
        const openClipPlaceholderIndex = this.getOpenClipPlaceholderIndex();
        const loopingClipIdx = this.getLoopingClipIndex();
        key += `|meta:${this.elementMetaVersion}|halfway:${halfwayMarkerAnchorIndex ?? "none"}|open:${openClipPlaceholderIndex ?? "none"}|loop:${loopingClipIdx ?? "none"}`;

        if (clipList.dataset.key === key) return;
        clipList.dataset.key = key;
        clipList.innerHTML = "";

        for (let i = 1; i <= 15; i++) {
            const clip = clipMap.get(i);
            clipList.appendChild(this.buildClipListSlot(i, clip, halfwayMarkerAnchorIndex, openClipPlaceholderIndex));
        }
    }

    addHalfwayMarkerClasses(container, index, halfwayMarkerAnchorIndex) {
        if (halfwayMarkerAnchorIndex === 0 && index === 1) {
            container.classList.add("hasHalfwayMarkerBefore");
        }
        if (halfwayMarkerAnchorIndex === index) {
            container.classList.add("hasHalfwayMarkerAfter");
        }
    }

    buildClipListSlot(index, clip, halfwayMarkerAnchorIndex, openClipPlaceholderIndex) {
        if (clip) {
            const meta = this.elementMeta?.[index] ?? null;
            const code = (meta?.code ?? "").toString().trim();
            const review = !!meta?.review;
            const start = this.clipStart(clip);
            const end = this.clipEnd(clip);
            const isLooping = this.isLoopingClip(index, start, end);
            const button = document.createElement("button");
            button.type = "button";
            button.className = `clipBtn${review ? " isReview" : ""}${isLooping ? " isLooping" : ""}`;
            button.dataset.clipIndex = String(index);
            button.setAttribute("aria-pressed", isLooping ? "true" : "false");
            this.addHalfwayMarkerClasses(button, index, halfwayMarkerAnchorIndex);
            this.appendClipListEntryContent(button, index, code || "[ element ]");
            return button;
        }

        const slot = document.createElement("div");
        slot.className = index === openClipPlaceholderIndex ? "clipSlotEmpty clipSlotPending" : "clipSlotEmpty";
        this.addHalfwayMarkerClasses(slot, index, halfwayMarkerAnchorIndex);
        if (index === openClipPlaceholderIndex) {
            this.appendClipListEntryContent(slot, index, "Clipping...");
        }
        return slot;
    }

    getLoopingClipIndex() {
        const loop = this.replay?.elementLoop;
        if (
            !loop ||
            !Number.isFinite(loop.startSeconds) ||
            !Number.isFinite(loop.endSeconds)
        ) {
            return null;
        }

        const clip = this.findClipBySegment(loop, 0.02);
        return clip ? this.clipIdx(clip) : null;
    }

    appendClipListEntryContent(container, index, text) {
        const left = document.createElement("div");
        left.className = "clipBtnNum";
        left.textContent = String(index);

        const right = document.createElement("div");
        right.className = "clipBtnInfo";

        const top = document.createElement("div");
        top.className = "clipBtnCode";
        top.textContent = text;

        right.appendChild(top);
        container.appendChild(left);
        container.appendChild(right);
    }

    updateRecordClipButtonsUI() {
        const { clipToggleBtn, clipToggleRailHost, undoClipBtn, redoClipBtn } = this.refs;
        if (!clipToggleBtn || !undoClipBtn || !redoClipBtn) return;

        const inRecord = this.state?.mode === "record";
        const recording = !!this.state?.isRecording;
        const open = recording && this.state?.openClipStartSeconds != null;
        const canStartClip = recording && (open || this.hasProgramTimerStarted());
        const canUndo = recording && !!this.state?.canUndoClipAction;
        const canRedo = recording && !!this.state?.canRedoClipAction;

        clipToggleBtn.classList.toggle("hidden", !inRecord);
        clipToggleRailHost?.classList.toggle("hidden", !inRecord);
        undoClipBtn.classList.toggle("hidden", !inRecord);
        redoClipBtn.classList.toggle("hidden", !inRecord);

        clipToggleBtn.classList.remove("clipStart", "clipStop");
        clipToggleBtn.classList.add(open ? "clipStop" : "clipStart");

        if (this.isClipPending) {
            clipToggleBtn.disabled = true;
            undoClipBtn.disabled = true;
            redoClipBtn.disabled = true;
            clipToggleBtn.textContent = open ? this.t("clipStopping") : this.t("clipStarting");
            clipToggleBtn.setAttribute("aria-label", open ? this.t("clipStoppingAria") : this.t("clipStartingAria"));
            undoClipBtn.textContent = this.t("undo");
            undoClipBtn.setAttribute("aria-label", this.t("undoAria"));
            redoClipBtn.textContent = this.t("redo");
            redoClipBtn.setAttribute("aria-label", this.t("redoAria"));
            this.applyButtonImage(clipToggleBtn, open ? "clipStop" : "clipStart");
            this.applyButtonImage(undoClipBtn, "undo");
            this.applyButtonImage(redoClipBtn, "redo");
            return;
        }

        clipToggleBtn.disabled = !canStartClip;
        undoClipBtn.disabled = !canUndo;
        redoClipBtn.disabled = !canRedo;

        if (open) {
            clipToggleBtn.textContent = this.t("clipStop");
            clipToggleBtn.setAttribute("aria-label", this.t("clipStopAria"));
        } else {
            clipToggleBtn.textContent = this.t("clipStart");
            clipToggleBtn.setAttribute("aria-label", this.t("clipStartAria"));
        }

        undoClipBtn.textContent = this.t("undo");
        undoClipBtn.setAttribute("aria-label", this.t("undoAria"));
        redoClipBtn.textContent = this.t("redo");
        redoClipBtn.setAttribute("aria-label", this.t("redoAria"));

        this.applyButtonImage(clipToggleBtn, open ? "clipStop" : "clipStart");
        this.applyButtonImage(undoClipBtn, "undo");
        this.applyButtonImage(redoClipBtn, "redo");
    }

    updateClipTimerUI() {
        const { clipTimerCard, clipTime } = this.refs;
        if (!clipTimerCard || !clipTime) return;

        const recording = !!this.state?.isRecording;
        const openStart = this.state?.openClipStartSeconds;

        const running = recording && openStart != null && Number.isFinite(Number(openStart));

        if (!running) {
            clipTime.textContent = this.formatClipTimerDisplay(0);
            return;
        }

        const elapsed = Math.max(0, this.currentRecordSeconds() - Number(openStart));
        clipTime.textContent = this.formatClipTimerDisplay(elapsed);
    }

    updateUI() {
        if (!this.state) return;

        // updateUI is the main render pass. It reads the latest backend-backed
        // state plus local pending flags and reconciles the DOM to match.
        this.ensureEditToggle();
        const arming = !!this.state.isArming;
        const uiMode = (this.isStartPending || arming) ? "record" : this.state.mode;
        this.setMode(uiMode);

        const inRecord = uiMode === "record";
        const recording = !!this.state.isRecording;

        if (this.refs.replayProgramTimeIndicator) {
            this.refs.replayProgramTimeIndicator.classList.toggle("hidden", uiMode !== "replay");
        }
        if (this.refs.recordTimerCard) this.refs.recordTimerCard.setAttribute("aria-hidden", uiMode === "record" ? "false" : "true");
        if (this.refs.programTimerCard) this.refs.programTimerCard.setAttribute("aria-hidden", uiMode === "record" ? "false" : "true");
        if (this.refs.clipTimerCard) this.refs.clipTimerCard.setAttribute("aria-hidden", uiMode === "record" ? "false" : "true");
        if (this.refs.recLamp) this.refs.recLamp.classList.toggle("on", inRecord && recording);

        if (uiMode === "record") {
            if (this.isStopPending) {
                this.setMainButtonVisual("stopping");
            } else if (!recording && (this.isStartPending || arming)) {
                this.setMainButtonVisual("starting");
            } else {
                this.setMainButtonVisual(recording ? (this.hasProgramTimerStarted() ? "stop" : "timer") : "start");
            }

            if (recording) {
                if (this.refs.recordTimerValue) this.refs.recordTimerValue.textContent = this.formatRecordingTimerDisplay(this.currentRecordSeconds());
            } else if (this.refs.recordTimerValue) {
                this.refs.recordTimerValue.textContent = this.formatRecordingTimerDisplay(0);
            }

            this.updateClipTimerUI();
            this.timeline.draw();
        } else {
            this.setMainButtonVisual("next");

            // Replay always uses the encoded file in the main operator UI.
            // Remote clients use the smaller `kind=remote` asset instead.
            if (!this.refs.replayVideo.src || !this.refs.replayVideo.src.includes("/api/recording/file")) {
                this.refs.replayVideo.src = `/api/recording/file?kind=encoded&ts=${Date.now()}`;
                this.refs.replayVideo.load();
                this.replay.resetZoom();
            }

            this.syncSelectedClipToState();
            this.timeline.draw();
            this.replay.syncScrubFromVideo();
            this.replay.updateReplayTimerAndSpeed();
        }

        if (this.refs.mainBtn) {
            this.refs.mainBtn.disabled = this.isStopPending;
        }

        this.updateRecordClipButtonsUI();
        this.updateProgramTimerUI();
        this.renderClipList();
        this.updateSessionInfoOverlay();
        this.updateReplayStatusPanel();
        this.replay.updateLoopButtonsUI();
        this.applyEditModeUI();
        this.updateEditButtonsUI();

        this.ensureLayoutObserver();
        this.scheduleLayout();
    }

    async refreshLiveUrl() {
        const response = await apiGet("/api/liveUrl");
        this.currentLiveMode = response.mode === "demo" ? "demo" : "rtsp";
        if (this.refs.liveFrame) this.refs.liveFrame.src = response.url;
    }

    applyStatusUpdate(nextState) {
        const previousRecordSeconds = this.currentRecordSeconds();
        const prevMode = this.state?.mode;
        const prevArming = this.state?.isArming;
        const prevRecording = this.state?.isRecording;

        // While recording, the UI timer runs from local perf time between polls
        // so the operator sees a smooth clock instead of 500ms jumps.
        if (nextState.isRecording) {
            if (this.localRecStartPerf == null) this.localRecStartPerf = performance.now();
        } else {
            this.localRecStartPerf = null;
        }

        this.state = nextState;

        if (!prevRecording && this.state.isRecording) {
            this.resetProgramTimerState();
        }

        if (prevRecording && !this.state.isRecording && this.programTimerRunning) {
            this.stopProgramTimer(previousRecordSeconds);
        }

        // Entering replay arms the first clip for quick review and starts the
        // separate review-duration timer shown in the replay UI.
        if (prevMode !== "replay" && this.state.mode === "replay") {
            this.replay.autoLoopClip1 = true;
            this.replay.reviewStartPerf = performance.now();
            this.replay.updateReviewTimer();
        }

        if (prevMode === "replay" && this.state.mode !== "replay") {
            this.replay.reviewStartPerf = null;
            this.replay.updateReviewTimer();
        }

        if (this.isStartPending && this.state.isRecording) {
            this.isStartPending = false;
            this.lastRecordStartRequestPerf = 0;
            if (this.currentLiveMode === "demo") {
                this.resumeDemoLiveAfterStart();
            }
        }

        if (this.isStopPending && !this.state.isRecording) {
            this.isStopPending = false;
        }

        if (this.state.mode !== "record" || (!this.state.isRecording && !this.isStartPending && !this.state.isArming)) {
            this.clearPendingRecordShortcut();
        }

        this.syncPendingUi();

        this.flushPendingRecordShortcut().catch(console.error);

        if (
            prevMode !== this.state.mode ||
            prevArming !== this.state.isArming ||
            prevRecording !== this.state.isRecording
        ) {
            this.scheduleLayout();
        }
    }

    async pollStatus() {
        const nextState = await apiGet("/api/status");
        this.applyStatusUpdate(nextState);
    }

    async startRecording() {
        if (this.isStartPending || this.isStopPending) return;

        this.clearPendingRecordShortcut();
        this.lastRecordStartRequestPerf = performance.now();
        this.setMainButtonVisual("starting");
        this.isStartPending = true;
        this.syncPendingUi();

        try {
            let demoStartSeconds = null;

            // Demo mode needs the current demo-video position so the backend
            // can start recording from the same point the operator is seeing.
            if (this.currentLiveMode === "demo") {
                try {
                    demoStartSeconds =
                        this.refs.liveFrame?.contentWindow?.document?.getElementById("demoVideo")?.currentTime ?? 0;
                } catch {
                    demoStartSeconds = 0;
                }
                this.pauseDemoLiveAt(demoStartSeconds);
            }

            const nextState = await apiPost("/api/record/start", { demoStartSeconds });
            this.resetProgramTimerState();
            this.applyStatusUpdate(nextState);
        } catch (err) {
            this.isStartPending = false;
            this.lastRecordStartRequestPerf = 0;
            if (this.currentLiveMode === "demo") {
                this.resumeDemoLiveAfterStart();
            }
            throw err;
        } finally {
            this.syncPendingUi();
        }
    }

    async stopRecording() {
        if (this.isStartPending || this.isStopPending) return;

        this.clearPendingRecordShortcut();
        this.isStopPending = true;
        this.syncPendingUi();

        try {
            // Send the locally measured elapsed time so the backend can close
            // the recording/last clip using the same operator-visible clock.
            const uiElapsedSeconds = this.currentRecordSeconds();

            if (this.programTimerRunning) {
                this.stopProgramTimer(uiElapsedSeconds);
            }

            const nextState = await apiPost("/api/record/stop", { uiElapsedSeconds });

            this.localRecStartPerf = null;
            this.replay.stopReverse();
            this.replay.clearElementLoop();
            this.replay.resetManualLoop();
            this.replay.setActiveSpeedIdx(null);
            this.setSelectedClipIdx(null);

            this.applyStatusUpdate(nextState);

            // Re-arm the replay startup loop for the final replay-file load
            // triggered here. Entering replay mode already arms this once, but
            // that earlier load can complete before this fresh `ts=` reload.
            this.replay.autoLoopClip1 = true;
            this.refs.replayVideo.src = `/api/recording/file?kind=encoded&ts=${Date.now()}`;
            this.refs.replayVideo.load();

            this.replay.resetZoom();
        } finally {
            this.isStopPending = false;
            this.syncPendingUi();
        }
    }

    async toggleClip() {
        if (this.isClipPending || this.isStartPending || this.isStopPending) return;

        const isStartingClip = this.state?.openClipStartSeconds == null;
        if (isStartingClip && !this.hasProgramTimerStarted()) return;

        this.suppressOpenClipPlaceholder = false;
        this.pendingOpenClipSlotIndex = isStartingClip ? this.getNextAvailableClipSlotIndex() : null;
        this.isClipPending = true;
        this.syncPendingUi();

        try {
            let now = this.currentRecordSeconds();

            if (this.state?.openClipStartSeconds == null) {
                // Starting a clip is allowed to reach slightly backward so the
                // saved element includes the immediate lead-in the operator just
                // saw before pressing the button.
                now = Math.max(0, now - this.getClipMarkerAdvanceSeconds());

                let lastClosedClipEnd = 0;
                for (const clip of this.getClips()) {
                    const end = this.clipEnd(clip);
                    if (Number.isFinite(end) && end > lastClosedClipEnd) {
                        lastClosedClipEnd = end;
                    }
                }

                now = Math.max(now, lastClosedClipEnd);
            }

            const nextState = await apiPost("/api/record/clipToggle", { nowSeconds: now });
            this.applyStatusUpdate(nextState);
        } finally {
            this.isClipPending = false;
            this.pendingOpenClipSlotIndex = null;
            this.suppressOpenClipPlaceholder = false;
            this.syncPendingUi();
        }
    }

    async undoClipAction() {
        if (this.isClipPending || this.isStartPending || this.isStopPending) return;
        const hidOpenClipPlaceholder = this.getOpenClipPlaceholderIndex() != null;

        if (hidOpenClipPlaceholder) {
            this.pendingOpenClipSlotIndex = null;
            this.suppressOpenClipPlaceholder = true;
            this.updateUI();
        }

        try {
            const nextState = await apiPost("/api/record/undo");
            this.applyStatusUpdate(nextState);
        } finally {
            if (hidOpenClipPlaceholder) {
                this.suppressOpenClipPlaceholder = false;
                this.updateUI();
            }
        }
    }

    async redoClipAction() {
        if (this.isClipPending || this.isStartPending || this.isStopPending) return;

        this.isClipPending = true;
        this.syncPendingUi();
        try {
            const nextState = await apiPost("/api/record/redo");
            this.applyStatusUpdate(nextState);
        } finally {
            this.isClipPending = false;
            this.syncPendingUi();
        }
    }

    async clearSession() {
        // "Next competitor" resets both backend session data and all replay-
        // local interaction state so the next recording starts cleanly.
        this.clearPendingRecordShortcut();
        this.replay.stopReverse();
        this.replay.clearElementLoop();
        this.replay.resetManualLoop();
        this.replay.setActiveSpeedIdx(null);
        this.setSelectedClipIdx(null);
        this.replay.reviewStartPerf = null;
        this.replay.updateReviewTimer();

        this.refs.replayVideo.pause();

        await apiPost("/api/session/clear");
        this.localRecStartPerf = null;
        this.resetProgramTimerState();

        this.refs.replayVideo.removeAttribute("src");
        this.refs.replayVideo.load();

        this.replay.resetZoom();

        await this.pollStatus();
        await this.pollElementNames();
        await this.refreshLiveUrl();
        this.refreshLiveSurfaceAfterModeChange();
    }

    showConfirm({
        text = this.t("confirmGenericText"),
        yesText = this.t("confirmYes"),
        cancelText = this.t("confirmCancel"),
    } = {}) {
        if (this.confirmResolve) this.hideConfirm(false);

        if (this.refs.confirmText) this.refs.confirmText.textContent = text;
        if (this.refs.confirmYes) this.refs.confirmYes.textContent = yesText;
        if (this.refs.confirmCancel) this.refs.confirmCancel.textContent = cancelText;

        this.refs.confirmModal?.classList.remove("hidden");

        return new Promise((resolve) => {
            this.confirmResolve = resolve;
        });
    }

    hideConfirm(result = false) {
        this.refs.confirmModal?.classList.add("hidden");

        const resolve = this.confirmResolve;
        this.confirmResolve = null;

        if (resolve) resolve(!!result);
    }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
    const app = new ElementReviewApp();
    window.elementReviewApp = app;
    app.init().catch((err) => alert(err.message || err));
}
