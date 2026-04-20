import { BTN_DIR, BTN_SIZE, approxEqual, clamp, isTypingTarget, apiPost } from "./app-utils.js";

// ReplayController manages replay-local behavior such as transport, scrubbing,
// loops, zoom, and clip edits while ElementReviewApp keeps the shared session state.
const SPEED_BUTTON_DEFS = [
    { label: "REVERSE 1X", display: "Reverse 1x", def: -1.0, icon: "play-rev-1x.png" },
    { label: "QUARTER SPEED", display: "Slower", def: 0.25, icon: "play-025x.png" },
    { label: "HALF SPEED", display: "Slow", def: 0.5, icon: "play-05x.png" },
    { label: "PLAY", display: "Play", def: 1.0, icon: "play-1x.png" },
    { label: "FAST 1.5X", display: "Fast 1.5x", def: 1.5, icon: "play-1_5x.png" },
    { label: "FAST 2X", display: "Fast", def: 2.0, icon: "play-2x.png" },
];

const REPLAY_SCRUB_MAX = 10000;

export class ReplayController {
    constructor(app) {
        this.app = app;

        this.replayVideoWrap = null;
        this.zoomState = { scale: 1.0, tx: 0.0, ty: 0.0 };

        this.reversePlaying = false;
        this.reverseTimer = null;
        this.reverseSpeedAbs = 0.5;
        this.reverseRaf = null;
        this.isScrubbing = false;

        this.playbackSpeeds = SPEED_BUTTON_DEFS.map((x) => x.def);
        this.activeSpeedIdx = null;
        this.elementLoop = null;
        this.autoLoopClip1 = false;

        this.manualLoopSeg = null;
        this.manualLoop = { phase: "idle", startSeconds: null };
        this.loopPlaybackSpeed = 0.5;
        this.reviewStartPerf = null;

        this.arrowHoldKey = null;
        this.arrowHoldTimer = null;
        this.arrowHoldPlaying = false;
        this.rafId = null;
    }

    init() {
        const { loopInBtn, loopOutBtn, loopClearBtn } = this.app.refs;

        this.ensureReplayVideoWrap();
        this.resetZoom();
        this.loadPlaybackConfig();
        this.updateLoopButtonsUI();
        if (this.app.refs.replayScrub) {
            this.app.refs.replayScrub.max = String(this.scrubMaxForVideoEnd());
        }

        if (loopInBtn) {
            loopInBtn.innerHTML = `<img src="${BTN_DIR}/loop_in.png" width="${BTN_SIZE}" height="${BTN_SIZE}" alt="" draggable="false">`;
        }

        if (loopOutBtn) {
            loopOutBtn.innerHTML = `<img src="${BTN_DIR}/loop_out.png" width="${BTN_SIZE}" height="${BTN_SIZE}" alt="" draggable="false">`;
        }

        if (loopClearBtn) {
            loopClearBtn.innerHTML = `<img src="${BTN_DIR}/loop_clear.png" width="${BTN_SIZE}" height="${BTN_SIZE}" alt="" draggable="false">`;
        }
    }

