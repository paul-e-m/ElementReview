import { el, clamp, isTypingTarget } from "./app-utils.js";

// ShortcutKeysController owns only keyboard orchestration:
// - global key listeners
// - mode-aware shortcut routing
// - the hold-Tab shortcut overlay
//
// It intentionally delegates the real work back to ElementReviewApp and
// ReplayController so transport/edit behavior remains implemented where it
// already lives.
export class ShortcutKeysController {
    constructor(app) {
        this.app = app;
        this.replay = app.replay;
        this.overlayVisible = false;

        this.refs = {
            shortcutOverlay: el("shortcutOverlay"),
            shortcutTitle: el("shortcutTitle"),
            shortcutModeLabel: el("shortcutModeLabel"),
            shortcutList: el("shortcutList"),
        };
    }

    bindEvents() {
        document.addEventListener("keydown", (event) => this.handleCaptureKeyDown(event), true);
        document.addEventListener("keyup", (event) => this.handleCaptureKeyUp(event), true);

        window.addEventListener("keydown", (event) => this.handleWindowKeyDown(event));
        window.addEventListener("keyup", (event) => this.handleWindowKeyUp(event));

        window.addEventListener("blur", () => this.hideShortcutOverlay());
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) this.hideShortcutOverlay();
        });
    }

    handleCaptureKeyDown(event) {
        if (event.key === "Enter" && this.isConfirmOpen()) {
            event.preventDefault();
            event.stopPropagation();
            this.app.hideConfirm(true);
            return;
        }

        if (event.key === "Tab") {
            event.preventDefault();
            if (!event.repeat) this.showShortcutOverlay();
        }
    }

    handleCaptureKeyUp(event) {
        if (event.key !== "Tab") return;
        event.preventDefault();
        this.hideShortcutOverlay();
    }

    handleWindowKeyDown(event) {
        const refs = this.app.refs;

        // Let normal text inputs behave normally, but keep the replay scrubber
        // eligible for transport shortcuts.
        if (isTypingTarget(event.target)) {
            const tag = (event.target?.tagName || "").toLowerCase();
            const type = (event.target?.type || "").toLowerCase();
            if (!(tag === "input" && type === "range")) return;
        }

        if (this.app.state?.mode === "replay") {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();

                if (this.replay.arrowHoldKey && this.replay.arrowHoldKey !== event.key) {
                    this.replay.stopArrowHoldPlayback();
                }

                if (this.replay.arrowHoldKey === event.key && (this.replay.arrowHoldTimer || this.replay.arrowHoldPlaying)) {
                    if (event.repeat && !this.replay.arrowHoldPlaying) {
                        this.replay.startArrowHoldPlayback(event.key);
                    }
                    return;
                }

                this.replay.arrowHoldKey = event.key;

                if (!event.repeat) {
                    const dir = event.key === "ArrowRight" ? +1 : -1;
                    this.replay.stepFrame(dir).catch(console.error);

                    this.replay.clearArrowHoldTimer();
                    this.replay.arrowHoldTimer = setTimeout(() => {
                        if (this.replay.arrowHoldKey === event.key && !this.replay.arrowHoldPlaying) {
                            this.replay.startArrowHoldPlayback(event.key);
                        }
                    }, 220);
                    return;
                }

                if (!this.replay.arrowHoldPlaying) {
                    this.replay.startArrowHoldPlayback(event.key);
                }
                return;
            }

            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                if (event.repeat) return;
                this.replay.selectNextPrevElement(event.key === "ArrowUp" ? +1 : -1);
                return;
            }
        }

        if (this.isSpaceShortcut(event)) {
            event.preventDefault();

            if (this.app.state?.mode === "record") {
                this.app.handleRecordSpaceShortcut();
                return;
            }

            if (this.app.state?.mode === "replay") {
                refs.replayButtonsWrap?.querySelector('button.speedBtn[data-idx="3"]')?.click();
            }
            return;
        }

        if (event.code === "Backspace" || event.key === "Backspace") {
            if (this.app.state?.mode === "record" && this.app.state?.isRecording) {
                event.preventDefault();
                this.app.undoClipAction().catch(console.error);
            }
            return;
        }

        if (event.key === "s" || event.key === "S") {
            if (this.app.state?.mode === "record") {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (event.repeat) return;
                refs.mainBtn?.click();
            }
            return;
        }

        if (event.key === "t" || event.key === "T") {
            if (this.app.state?.mode === "record") {
                event.preventDefault();
                if (event.repeat) return;
                this.app.handleProgramTimerShortcut();
            }
            return;
        }

        if (event.key === "n" || event.key === "N") {
            if (this.app.state?.mode === "replay") {
                event.preventDefault();
                if (event.repeat) return;
                refs.mainBtn?.click();
            }
            return;
        }

        if (event.key === "l" || event.key === "L") {
            if (this.app.state?.mode === "replay") {
                event.preventDefault();
                this.replay.handleLoopButtonPress().catch(console.error);
            }
            return;
        }

        if (event.key === "h" || event.key === "H") {
            if (this.app.state?.mode === "replay") {
                event.preventDefault();
                if (event.repeat) return;
                this.jumpToHalfway();
            }
            return;
        }

        if (event.key === "Escape") {
            if (this.app.refs.confirmModal && !this.app.refs.confirmModal.classList.contains("hidden")) {
                this.app.hideConfirm();
            }

            if (this.app.state?.mode === "replay") {
                this.replay.resetManualLoop();
                this.replay.resetZoom();
                this.app.timeline.draw();
                this.replay.updateReplayTimerAndSpeed();
            }
        }
    }

    handleWindowKeyUp(event) {
        if (this.app.state?.mode !== "replay") return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

        event.preventDefault();

        if (this.replay.arrowHoldKey === event.key || this.replay.arrowHoldTimer || this.replay.arrowHoldPlaying) {
            this.replay.stopArrowHoldPlayback();
        } else {
            this.replay.clearArrowHoldTimer();
        }
    }

    isSpaceShortcut(event) {
        return event.code === "Space" || event.key === " " || event.key === "Spacebar";
    }

    jumpToHalfway() {
        const halfwaySeconds = Number(this.app.getHalfwaySeconds?.() ?? null);
        const programStart = Number(this.app.programTimerStartOffsetSeconds ?? null);
        const duration = this.replay.getReplayDurSeconds();

        if (
            !this.app.hasProgramTimerStarted?.() ||
            !Number.isFinite(halfwaySeconds) ||
            halfwaySeconds <= 0 ||
            !Number.isFinite(programStart) ||
            !Number.isFinite(duration) ||
            duration <= 0
        ) {
            return;
        }

        const target = clamp(programStart + halfwaySeconds, 0, duration);
        this.replay.stopReverse();
        this.app.refs.replayVideo?.pause();
        this.replay.setActiveSpeedIdx(null);
        this.replay.clearElementLoop();
        this.replay.resetManualLoop();
        this.replay.seekTo(target)
            .then(() => {
                this.replay.syncScrubFromVideo();
                this.app.timeline.draw();
                this.replay.updateReplayTimerAndSpeed();
            })
            .catch(console.error);
    }

    isConfirmOpen() {
        return !!this.app.refs.confirmModal && !this.app.refs.confirmModal.classList.contains("hidden");
    }

    getShortcutItemsForMode(mode) {
        const shared = [
            { key: this.app.t("shortcutKeyTab"), action: this.app.t("shortcutActionTab") },
            { key: this.app.t("shortcutKeyCtrlPlus"), action: this.app.t("shortcutActionCtrlPlus") },
            { key: this.app.t("shortcutKeyCtrlMinus"), action: this.app.t("shortcutActionCtrlMinus") },
        ];

        if (mode === "replay") {
            return [
                { key: this.app.t("shortcutKeyReplaySpace"), action: this.app.t("shortcutActionReplaySpace") },
                { key: this.app.t("shortcutKeyArrowLeft"), action: this.app.t("shortcutActionArrowLeft") },
                { key: this.app.t("shortcutKeyArrowRight"), action: this.app.t("shortcutActionArrowRight") },
                { key: this.app.t("shortcutKeyArrowUp"), action: this.app.t("shortcutActionArrowUp") },
                { key: this.app.t("shortcutKeyArrowDown"), action: this.app.t("shortcutActionArrowDown") },
                { key: this.app.t("shortcutKeyH"), action: this.app.t("shortcutActionH") },
                { key: this.app.t("shortcutKeyL"), action: this.app.t("shortcutActionL") },
                { key: this.app.t("shortcutKeyN"), action: this.app.t("shortcutActionN") },
                { key: this.app.t("shortcutKeyEscape"), action: this.app.t("shortcutActionEscape") },
                ...shared,
            ];
        }

        return [
            { key: this.app.t("shortcutKeyS"), action: this.app.t("shortcutActionS") },
            { key: this.app.t("shortcutKeyT"), action: this.app.t("shortcutActionT") },
            { key: this.app.t("shortcutKeySpace"), action: this.app.t("shortcutActionRecordSpace") },
            { key: this.app.t("shortcutKeyBackspace"), action: this.app.t("shortcutActionBackspace") },
            ...shared,
        ];
    }

    renderShortcutOverlay() {
        const mode = this.app.state?.mode === "replay" ? "replay" : "record";
        const items = this.getShortcutItemsForMode(mode);

        if (this.refs.shortcutTitle) {
            this.refs.shortcutTitle.textContent = this.app.t("shortcutTitle");
        }

        if (this.refs.shortcutModeLabel) {
            this.refs.shortcutModeLabel.textContent =
                mode === "replay" ? this.app.t("shortcutModeReplay") : this.app.t("shortcutModeRecord");
        }

        if (this.refs.shortcutList) {
            this.refs.shortcutList.innerHTML = items.map(({ key, action }) => `
                <div class="shortcutRow">
                    <div class="shortcutKey">${key}</div>
                    <div class="shortcutAction">${action}</div>
                </div>
            `).join("");
        }
    }

    refreshOverlay() {
        if (this.overlayVisible) this.renderShortcutOverlay();
    }

    showShortcutOverlay() {
        this.renderShortcutOverlay();
        if (this.refs.shortcutOverlay) {
            this.refs.shortcutOverlay.classList.remove("hidden");
            this.refs.shortcutOverlay.setAttribute("aria-hidden", "false");
        }
        this.overlayVisible = true;
    }

    hideShortcutOverlay() {
        if (!this.overlayVisible) return;
        if (this.refs.shortcutOverlay) {
            this.refs.shortcutOverlay.classList.add("hidden");
            this.refs.shortcutOverlay.setAttribute("aria-hidden", "true");
        }
        this.overlayVisible = false;
    }
}
