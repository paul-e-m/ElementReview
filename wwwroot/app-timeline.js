// TimelineRenderer draws the single shared timeline canvas used in both
// recording and replay modes. The main app owns the authoritative clip/state
// data; this class focuses only on turning that state into pixels.
export class TimelineRenderer {
    constructor(app) {
        // Keep a reference to the main application object so the timeline
        // can read state, clips, FPS formatting helpers, and replay info.
        this.app = app;
    }

    prepareCanvas(canvas, ctx) {
        // Match the canvas backing resolution to the element's displayed size.
        // This keeps the timeline sharp on both normal and high-DPI displays.
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        const cssW = Math.max(1, Math.round(rect.width));
        const cssH = Math.max(1, Math.round(rect.height));

        const pxW = Math.max(1, Math.round(cssW * dpr));
        const pxH = Math.max(1, Math.round(cssH * dpr));

        // Only resize the canvas when needed, since changing width/height
        // resets the drawing state.
        if (canvas.width !== pxW || canvas.height !== pxH) {
            canvas.width = pxW;
            canvas.height = pxH;
        }

        // Draw using CSS pixel coordinates even though the backing canvas
        // is scaled up for high-DPI rendering.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w: cssW, h: cssH };
    }

    drawTimelineTicksAndLabels(ctx, w, h, totalSec, xFor, barTop, barH, displayOriginSec = 0, useShiftedTimeline = false) {
        // Bottom strip of the timeline reserved for tick marks and labels.
        const tickArea = 9;
        const barBottom = barTop + barH;

        const yLine = Math.round(barBottom - tickArea) + 0.5;
        const minorLen = Math.max(1, Math.round(tickArea / 2));

        // Draw the main yellow baseline for the tick area.
        ctx.strokeStyle = "rgba(255,214,64,0.98)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, yLine);
        ctx.lineTo(w, yLine);
        ctx.stroke();

        // Draw tick marks every 5 seconds, with a longer mark every 15 seconds.
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1;

        const minDisplaySec = -displayOriginSec;
        const maxDisplaySec = totalSec - displayOriginSec;
        const firstTickDisplaySec = useShiftedTimeline ? Math.ceil(minDisplaySec / 5) * 5 : 0;

        for (let displaySec = firstTickDisplaySec; displaySec <= maxDisplaySec + 0.001; displaySec += 5) {
            const timelineSec = useShiftedTimeline ? displaySec + displayOriginSec : displaySec;
            const x = Math.round(xFor(timelineSec)) + 0.5;
            const isMajor = Math.abs(displaySec / 15 - Math.round(displaySec / 15)) < 1e-9;

            ctx.beginPath();
            ctx.moveTo(x, yLine);
            ctx.lineTo(x, isMajor ? barBottom : Math.min(barBottom, yLine + minorLen));
            ctx.stroke();
        }

        // Use the remaining band underneath for time labels.
        const labelBandTop = barBottom;
        const labelBandH = Math.max(0, h - labelBandTop);
        if (labelBandH < 8) return;

        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "600 9px system-ui, Segoe UI, Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const labelY = labelBandTop + labelBandH / 2;

        // Label every 15 seconds. Before the program timer starts, keep the
        // original recording-based labels. Once it starts, rebase labels so
        // 0:00 sits exactly at the timer start point.
        const firstLabelDisplaySec = useShiftedTimeline ? Math.ceil(minDisplaySec / 15) * 15 : 15;

        if (useShiftedTimeline && minDisplaySec < -0.001 && firstLabelDisplaySec > minDisplaySec + 0.001) {
            ctx.textAlign = "left";
            ctx.fillText(this.app.fmtSignedMss(minDisplaySec), 2, labelY);
            ctx.textAlign = "center";
        }

        for (let displaySec = firstLabelDisplaySec; displaySec <= maxDisplaySec + 0.001; displaySec += 15) {
            const timelineSec = useShiftedTimeline ? displaySec + displayOriginSec : displaySec;
            const label = useShiftedTimeline
                ? this.app.fmtSignedMss(displaySec)
                : this.app.fmtMss(displaySec);
            ctx.fillText(label, Math.round(xFor(timelineSec)), labelY);
        }
    }

    getHalfwayTimelineSeconds() {
        if (!this.app.hasProgramTimerStarted?.()) return null;

        const halfwaySeconds = Number(this.app.getHalfwaySeconds?.() ?? null);
        const programStart = Number(this.app.programTimerStartOffsetSeconds ?? null);

        if (!Number.isFinite(halfwaySeconds) || halfwaySeconds <= 0) return null;
        if (!Number.isFinite(programStart) || programStart < 0) return null;

        return programStart + halfwaySeconds;
    }