    // Wire replay DOM events. Keyboard routing is handled in app-shortcut-keys.js.
    bindEvents() {
        const refs = this.app.refs;

        refs.loopInBtn?.addEventListener("click", () => {
            this.handleLoopInPress().catch(console.error);
        });

        refs.loopOutBtn?.addEventListener("click", () => {
            this.handleLoopOutPress().catch(console.error);
        });

        refs.loopClearBtn?.addEventListener("click", () => {
            this.handleLoopClearPress().catch(console.error);
        });

        refs.replayButtonsWrap?.addEventListener("click", async (event) => {
            const button = event.target.closest("button.speedBtn, button.seekJumpBtn");
            if (!button) return;
            if (!this.app.state || this.app.state.mode !== "replay") return;

            if (button.classList.contains("seekJumpBtn")) {
                const deltaSeconds = Number(button.dataset.seekSeconds);
                if (!Number.isFinite(deltaSeconds)) return;

                await this.jumpBySeconds(deltaSeconds);
                return;
            }

            const idx = Number(button.dataset.idx);
            const speed = parseFloat(button.dataset.play);
            if (!Number.isFinite(idx) || !Number.isFinite(speed)) return;

            const playing = this.isPlaying();
            const currentSpeed = this.currentPlaySpeed();

            if (playing && approxEqual(currentSpeed, speed)) {
                this.stopReverse();
                refs.replayVideo.pause();
                this.setActiveSpeedIdx(null);
                this.updateReplayTimerAndSpeed();
                return;
            }

            if (this.manualLoop.phase === "set" && this.manualLoopSeg) {
                const { startSeconds, endSeconds } = this.manualLoopSeg;
                const t = Number(refs.replayVideo.currentTime || 0);
                if (t < startSeconds || t > endSeconds) {
                    await this.seekTo(startSeconds);
                }
            }

            if (speed < 0) this.startReversePlayback(Math.abs(speed));
            else this.playForward(speed);

            this.setActiveSpeedIdx(idx);
            this.updateReplayTimerAndSpeed();
        });

        refs.replayScrub?.addEventListener("pointerdown", () => {
            if (this.app.state?.mode !== "replay") return;

            this.isScrubbing = true;
            this.stopReverse();
            refs.replayVideo.pause();
            this.setActiveSpeedIdx(null);
            this.updateReplayTimerAndSpeed();
        });

        refs.replayScrub?.addEventListener("pointerup", () => {
            this.isScrubbing = false;
        });

        refs.replayScrub?.addEventListener("pointercancel", () => {
            this.isScrubbing = false;
        });

        refs.replayScrub?.addEventListener("input", () => {
            if (this.app.state?.mode !== "replay") return;

            this.stopReverse();
            refs.replayVideo.pause();
            this.setActiveSpeedIdx(null);
            this.clearElementLoop();

            const duration = this.getReplayDurSeconds();
            const total = this.getReplayTotalSeconds();
            if (!duration || duration <= 0.01 || !total) return;

            const maxValue = this.scrubMaxForVideoEnd();
            let scrubValue = clamp(parseInt(refs.replayScrub.value, 10) || 0, 0, maxValue);
            if (String(scrubValue) !== refs.replayScrub.value) {
                refs.replayScrub.value = String(scrubValue);
            }

            const fraction = maxValue > 0 ? scrubValue / maxValue : 0;
            let time = fraction * total;
            time = clamp(time, 0, duration);
            time = this.replayUiSeconds(time);

            refs.replayVideo.currentTime = time;
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();
        });

        refs.timelineOverlay?.addEventListener("pointerdown", async (event) => {
            if (!this.app.state || this.app.state.mode !== "replay") return;
            if (event.target === refs.replayScrub) return;

            const duration = this.getReplayDurSeconds();
            const total = this.getReplayTotalSeconds();
            if (!duration || duration <= 0.01 || !total) return;

            const rect = refs.timelineOverlay.getBoundingClientRect();
            const x = clamp(event.clientX - rect.left, 0, rect.width);
            const fraction = rect.width > 1 ? x / rect.width : 0;

            this.stopReverse();
            refs.replayVideo.pause();
            this.setActiveSpeedIdx(null);
            this.clearElementLoop();

            let time = fraction * total;
            time = clamp(time, 0, duration);
            time = this.replayUiSeconds(time);

            await this.seekTo(time);
            this.syncScrubFromVideo();
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();
        });

        refs.timelineOverlay?.addEventListener("dblclick", (event) => {
            if (!this.app.state || this.app.state.mode !== "replay") return;

            const duration = this.getReplayDurSeconds();
            const total = this.getReplayTotalSeconds();
            if (!duration || duration <= 0.01 || !total) return;

            const rect = refs.timelineOverlay.getBoundingClientRect();
            const x = clamp(event.clientX - rect.left, 0, rect.width);
            const fraction = rect.width > 1 ? x / rect.width : 0;

            let time = fraction * total;
            time = clamp(time, 0, duration);
            time = this.replayUiSeconds(time);

            const hit = this.app.findClipAtTime(time);
            if (!hit) return;

            const idx = this.app.clipIdx(hit);
            const start = this.app.clipStart(hit);
            const end = this.app.clipEnd(hit);
            if (!Number.isFinite(idx) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
            if (this.app.isSelectedClip(idx, start, end)) return;

            event.preventDefault();
            this.selectClipAndAutoPlay(idx).catch(console.error);
        });

        refs.deleteBtn?.addEventListener("click", () => {
            this.doDeleteSelectedClip().catch(alert);
        });

        refs.splitBtn?.addEventListener("click", () => {
            this.doSplitSelectedClip().catch(alert);
        });

        refs.trimInBtn?.addEventListener("click", () => {
            this.doTrimIn().catch(alert);
        });

        refs.trimOutBtn?.addEventListener("click", () => {
            this.doTrimOut().catch(alert);
        });

        refs.insertBtn?.addEventListener("click", () => {
            this.doInsertClip().catch(alert);
        });

        refs.replayVideo?.addEventListener("loadedmetadata", () => {
            // Metadata is the first moment when duration and video dimensions
            // are trustworthy, so all replay sizing/timeline sync starts here.
            this.ensureReplayVideoWrap();
            this.syncScrubFromVideo();
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();
            this.app.scheduleLayout();
            this.applyZoom();

            if (this.autoLoopClip1) {
                this.autoLoopClip1 = false;
                this.app.refs.clipList?.querySelector('button[data-clip-index="1"]')?.click();
            }
        });

        refs.replayVideo?.addEventListener("timeupdate", () => {
            if (this.app.state?.mode !== "replay") return;

            if (!this.isScrubbing) this.syncScrubFromVideo();
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();

            if (!this.isForwardPlaying()) return;

            // Manual loop takes precedence over element-loop playback because
            // it represents an explicit operator override.
            const segment = this.manualLoop.phase === "set" && this.manualLoopSeg ? this.manualLoopSeg : this.elementLoop;
            if (!segment || !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds)) return;

            const eps = 0.002;
            if (refs.replayVideo.currentTime >= segment.endSeconds - eps) {
                refs.replayVideo.currentTime = segment.startSeconds;
            }
        });

        refs.replayVideo?.addEventListener("seeked", () => {
            if (this.app.state?.mode !== "replay") return;
            if (this.isScrubbing) return;

            this.syncScrubFromVideo();
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();
        });

        refs.replayVideo?.addEventListener("ended", () => {
            this.setActiveSpeedIdx(null);
            this.updateReplayTimerAndSpeed();
        });

        window.addEventListener(
            "wheel",
            async (event) => {
                if (this.app.state?.mode !== "replay") return;
                if (event.ctrlKey) return;
                if (isTypingTarget(event.target)) return;

                event.preventDefault();

                this.stopReverse();
                refs.replayVideo.pause();
                this.setActiveSpeedIdx(null);
                this.clearElementLoop();

                const fps = this.app.getFps();
                const step = 1 / fps;
                const dir = event.deltaY < 0 ? +1 : -1;

                let time = Number(refs.replayVideo.currentTime || 0) + dir * step;
                const duration = this.getReplayDurSeconds();
                if (duration > 0.01) time = clamp(time, 0, duration);
                else time = Math.max(0, time);

                await this.seekTo(time);
                this.syncScrubFromVideo();
                this.app.timeline.draw();
                this.updateReplayTimerAndSpeed();
            },
            { passive: false }
        );

    }