    drawHalfwayMarker(ctx, x, barTop, barH, h, yOffset = 0) {
        const xLine = Math.round(x) + 0.5;
        const rectY = barTop + 2;
        const rectH = Math.max(1, barH - 2 - 9);
        const yTop = rectY;
        const yBottom = rectY + rectH;

        // Dark outline first so the yellow marker stays visible over both the
        // white elapsed area and darker clip blocks.
        ctx.strokeStyle = "rgba(0, 0, 80, 0.95)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(xLine, yTop);
        ctx.lineTo(xLine, yBottom);
        ctx.stroke();

        ctx.strokeStyle = "rgba(255,214,64,0.98)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(xLine, yTop);
        ctx.lineTo(xLine, yBottom);
        ctx.stroke();
    }

    drawProgramTimerStartMarker(ctx, x, rectY, rectH) {
        const xLine = Math.round(x) + 0.5;
        const yTop = rectY;
        const yBottom = rectY + rectH;

        ctx.strokeStyle = "rgba(57,255,20,0.98)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(xLine, yTop);
        ctx.lineTo(xLine, yBottom);
        ctx.stroke();
    }

    draw() {
        const { recordCanvas, recordCtx } = this.app.refs;
        const state = this.app.state;
        if (!recordCanvas || !recordCtx || !state) return;

        const { w, h } = this.prepareCanvas(recordCanvas, recordCtx);
        const ctx = recordCtx;

        // Clear and repaint the full timeline background.
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#142B35";
        ctx.fillRect(0, 0, w, h);

        // Shared geometry for the main timeline bar.
        const barTop = 3;
        const barH = 36;
        const tickArea = 9;
        const rectY = barTop + 2;
        const rectH = Math.max(1, barH - 2 - tickArea);

        let total = 0.0001;
        let recNow = 0;
        const clips = this.app.getClips();
        const halfwayTimelineSeconds = this.getHalfwayTimelineSeconds();
        const displayOriginSec = this.app.hasProgramTimerStarted?.()
            ? Math.max(0, Number(this.app.programTimerStartOffsetSeconds) || 0)
            : 0;
        const useShiftedTimeline = displayOriginSec > 0.001;

        if (state.mode === "record") {
            // In record mode, the timeline expands as recording continues.
            recNow = this.app.currentRecordSeconds();
            const openStart = state?.openClipStartSeconds ?? null;

            const maxClipEnd = Math.max(0, ...clips.map((clip) => this.app.clipEnd(clip)));

            // Start with a base window and grow in 60-second chunks as needed.
            // That keeps the clip labels readable instead of constantly
            // rescaling while a live recording is in progress.
            const BASE = 175;
            const need = Math.max(recNow, maxClipEnd, openStart ?? 0, halfwayTimelineSeconds ?? 0, 0);

            total = BASE;
            while (need > total + 1e-6) total += 60;
            total = Math.max(total, 0.0001);
        } else {
            // In replay mode, use the full recording length.
            total = this.app.replay.getReplayTotalSeconds();
        }

        // Convert a time in seconds to an x-coordinate on the timeline.
        const xFor = (seconds) => Math.max(0, Math.min(w, (seconds / total) * w));

        this.drawTimelineTicksAndLabels(ctx, w, h, total, xFor, barTop, barH, displayOriginSec, useShiftedTimeline);

        // Default font for element numbers drawn inside timeline clips.
        ctx.font = "600 16px system-ui, Segoe UI, Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        if (state.mode === "record") {
            const openStart = state?.openClipStartSeconds ?? null;

            // Nothing more to draw in record mode until the recording has started.
            if (!state?.isRecording) return;

            // Fill completed elapsed recording time in white.
            const xNow = xFor(recNow);
            ctx.fillStyle = "rgba(255,255,255,0.95)";
            ctx.fillRect(0, rectY, xNow, rectH);

            // Draw each completed element clip.
            for (const clip of clips) {
                const start = this.app.clipStart(clip);
                const end = this.app.clipEnd(clip);
                const idx = this.app.clipIdx(clip);
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

                const x1 = xFor(start);
                const x2 = xFor(end);
                const width = Math.max(1, x2 - x1);

                // Element clip block.
                ctx.fillStyle = "#314784";
                ctx.fillRect(x1, rectY, width, rectH);

                // Draw the element number centered in the clip.
                // If the element is flagged for review, use yellow instead of white.
                if (Number.isFinite(idx)) {
                    const isReview = !!this.app.elementMeta?.[idx]?.review;
                    ctx.fillStyle = isReview ? "#ffd640" : "rgba(255,255,255,0.98)";
                    ctx.font = isReview
                        ? "700 16px system-ui, Segoe UI, Arial"
                        : "600 16px system-ui, Segoe UI, Arial";
                    ctx.fillText(String(idx), x1 + width / 2, rectY + rectH / 2);
                }
            }

            // If a clip has been started but not yet stopped, show the open portion in red.
            if (openStart != null && Number.isFinite(openStart) && recNow > openStart + 0.001) {
                const x1 = xFor(openStart);
                const x2 = xFor(recNow);
                ctx.fillStyle = "rgba(255, 55, 75, 0.95)";
                ctx.fillRect(x1, rectY, Math.max(1, x2 - x1), rectH);
            }

            if (Number.isFinite(halfwayTimelineSeconds) && halfwayTimelineSeconds >= 0) {
                this.drawHalfwayMarker(ctx, xFor(halfwayTimelineSeconds), barTop, barH, h);
            }

            if (useShiftedTimeline) {
                this.drawProgramTimerStartMarker(ctx, xFor(displayOriginSec), rectY, rectH);
            }

            return;
        }