    // Bind zoom behavior to the fixed replay video wrapper.
    ensureReplayVideoWrap() {
        const { replayVideo } = this.app.refs;
        if (!replayVideo) return null;
        if (this.replayVideoWrap) return this.replayVideoWrap;

        const isPointInsideRenderedVideo = (clientX, clientY) => {
            const videoRect = replayVideo.getBoundingClientRect();
            const rendered = this.getRenderedVideoRect();
            if (!rendered) return false;

            const left = videoRect.left + rendered.left;
            const top = videoRect.top + rendered.top;
            const right = left + rendered.width;
            const bottom = top + rendered.height;

            return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
        };

        const attachZoomHandler = (wrap) => {
            if (!wrap || wrap.dataset.zoomBound === "1") return;

            wrap.addEventListener("dblclick", (event) => {
                if (this.app.state?.mode !== "replay") return;

                if (this.zoomState.scale > 1.0001) {
                    this.resetZoom();
                    return;
                }

                if (!isPointInsideRenderedVideo(event.clientX, event.clientY)) return;

                // Zoom toward the clicked point so the operator can inspect a specific area quickly.
                const videoRect = replayVideo.getBoundingClientRect();
                const cx = event.clientX - videoRect.left;
                const cy = event.clientY - videoRect.top;

                const targetScale = 2.5;
                this.zoomState.scale = targetScale;
                this.zoomState.tx = cx - cx * targetScale;
                this.zoomState.ty = cy - cy * targetScale;
                this.applyZoom();
            });

            wrap.dataset.zoomBound = "1";
        };

        const wrap = document.getElementById("replayVideoWrap");
        if (!wrap) return null;

        this.replayVideoWrap = wrap;
        attachZoomHandler(wrap);
        this.applyZoom();
        return wrap;
    }

    getRenderedVideoRect() {
        const { replayVideo } = this.app.refs;
        if (!replayVideo) return null;

        const boxWidth = replayVideo.clientWidth || 0;
        const boxHeight = replayVideo.clientHeight || 0;
        const videoWidth = replayVideo.videoWidth || 0;
        const videoHeight = replayVideo.videoHeight || 0;
        if (boxWidth <= 0 || boxHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;

        const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
        const width = videoWidth * scale;
        const height = videoHeight * scale;

        return {
            left: 0,
            top: 0,
            width,
            height,
        };
    }

    // Keep the transformed video inside its visible container when zoomed.
    clampZoomToBounds() {
        const wrap = this.ensureReplayVideoWrap();
        const { replayVideo } = this.app.refs;
        if (!wrap || !replayVideo) return;

        const rendered = this.getRenderedVideoRect();
        const w = rendered?.width || replayVideo.clientWidth || wrap.clientWidth || 0;
        const h = rendered?.height || replayVideo.clientHeight || wrap.clientHeight || 0;
        if (w <= 0 || h <= 0) return;

        const scale = this.zoomState.scale;
        const scaledW = w * scale;
        const scaledH = h * scale;

        const minTx = w - scaledW;
        const minTy = h - scaledH;

        this.zoomState.tx = clamp(this.zoomState.tx, minTx, 0);
        this.zoomState.ty = clamp(this.zoomState.ty, minTy, 0);
    }

    updateZoomHint() {
        const hint = this.app.refs.replayZoomHint;
        if (!hint) return;

        hint.textContent = this.app.t("replayZoomHint");

        const show = this.app.state?.mode === "replay" && this.zoomState.scale > 1.0001;
        hint.classList.toggle("hidden", !show);
        hint.setAttribute("aria-hidden", show ? "false" : "true");
    }

    // Apply the current zoom transform to the replay video element.
    applyZoom() {
        const { replayVideo } = this.app.refs;
        this.ensureReplayVideoWrap();

        this.zoomState.scale = clamp(this.zoomState.scale, 1.0, 2.5);
        this.clampZoomToBounds();

        if (replayVideo) {
            replayVideo.style.transform = `matrix(${this.zoomState.scale},0,0,${this.zoomState.scale},${this.zoomState.tx},${this.zoomState.ty})`;
        }

        this.updateZoomHint();

    }

    // Return to the default full-frame replay view.
    resetZoom() {
        this.zoomState.scale = 1.0;
        this.zoomState.tx = 0.0;
        this.zoomState.ty = 0.0;
        this.applyZoom();
    }


    formatSpeedLabel(value) {
        const rounded = Math.round(value * 100) / 100;
        let text = String(rounded);
        if (text.includes(".")) text = text.replace(/\.?0+$/, "");
        return `${text}×`;
    }

    // Highlight the currently active speed button so the operator can see the
    // present playback mode at a glance.
    setActiveSpeedIdx(idxOrNull) {
        this.activeSpeedIdx = idxOrNull == null ? null : Number(idxOrNull);
        this.updateSpeedButtonVisuals();
    }

    updateSpeedButtonVisuals() {
        const { replayButtonsWrap } = this.app.refs;
        if (!replayButtonsWrap) return;

        const buttons = Array.from(replayButtonsWrap.querySelectorAll("button.speedBtn"));
        for (const button of buttons) {
            const idx = Number(button.dataset.idx);
            const isActive = this.activeSpeedIdx !== null && idx === this.activeSpeedIdx;

            button.classList.toggle("active", isActive);
            button.style.backgroundImage = "none";
            button.style.backgroundColor = isActive ? "rgba(255,255,255,0.28)" : "transparent";
        }
    }

    createSeekJumpButton(label, deltaSeconds) {
        const button = document.createElement("button");
        button.className = "seekJumpBtn";
        button.type = "button";
        button.dataset.seekSeconds = String(deltaSeconds);
        button.textContent = label;
        button.setAttribute("aria-label", label);
        button.title = label;
        return button;
    }

    // Build the replay transport row from the configured speed definitions.
    renderPlaybackButtons() {
        const { replayButtonsWrap } = this.app.refs;
        if (!replayButtonsWrap) return;

        replayButtonsWrap.innerHTML = "";

        replayButtonsWrap.appendChild(this.createSeekJumpButton("-10s", -10));
        replayButtonsWrap.appendChild(this.createSeekJumpButton("-3s", -3));

        for (let i = 0; i < SPEED_BUTTON_DEFS.length; i++) {
            const def = SPEED_BUTTON_DEFS[i];
            const speed = Number(this.playbackSpeeds[i]);

            const button = document.createElement("button");
            button.className = "speedBtn";
            button.type = "button";
            button.dataset.idx = String(i);
            button.dataset.label = def.label;
            button.dataset.play = String(speed);
            button.innerHTML = `<img src="${BTN_DIR}/${def.icon}" width="${BTN_SIZE}" height="${BTN_SIZE}" alt="" draggable="false">`;
            button.setAttribute("aria-label", `${def.display} ${this.formatSpeedLabel(speed)}`);
            button.title = `${def.display} ${this.formatSpeedLabel(speed)}`;

            replayButtonsWrap.appendChild(button);
        }

        replayButtonsWrap.appendChild(this.createSeekJumpButton("+3s", 3));
        replayButtonsWrap.appendChild(this.createSeekJumpButton("+10s", 10));

        this.updateSpeedButtonVisuals();
    }

    // Reset playback speeds to defaults and rebuild the button row.
    loadPlaybackConfig() {
        this.playbackSpeeds = SPEED_BUTTON_DEFS.map((x) => x.def);
        this.loopPlaybackSpeed = 0.5;
        this.renderPlaybackButtons();
    }

    // Keep the visible timer aligned with the replay head position.
    updateReplayTimerAndSpeed() {
        const { replayVideo } = this.app.refs;
        if (!this.app.state || this.app.state.mode !== "replay") return;

        const uiTime = this.replayUiSeconds(replayVideo.currentTime || 0);
        this.updateReplayProgramTimeIndicator(uiTime);
    }

    formatProgramPlayTime(seconds) {
        const rawSec = Number(seconds) || 0;
        const isNegative = rawSec < 0;
        const safeSec = Math.abs(rawSec);
        const totalWhole = Math.floor(safeSec);
        const minutes = Math.floor(totalWhole / 60);
        const secondsWhole = totalWhole - minutes * 60;

        let hundredths = Math.floor((safeSec - totalWhole) * 100 + 1e-6);
        if (hundredths > 99) hundredths = 99;

        const formatted = `${String(minutes).padStart(2, "0")}:${String(secondsWhole).padStart(2, "0")}:${String(hundredths).padStart(2, "0")}`;
        return isNegative ? `-${formatted}` : formatted;
    }

    updateReplayProgramTimeIndicator(uiTime = this.replayUiSeconds(this.app.refs.replayVideo?.currentTime || 0)) {
        const indicator = this.app.refs.replayProgramTimeIndicator;
        if (!indicator) return;

        const inReplay = this.app.state?.mode === "replay";
        indicator.classList.toggle("hidden", !inReplay);
        if (!inReplay) return;

        const total = this.getReplayTotalSeconds();
        const zeroOffset = this.app.isHalfwayTrackingEnabled?.()
            ? Number(this.app.programTimerStartOffsetSeconds ?? 0)
            : 0;
        const timelineZero = Number.isFinite(zeroOffset) && zeroOffset > 0 ? zeroOffset : 0;
        const elapsedFromTimelineZero = Math.max(0, Number(uiTime || 0) - timelineZero);
        indicator.textContent = this.formatProgramPlayTime(elapsedFromTimelineZero);

        const fraction = total > 0 ? clamp(Number(uiTime || 0) / total, 0, 1) : 0;
        indicator.style.left = `${fraction * 100}%`;
    }

    updateReviewTimer() {
        const { reviewTimerEl } = this.app.refs;
        if (!reviewTimerEl) return;

        if (!this.app.state || this.app.state.mode !== "replay" || this.reviewStartPerf == null) {
            reviewTimerEl.textContent = `${this.app.t("reviewLabel")}: 00:00`;
            return;
        }

        const elapsed = (performance.now() - this.reviewStartPerf) / 1000.0;
        reviewTimerEl.textContent = `${this.app.t("reviewLabel")}: ${this.app.fmtMmss(elapsed)}`;
    }

    // Playback state helpers centralize whether we are playing forward,
    // simulating reverse, or currently paused.
    isForwardPlaying() {
        const { replayVideo } = this.app.refs;
        return !replayVideo.paused && !replayVideo.ended;
    }

    isPlaying() {
        return this.reversePlaying || this.isForwardPlaying();
    }

    currentPlaySpeed() {
        const { replayVideo } = this.app.refs;
        if (this.reversePlaying) return -this.reverseSpeedAbs;
        if (this.isForwardPlaying()) return replayVideo.playbackRate;
        return 0;
    }

    stopReverse() {
        this.reversePlaying = false;

        if (this.reverseTimer) {
            clearTimeout(this.reverseTimer);
            this.reverseTimer = null;
        }

        if (this.reverseRaf) {
            cancelAnimationFrame(this.reverseRaf);
            this.reverseRaf = null;
        }
    }

    // Manual loop state is separate from element-loop playback so the operator
    // can mark a custom in/out range without changing the selected clip.
    clearElementLoop() {
        this.elementLoop = null;
        this.app.renderClipList();
    }

    resetManualLoop() {
        this.manualLoop.phase = "idle";
        this.manualLoop.startSeconds = null;
        this.manualLoopSeg = null;
        this.updateLoopButtonsUI();
    }

    setLoopButtonActive(button) {
        if (!button) return;
        button.style.backgroundImage = "none";
        button.style.backgroundColor = "transparent";
    }

    // Enable/disable loop buttons based on the current manual loop phase.
    updateLoopButtonsUI() {
        const { loopInBtn, loopOutBtn, loopClearBtn } = this.app.refs;
        const inReplay = this.app.state?.mode === "replay";
        const hasStart = this.manualLoop.phase === "armed" || this.manualLoop.phase === "set";
        const hasLoop = this.manualLoop.phase === "set";
        const hasAnything = this.manualLoop.phase !== "idle";

        if (loopInBtn) {
            loopInBtn.disabled = !inReplay;
            loopInBtn.setAttribute("aria-label", this.app.t("loopIn"));
            loopInBtn.title = this.app.t("loopIn");
            this.setLoopButtonActive(loopInBtn, hasStart);
        }

        if (loopOutBtn) {
            loopOutBtn.disabled = !inReplay || !hasStart;
            loopOutBtn.setAttribute("aria-label", this.app.t("loopOut"));
            loopOutBtn.title = this.app.t("loopOut");
            this.setLoopButtonActive(loopOutBtn, hasLoop);
        }

        if (loopClearBtn) {
            loopClearBtn.disabled = !inReplay || !hasAnything;
            loopClearBtn.setAttribute("aria-label", this.app.t("clearLoop"));
            loopClearBtn.title = this.app.t("clearLoop");
            this.setLoopButtonActive(loopClearBtn, hasAnything);
        }
    }

    // Time helpers normalize duration and scrub values so the replay UI behaves
    // consistently even while metadata is still loading.
    getReplayDurSeconds() {
        const duration = this.app.refs.replayVideo?.duration ?? this.app.state?.recordingDurationSeconds ?? 0;
        return Number.isFinite(duration) ? duration : 0;
    }

    replayUiSeconds(time) {
        const fps = this.app.getFps();
        const snap = 0.5 / fps;
        const t = Math.max(0, Number(time) || 0);
        return t < snap ? 0 : t;
    }

    getReplayTotalSeconds() {
        const duration = this.getReplayDurSeconds();
        if (!duration || duration <= 0.01) return 0.0001;
        return Math.max(0.0001, duration);
    }

    scrubMaxForVideoEnd() {
        return REPLAY_SCRUB_MAX;
    }

    syncScrubFromVideo() {
        const { replayScrub, replayVideo } = this.app.refs;
        if (!replayScrub || this.isScrubbing) return;
        if (this.app.state?.mode !== "replay") return;

        const total = this.getReplayTotalSeconds();
        if (!total || total <= 0.01) return;

        const uiTime = this.replayUiSeconds(replayVideo.currentTime || 0);
        const maxValue = this.scrubMaxForVideoEnd();
        const value = Math.round((uiTime / total) * maxValue);
        replayScrub.value = String(clamp(value, 0, this.scrubMaxForVideoEnd()));
    }

    // Promise-based seek helper so higher-level actions can await stable timing.
    seekTo(timeSeconds) {
        const { replayVideo } = this.app.refs;

        return new Promise((resolve) => {
            const target = Math.max(0, timeSeconds);

            let done = false;
            const onSeeked = () => {
                if (done) return;
                done = true;
                cleanup();
                resolve(true);
            };

            // Browsers occasionally suppress or delay "seeked" for tiny jumps;
            // resolve anyway after a short grace period so the UI cannot hang.
            const timeout = setTimeout(() => {
                if (done) return;
                done = true;
                cleanup();
                resolve(false);
            }, 250);

            function cleanup() {
                clearTimeout(timeout);
                replayVideo.removeEventListener("seeked", onSeeked);
            }

            replayVideo.addEventListener("seeked", onSeeked);
            replayVideo.currentTime = target;
        });
    }

    // Transport controls: forward uses native playback, reverse is simulated.
    startReversePlayback(speedAbs) {
        const { replayVideo } = this.app.refs;

        this.stopReverse();
        replayVideo.pause();

        this.reverseSpeedAbs = Math.max(0.01, speedAbs);
        this.reversePlaying = true;

        const startPerf = performance.now();
        const startVideo = Number(replayVideo.currentTime || 0);

        const UPDATE_HZ = 45;
        const MIN_MS = 1000 / UPDATE_HZ;
        let lastUpdate = 0;

        // HTML video has no native reverse playback here, so we simulate it by
        // repeatedly seeking backward based on elapsed time and wrapping inside
        // the active loop segment when one is set.
        const tick = (now) => {
            if (!this.reversePlaying) return;

            if (now - lastUpdate < MIN_MS) {
                this.reverseRaf = requestAnimationFrame(tick);
                return;
            }
            lastUpdate = now;

            const elapsed = (now - startPerf) / 1000.0;
            let target = startVideo - elapsed * this.reverseSpeedAbs;

            const segment = this.manualLoop.phase === "set" && this.manualLoopSeg ? this.manualLoopSeg : this.elementLoop;
            if (
                segment &&
                Number.isFinite(segment.startSeconds) &&
                Number.isFinite(segment.endSeconds) &&
                segment.endSeconds > segment.startSeconds + 0.0001
            ) {
                const { startSeconds, endSeconds } = segment;
                const length = endSeconds - startSeconds;

                if (target < startSeconds) {
                    const over = (startSeconds - target) % length;
                    target = endSeconds - over;
                    if (target >= endSeconds) target = endSeconds - 0.000001;
                } else if (target >= endSeconds) {
                    target = startSeconds + ((target - startSeconds) % length);
                }
            } else if (target < 0) {
                target = 0;
            }

            replayVideo.currentTime = target;

            if (!this.isScrubbing) this.syncScrubFromVideo();
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();

            this.reverseRaf = requestAnimationFrame(tick);
        };

        this.reverseRaf = requestAnimationFrame(tick);
    }

    playForward(speed) {
        const { replayVideo } = this.app.refs;
        this.stopReverse();
        replayVideo.playbackRate = speed;
        const playPromise = replayVideo.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => { });
        }
    }

    // Manual loop button flow: first press arms loop-in, second sets loop-out,
    // and clear resets the custom loop range.
    async handleLoopInPress() {
        const { replayVideo } = this.app.refs;
        if (!this.app.state || this.app.state.mode !== "replay") return;

        this.clearElementLoop();
        this.manualLoopSeg = null;

        let start = Number(replayVideo.currentTime || 0);
        const duration = this.getReplayDurSeconds();
        if (duration > 0.01) start = clamp(start, 0, duration);

        this.manualLoop.startSeconds = start;
        this.manualLoop.phase = "armed";
        this.updateLoopButtonsUI();

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);

        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    async handleLoopOutPress() {
        const { replayVideo } = this.app.refs;
        if (!this.app.state || this.app.state.mode !== "replay") return;
        if (this.manualLoop.phase !== "armed" && this.manualLoop.phase !== "set") return;

        const a0 = Number(this.manualLoop.startSeconds ?? 0);
        const b0 = Number(replayVideo.currentTime || 0);

        let start = Math.min(a0, b0);
        let end = Math.max(a0, b0);

        const duration = this.getReplayDurSeconds();
        if (duration > 0.01) {
            start = clamp(start, 0, duration);
            end = clamp(end, 0, duration);
        }

        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + 0.02) return;

        this.manualLoop.startSeconds = start;
        this.manualLoopSeg = { startSeconds: start, endSeconds: end };
        this.manualLoop.phase = "set";
        this.updateLoopButtonsUI();

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);

        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    async handleLoopClearPress() {
        if (!this.app.state || this.app.state.mode !== "replay") return;

        this.resetManualLoop();
        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    async handleLoopButtonPress() {
        if (!this.app.state || this.app.state.mode !== "replay") return;

        if (this.manualLoop.phase === "idle") {
            await this.handleLoopInPress();
            return;
        }

        if (this.manualLoop.phase === "armed") {
            await this.handleLoopOutPress();
            return;
        }

        await this.handleLoopClearPress();
    }

    // Selecting a clip seeks to it, makes it the active selection, and starts
    // playback using the default forward speed.
    async selectClipAndAutoPlay(idx) {
        const { replayVideo } = this.app.refs;
        if (!this.app.state || this.app.state.mode !== "replay") return;

        const clip = this.app.getClipByIndex(idx);
        if (!clip) return;

        const start = this.app.clipStart(clip);
        const end = this.app.clipEnd(clip);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

        this.stopReverse();
        replayVideo.pause();

        await this.seekTo(start);
        this.syncScrubFromVideo();

        // Keep both the clip number and the exact time segment. The exact
        // segment lets the selection survive edits even if indices move.
        this.app.setSelectedClipIdx(idx);
        this.app.selectedClipSeg = { startSeconds: start, endSeconds: end };
        this.elementLoop = { startSeconds: start, endSeconds: end };
        this.app.renderClipList();

        replayVideo.playbackRate = Number(this.playbackSpeeds[3] ?? 1);
        const playPromise = replayVideo.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => { });
        }

        this.setActiveSpeedIdx(3);
        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    scrubSeconds() {
        return this.replayUiSeconds(this.app.refs.replayVideo.currentTime || 0);
    }

    getSelectedClipForEdit() {
        if (!this.app.state || this.app.state.mode !== "replay") return null;
        if (this.app.selectedClipIdx == null) return null;
        return this.app.getClipByIndex(this.app.selectedClipIdx);
    }

    // Clip edit actions call the backend, then refresh state and repair the
    // current replay selection/loop where needed.
    async doDeleteSelectedClip() {
        const { replayVideo } = this.app.refs;
        if (!this.app.editModeEnabled) return;

        const clip = this.getSelectedClipForEdit();
        if (!clip) return;

        const ok = await this.app.showConfirm({
            text: this.app.t("confirmDeleteClipText"),
            yesText: this.app.t("confirmDeleteClipYes"),
            cancelText: this.app.t("confirmCancel"),
        });
        if (!ok) return;

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);
        this.clearElementLoop();
        this.resetManualLoop();

        await apiPost("/api/replay/delete", { index: this.app.selectedClipIdx });

        this.app.setSelectedClipIdx(null);
        await this.app.pollStatus();

        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    async doSplitSelectedClip() {
        const { replayVideo } = this.app.refs;
        if (!this.app.editModeEnabled) return;

        const clip = this.getSelectedClipForEdit();
        if (!clip) return;

        const start = this.app.clipStart(clip);
        const end = this.app.clipEnd(clip);
        const time = this.scrubSeconds();

        if (!(time > start && time < end)) {
            alert(this.app.t("splitAlertCannotSplit"));
            return;
        }

        const ok = await this.app.showConfirm({
            text: this.app.t("confirmSplitClipText"),
            yesText: this.app.t("confirmSplitClipYes"),
            cancelText: this.app.t("confirmCancel"),
        });
        if (!ok) return;

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);
        this.clearElementLoop();
        this.resetManualLoop();

        const wantedSegment = { startSeconds: start, endSeconds: time };

        await apiPost("/api/replay/split", {
            index: this.app.selectedClipIdx,
            splitSeconds: time,
        });

        this.app.selectedClipSeg = wantedSegment;
        await this.app.pollStatus();
        this.app.syncSelectedClipToState();

        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    async doTrimIn() {
        if (!this.app.editModeEnabled) return;

        const clip = this.getSelectedClipForEdit();
        if (!clip) return;

        const start = this.app.clipStart(clip);
        const end = this.app.clipEnd(clip);
        const time = this.scrubSeconds();

        if (!(time < end)) return;
        if (time >= end - 0.03) return;

        const newStart = time;
        if (Math.abs(newStart - start) < 1e-6) return;

        // Preserve the old segment so selection can be reattached after backend edits.
        const oldSegment = { startSeconds: start, endSeconds: end };
        const newSegment = { startSeconds: newStart, endSeconds: end };
        const hadLoop = !!(this.elementLoop && this.app.segEquals(this.elementLoop, start, end, 0.03));

        this.app.selectedClipSeg = newSegment;
        await apiPost("/api/replay/trimIn", {
            clipIndex: this.app.selectedClipIdx,
            atSeconds: newStart,
        });

        await this.app.pollStatus();

        if (this.app.selectedClipIdx == null && this.app.selectedClipSeg == null) {
            this.app.selectedClipSeg = oldSegment;
            this.app.restoreSelectionFromSeg(oldSegment);
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();
        }

        if (hadLoop && this.app.selectedClipSeg) {
            this.elementLoop = {
                startSeconds: this.app.selectedClipSeg.startSeconds,
                endSeconds: this.app.selectedClipSeg.endSeconds,
            };
        }
    }

    async doTrimOut() {
        if (!this.app.editModeEnabled) return;

        const clip = this.getSelectedClipForEdit();
        if (!clip) return;

        const start = this.app.clipStart(clip);
        const end = this.app.clipEnd(clip);
        const time = this.scrubSeconds();

        if (!(time > start)) return;
        if (time <= start + 0.03) return;

        const newEnd = time;
        if (Math.abs(newEnd - end) < 1e-6) return;

        // Preserve the old segment so selection can be reattached after backend edits.
        const oldSegment = { startSeconds: start, endSeconds: end };
        const newSegment = { startSeconds: start, endSeconds: newEnd };
        const hadLoop = !!(this.elementLoop && this.app.segEquals(this.elementLoop, start, end, 0.03));

        this.app.selectedClipSeg = newSegment;
        await apiPost("/api/replay/trimOut", {
            clipIndex: this.app.selectedClipIdx,
            atSeconds: newEnd,
        });

        await this.app.pollStatus();

        if (this.app.selectedClipIdx == null && this.app.selectedClipSeg == null) {
            this.app.selectedClipSeg = oldSegment;
            this.app.restoreSelectionFromSeg(oldSegment);
            this.app.timeline.draw();
            this.updateReplayTimerAndSpeed();
        }

        if (hadLoop && this.app.selectedClipSeg) {
            this.elementLoop = {
                startSeconds: this.app.selectedClipSeg.startSeconds,
                endSeconds: this.app.selectedClipSeg.endSeconds,
            };
        }
    }

    async doInsertClip() {
        const { replayVideo } = this.app.refs;
        if (!this.app.editModeEnabled) return;
        if (!this.app.state || this.app.state.mode !== "replay") return;

        const time = this.scrubSeconds();
        const duration = this.getReplayDurSeconds();
        if (!Number.isFinite(duration) || duration <= 0.01) return;

        // Insert starts as a one-second placeholder clip so the operator can trim it afterward.
        const start = time;
        const end = time + 1.0;

        if (end > duration + 1e-6) return;
        if (!this.app.canInsertSegment(start, end)) return;

        const ok = await this.app.showConfirm({
            text: this.app.t("confirmInsertClipText"),
            yesText: this.app.t("confirmInsertClipYes"),
            cancelText: this.app.t("confirmCancel"),
        });
        if (!ok) return;

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);
        this.clearElementLoop();
        this.resetManualLoop();

        this.app.selectedClipSeg = { startSeconds: start, endSeconds: end };

        await apiPost("/api/replay/insert", {
            startSeconds: start,
            endSeconds: end,
        });

        await this.app.pollStatus();
        this.app.syncSelectedClipToState();

        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    // Keyboard-assisted navigation supports quick jumps, frame stepping, and
    // held-arrow slow playback without changing the core transport model.
    clearArrowHoldTimer() {
        if (this.arrowHoldTimer) {
            clearTimeout(this.arrowHoldTimer);
            this.arrowHoldTimer = null;
        }
    }

    stopArrowHoldPlayback() {
        const { replayVideo } = this.app.refs;

        this.clearArrowHoldTimer();
        this.arrowHoldPlaying = false;
        this.arrowHoldKey = null;

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);
        this.updateReplayTimerAndSpeed();
    }

    async jumpBySeconds(deltaSeconds) {
        const { replayVideo } = this.app.refs;
        if (this.app.state?.mode !== "replay") return;

        // Jump commands preserve the previous play state so a quick skip feels
        // like transport control rather than a stop/restart.
        const wasReversePlaying = this.reversePlaying;
        const reverseSpeedAbs = this.reverseSpeedAbs;
        const wasForwardPlaying = this.isForwardPlaying();
        const forwardSpeed = Number(replayVideo.playbackRate || 1);
        const activeSpeedIdx = this.activeSpeedIdx;

        if (wasReversePlaying) {
            this.stopReverse();
        }

        this.clearElementLoop();

        let time = Number(replayVideo.currentTime || 0) + deltaSeconds;
        const duration = this.getReplayDurSeconds();
        if (duration > 0.01) time = clamp(time, 0, duration);
        else time = Math.max(0, time);

        await this.seekTo(time);
        this.syncScrubFromVideo();
        this.app.timeline.draw();

        if (wasReversePlaying) {
            this.startReversePlayback(reverseSpeedAbs);
            this.setActiveSpeedIdx(activeSpeedIdx);
        } else if (wasForwardPlaying) {
            this.playForward(forwardSpeed);
            this.setActiveSpeedIdx(activeSpeedIdx);
        }

        this.updateReplayTimerAndSpeed();
    }

    async stepFrame(dir) {
        const { replayVideo } = this.app.refs;
        if (this.app.state?.mode !== "replay") return;

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);
        this.clearElementLoop();

        const fps = this.app.getFps();
        const step = 1 / fps;

        let time = Number(replayVideo.currentTime || 0) + dir * step;
        const duration = this.getReplayDurSeconds();
        if (duration > 0.01) time = clamp(time, 0, duration);
        else time = Math.max(0, time);

        await this.seekTo(time);
        this.syncScrubFromVideo();
        this.app.timeline.draw();
        this.updateReplayTimerAndSpeed();
    }

    startArrowHoldPlayback(key) {
        const { replayVideo } = this.app.refs;
        if (this.app.state?.mode !== "replay") return;

        this.clearArrowHoldTimer();
        this.arrowHoldKey = key;
        this.arrowHoldPlaying = true;

        this.stopReverse();
        replayVideo.pause();
        this.setActiveSpeedIdx(null);
        this.clearElementLoop();

        // Held arrows act like a temporary shuttle mode at 0.5x in either
        // direction, separate from the normal speed-button transport.
        if (key === "ArrowLeft") {
            this.startReversePlayback(0.5);
        } else if (key === "ArrowRight") {
            this.playForward(0.5);
        }
    }

    selectNextPrevElement(dir) {
        if (this.app.state?.mode !== "replay") return;

        const indices = this.app.getValidClipIndices();
        if (!indices.length) return;

        const current = Number(this.app.selectedClipIdx);
        const currentPos = Number.isFinite(current) ? indices.indexOf(current) : -1;

        let nextIdx;
        if (currentPos === -1) {
            nextIdx = indices[0];
        } else {
            const count = indices.length;
            const nextPos = (currentPos + dir + count) % count;
            nextIdx = indices[nextPos];
        }

        this.app.refs.clipList?.querySelector(`button[data-clip-index="${nextIdx}"]`)?.click();
    }

    // Lightweight RAF loop keeps time displays fresh while replay mode is open.
    startRafLoop() {
        const tick = () => {
            if (this.app.state?.mode === "replay") {
                if (!this.isScrubbing) this.syncScrubFromVideo();
                this.updateReplayTimerAndSpeed();
                this.updateReviewTimer();
            }
            this.rafId = requestAnimationFrame(tick);
        };

        this.rafId = requestAnimationFrame(tick);
    }
}