        // Replay mode uses a fixed time range based on the loaded recording,
        // so clip geometry stays stable while the operator scrubs around.
        // Replay mode: draw all clips across the full recording duration.
        for (const clip of clips) {
            const start = this.app.clipStart(clip);
            const end = this.app.clipEnd(clip);
            const idx = this.app.clipIdx(clip);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

            const x1 = xFor(start);
            const x2 = xFor(end);
            const width = Math.max(1, x2 - x1);
            const isSelected = this.app.isSelectedClip(idx, start, end);

            // Selected clip is inverted to white so it stands out.
            ctx.fillStyle = isSelected ? "rgba(255,255,255,0.98)" : "#314784";
            ctx.fillRect(x1, rectY, width, rectH);

            // Clip number:
            // - selected clip = dark blue text on white
            // - review clip = yellow text
            // - normal clip = white text
            if (Number.isFinite(idx)) {
                const isReview = !!this.app.elementMeta?.[idx]?.review;
                ctx.fillStyle = isSelected
                    ? "#314784"
                    : (isReview ? "#ffd640" : "rgba(255,255,255,0.98)");
                ctx.font = isReview
                    ? "700 16px system-ui, Segoe UI, Arial"
                    : "600 16px system-ui, Segoe UI, Arial";
                ctx.fillText(String(idx), x1 + width / 2, rectY + rectH / 2);
            }
        }

        if (Number.isFinite(halfwayTimelineSeconds) && halfwayTimelineSeconds >= 0) {
            this.drawHalfwayMarker(ctx, xFor(halfwayTimelineSeconds), barTop, barH, h);
        }

        if (useShiftedTimeline) {
            this.drawProgramTimerStartMarker(ctx, xFor(displayOriginSec), rectY, rectH);
        }

        // Manual loop markers are replay-only.
        const manualLoop = this.app.replay.manualLoop;
        const manualLoopSeg = this.app.replay.manualLoopSeg;
        const segment =
            manualLoop.phase === "set" && manualLoopSeg
                ? manualLoopSeg
                : manualLoop.phase === "armed"
                    ? { startSeconds: manualLoop.startSeconds ?? 0 }
                    : null;

        if (!segment || !Number.isFinite(segment.startSeconds)) return;

        const xStart = xFor(segment.startSeconds);
        const midY = rectY + rectH / 2;
        const y1 = rectY;
        const y2 = rectY + rectH;

        // Loop markers/lines are always yellow.
        ctx.strokeStyle = "rgba(255,214,64,0.98)";
        ctx.lineWidth = 3;
        ctx.lineCap = "butt";

        // Only loop-in has been set so far: draw a single vertical marker.
        if (manualLoop.phase === "armed") {
            ctx.beginPath();
            ctx.moveTo(xStart, y1);
            ctx.lineTo(xStart, y2);
            ctx.stroke();
            return;
        }

        // Full loop range has been set: draw start marker, end marker, and joining line.
        if (
            manualLoop.phase === "set" &&
            Number.isFinite(segment.endSeconds) &&
            segment.endSeconds > segment.startSeconds + 0.0001
        ) {
            const xEnd = xFor(segment.endSeconds);

            ctx.beginPath();
            ctx.moveTo(xStart, midY);
            ctx.lineTo(xEnd, midY);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(xStart, y1);
            ctx.lineTo(xStart, y2);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(xEnd, y1);
            ctx.lineTo(xEnd, y2);
            ctx.stroke();
        }
    }
}
