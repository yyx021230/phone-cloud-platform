package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const frameHeaderSize = 13

const (
	frameKindConfiguration    byte = 0
	frameKindData             byte = 1
	frameKindKeyframe         byte = 2
	frameKindPlaybackFeedback byte = 3
)

type frame struct {
	kind byte
	pts  int64
	data []byte
}

// eventLogLimiter keeps high-frequency transport diagnostics observable
// without turning congestion into a stderr/logging workload.
type eventLogLimiter struct {
	lastSignature string
	lastLoggedAt  time.Time
	suppressed    int
}

// allow returns whether this NACK should be logged and how many equivalent
// reports were suppressed since the previous log. A different loss shape is
// useful diagnostic information and is emitted immediately.
func (l *eventLogLimiter) allow(now time.Time, signature string) (bool, int) {
	const repeatInterval = 2 * time.Second
	if signature == l.lastSignature && now.Sub(l.lastLoggedAt) < repeatInterval {
		l.suppressed++
		return false, 0
	}
	suppressed := l.suppressed
	l.lastSignature = signature
	l.lastLoggedAt = now
	l.suppressed = 0
	return true, suppressed
}

// queuedFrame is an independently decodable unit from the scrcpy reader. The
// publisher may discard stale delta frames under transport pressure, but it
// always resumes from a *new source* IDR frame with SPS/PPS attached.
type queuedFrame struct {
	data          []byte
	keyframe      bool
	discontinuity bool
	pts           int64
	enqueuedAt    time.Time
}

type queuePushResult struct {
	dropped        int
	discontinuity  bool
	resyncRequired bool
	reason         string
	waitingForIDR  bool
	queuedFrames   int
	queuedBytes    int
	inFlightBytes  int
	queuedAge      time.Duration
	maxQueuedBytes int
	maxQueuedAge   time.Duration
}

// realtimeFrameQueue deliberately keeps only a tiny amount of source video.
// Screen control is real-time: when the sender falls behind, showing an old
// frame is worse than waiting for the next independently decodable keyframe.
type realtimeFrameQueue struct {
	mu                 sync.Mutex
	cond               *sync.Cond
	frames             []queuedFrame
	closed             bool
	waitingForKeyframe bool
	queuedBytes        int
	inFlightBytes      int
	inFlightStartedAt  time.Time
	maxDuration        time.Duration
	maxBytes           int
	adaptive           *adaptivePacingController
	now                func() time.Time
}

func newRealtimeFrameQueue(maxDuration time.Duration, maxBytes int, adaptive ...*adaptivePacingController) *realtimeFrameQueue {
	if maxDuration < 100*time.Millisecond {
		maxDuration = 100 * time.Millisecond
	}
	if maxBytes < 32<<10 {
		maxBytes = 32 << 10
	}
	queue := &realtimeFrameQueue{
		waitingForKeyframe: true,
		maxDuration:        maxDuration,
		maxBytes:           maxBytes,
		now:                time.Now,
	}
	if len(adaptive) > 0 {
		queue.adaptive = adaptive[0]
	}
	queue.cond = sync.NewCond(&queue.mu)
	return queue
}

// push preserves the source GOP in order while the queue remains inside its
// real-time budget. Queue age is measured using wall time, not source PTS
// gaps: scrcpy legitimately emits no frames while a screen is static, and that
// idle interval must not look like congestion.
func (q *realtimeFrameQueue) push(value queuedFrame) queuePushResult {
	q.mu.Lock()
	defer q.mu.Unlock()
	now := q.now()
	if value.enqueuedAt.IsZero() {
		value.enqueuedAt = now
	}
	if q.closed {
		return q.resultLocked(1, false, false, "closed", now)
	}
	if q.adaptive != nil {
		pendingBytes := q.inFlightBytes + q.queuedBytes
		if value.keyframe || !q.waitingForKeyframe {
			pendingBytes += len(value.data)
		}
		q.adaptive.observePendingBytes(pendingBytes, now)
	}
	dropped := 0
	if value.keyframe {
		queueAge := q.queueAgeLocked(now)
		byteLimitExceeded := q.inFlightBytes+q.queuedBytes+len(value.data) > q.maxBytesLocked()
		ageLimitExceeded := queueAge > q.maxDuration
		// An IDR is a safe recovery boundary, but it must not be treated as an
		// overload signal by itself. The previous implementation discarded every
		// queued P-frame whenever a routine IDR arrived, even with queue_age=0 and
		// ample byte headroom. That created an artificial H.264 discontinuity once
		// per GOP and made the browser repeatedly wait for a new decodable chain.
		// Preserve all frames during normal operation. Only collapse the old
		// dependency chain when the real wall-clock/byte budget is already exceeded
		// (or when an earlier overload explicitly put us in wait-for-IDR mode).
		if q.waitingForKeyframe || byteLimitExceeded || ageLimitExceeded {
			dropped = len(q.frames)
			q.frames = q.frames[:0]
			q.queuedBytes = 0
			value.discontinuity = true
		}
		q.waitingForKeyframe = false
	} else if q.waitingForKeyframe {
		return q.resultLocked(1, false, false, "waiting_for_idr", now)
	} else {
		queueAge := q.queueAgeLocked(now)
		byteLimitExceeded := q.inFlightBytes+q.queuedBytes+len(value.data) > q.maxBytesLocked()
		ageLimitExceeded := queueAge > q.maxDuration
		if !byteLimitExceeded && !ageLimitExceeded {
			q.frames = append(q.frames, value)
			q.queuedBytes += len(value.data)
			q.cond.Signal()
			return q.resultLocked(0, value.discontinuity, false, "accepted", now)
		}
		reason := "bytes"
		if ageLimitExceeded && byteLimitExceeded {
			reason = "age_and_bytes"
		} else if ageLimitExceeded {
			reason = "age"
		}
		if len(q.frames) > 0 && q.frames[0].keyframe {
			// During startup, the first IDR may still be waiting behind a burst of
			// delta frames. Keep that independently decodable bootstrap frame: if
			// it is discarded before reaching the peer, there may be no new IDR
			// before the WHEP reader times out. Drop the dependent frames instead
			// and wait for a later IDR before accepting more delta frames.
			bootstrap := q.frames[0]
			dropped = len(q.frames)
			q.frames = q.frames[:1]
			q.frames[0] = bootstrap
			q.queuedBytes = len(bootstrap.data)
			q.waitingForKeyframe = true
			return q.resultLocked(dropped, false, false, "bootstrap_"+reason, now)
		}
		// Later P-frames depend on the one we are about to discard. Drop the
		// whole dependency chain. A hard frame count is wrong here: a normal
		// 200KB IDR may take longer to transmit than ten 40fps frame intervals.
		// Keep latency and bytes bounded, then request one fresh IDR.
		dropped = len(q.frames) + 1
		q.frames = q.frames[:0]
		q.queuedBytes = 0
		q.waitingForKeyframe = true
		return q.resultLocked(dropped, false, true, reason, now)
	}
	q.frames = append(q.frames, value)
	q.queuedBytes += len(value.data)
	q.cond.Signal()
	reason := "accepted"
	if dropped > 0 {
		reason = "recovery_idr"
	}
	return q.resultLocked(dropped, value.discontinuity, false, reason, now)
}

func (q *realtimeFrameQueue) resultLocked(dropped int, discontinuity, resyncRequired bool, reason string, now time.Time) queuePushResult {
	return queuePushResult{
		dropped:        dropped,
		discontinuity:  discontinuity,
		resyncRequired: resyncRequired,
		reason:         reason,
		waitingForIDR:  q.waitingForKeyframe,
		queuedFrames:   len(q.frames),
		queuedBytes:    q.queuedBytes,
		inFlightBytes:  q.inFlightBytes,
		queuedAge:      q.queueAgeLocked(now),
		maxQueuedBytes: q.maxBytesLocked(),
		maxQueuedAge:   q.maxDuration,
	}
}

func (q *realtimeFrameQueue) maxBytesLocked() int {
	if q.adaptive == nil {
		return q.maxBytes
	}
	return q.adaptive.maxQueuedBytes(q.maxDuration, q.maxBytes)
}

func (q *realtimeFrameQueue) queueAgeLocked(now time.Time) time.Duration {
	oldest := q.inFlightStartedAt
	if len(q.frames) > 0 && (oldest.IsZero() || q.frames[0].enqueuedAt.Before(oldest)) {
		oldest = q.frames[0].enqueuedAt
	}
	if oldest.IsZero() || now.Before(oldest) {
		return 0
	}
	return now.Sub(oldest)
}

func (q *realtimeFrameQueue) pop() (queuedFrame, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.frames) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.frames) == 0 {
		return queuedFrame{}, false
	}
	value := q.frames[0]
	copy(q.frames, q.frames[1:])
	q.frames = q.frames[:len(q.frames)-1]
	q.queuedBytes -= len(value.data)
	if q.queuedBytes < 0 {
		q.queuedBytes = 0
	}
	q.inFlightBytes = len(value.data)
	q.inFlightStartedAt = q.now()
	return value, true
}

func (q *realtimeFrameQueue) completeInFlight() {
	q.mu.Lock()
	q.inFlightBytes = 0
	q.inFlightStartedAt = time.Time{}
	if q.adaptive != nil {
		q.adaptive.observePendingBytes(q.queuedBytes, q.now())
	}
	q.mu.Unlock()
}

func (q *realtimeFrameQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

type rtpPacer struct {
	baseBitrate int
	adaptive    *adaptivePacingController
	nextSendAt  time.Time
}

type adaptivePacingOptions struct {
	enabled                 bool
	midBitrate              int
	maxBitrate              int
	upThreshold             time.Duration
	maxThreshold            time.Duration
	downThreshold           time.Duration
	holdDuration            time.Duration
	receiverDriven          bool
	receiverPacketsPerBurst int
	stableHoldDuration      time.Duration
}

type playbackFeedback struct {
	StatsWindowMS             float64 `json:"statsWindowMs"`
	FramesDecodedDelta        float64 `json:"framesDecodedDelta"`
	PacketsLostDelta          float64 `json:"packetsLostDelta"`
	PacketsReceivedDelta      float64 `json:"packetsReceivedDelta"`
	NACKCountDelta            float64 `json:"nackCountDelta"`
	PLICountDelta             float64 `json:"pliCountDelta"`
	FIRCountDelta             float64 `json:"firCountDelta"`
	RetransmittedPacketsDelta float64 `json:"retransmittedPacketsDelta"`
	FreezeCountDelta          float64 `json:"freezeCountDelta"`
	JitterMS                  float64 `json:"jitterMs"`
	JitterBufferDelayMS       float64 `json:"jitterBufferDelayMs"`
	ICERTTMS                  float64 `json:"iceRttMs"`
	AvailableIncomingBitrate  float64 `json:"availableIncomingBitrate"`
	PlaybackVisible           bool    `json:"playbackVisible"`
	NegotiatedNACK            bool    `json:"negotiatedNack"`
	NegotiatedRTX             bool    `json:"negotiatedRtx"`
}

type adaptivePacingTransition struct {
	fromBitrate         int
	toBitrate           int
	pendingBytes        int
	baselineBacklog     time.Duration
	effectiveBacklog    time.Duration
	reason              string
	feedback            playbackFeedback
	fromPacketsPerBurst int
	toPacketsPerBurst   int
}

// adaptivePacingController has two mutually exclusive modes. The historical
// queue mode can raise the RTP drain rate above the baseline, while the
// receiver-driven mode keeps that drain rate fixed and only reduces the RTP
// packet group size to smooth downstream microbursts. Encoder quality and
// source FPS remain unchanged in both modes.
type adaptivePacingController struct {
	mu                     sync.Mutex
	baseBitrate            int
	midBitrate             int
	maxBitrate             int
	currentBitrate         int
	upThreshold            time.Duration
	maxThreshold           time.Duration
	downThreshold          time.Duration
	holdDuration           time.Duration
	receiverDriven         bool
	basePacketsPerBurst    int
	currentPacketsPerBurst int
	stableHoldDuration     time.Duration
	lastRaisedAt           time.Time
	lowSince               time.Time
	onTransition           func(adaptivePacingTransition)
}

func newAdaptivePacingController(baseBitrate int, options adaptivePacingOptions, onTransition func(adaptivePacingTransition)) *adaptivePacingController {
	if !options.enabled && !options.receiverDriven {
		return nil
	}
	if baseBitrate < 2_000_000 {
		baseBitrate = 12_000_000
	}
	if options.midBitrate < baseBitrate {
		options.midBitrate = baseBitrate
	}
	if options.maxBitrate < options.midBitrate {
		options.maxBitrate = options.midBitrate
	}
	if options.upThreshold < 40*time.Millisecond {
		options.upThreshold = 160 * time.Millisecond
	}
	if options.maxThreshold <= options.upThreshold {
		options.maxThreshold = options.upThreshold + time.Millisecond
	}
	if options.downThreshold <= 0 || options.downThreshold >= options.upThreshold {
		options.downThreshold = options.upThreshold / 2
	}
	if options.holdDuration < 100*time.Millisecond {
		options.holdDuration = 300 * time.Millisecond
	}
	if options.receiverDriven {
		options.midBitrate = baseBitrate
		options.maxBitrate = baseBitrate
		options.receiverPacketsPerBurst = normalizeMaxPacketsPerBurst(options.receiverPacketsPerBurst)
	}
	if options.stableHoldDuration < 5*time.Second {
		options.stableHoldDuration = 15 * time.Second
	}
	return &adaptivePacingController{
		baseBitrate:            baseBitrate,
		midBitrate:             options.midBitrate,
		maxBitrate:             options.maxBitrate,
		currentBitrate:         baseBitrate,
		upThreshold:            options.upThreshold,
		maxThreshold:           options.maxThreshold,
		downThreshold:          options.downThreshold,
		holdDuration:           options.holdDuration,
		receiverDriven:         options.receiverDriven,
		basePacketsPerBurst:    options.receiverPacketsPerBurst,
		currentPacketsPerBurst: options.receiverPacketsPerBurst,
		stableHoldDuration:     options.stableHoldDuration,
		onTransition:           onTransition,
	}
}

func (c *adaptivePacingController) observePendingBytes(pendingBytes int, now time.Time) {
	if c == nil {
		return
	}
	if c.receiverDriven {
		return
	}
	if pendingBytes < 0 {
		pendingBytes = 0
	}
	if now.IsZero() {
		now = time.Now()
	}
	c.mu.Lock()
	previous := c.currentBitrate
	baselineBacklog := pacingDuration(pendingBytes, c.baseBitrate)
	effectiveBacklog := pacingDuration(pendingBytes, c.currentBitrate)
	reason := ""
	if effectiveBacklog >= c.maxThreshold && c.currentBitrate < c.maxBitrate {
		c.currentBitrate = c.maxBitrate
		c.lastRaisedAt = now
		c.lowSince = time.Time{}
		reason = "max_backlog"
	} else if c.currentBitrate == c.baseBitrate && baselineBacklog >= c.upThreshold && c.midBitrate > c.baseBitrate {
		c.currentBitrate = c.midBitrate
		c.lastRaisedAt = now
		c.lowSince = time.Time{}
		reason = "burst_backlog"
	} else if c.currentBitrate > c.baseBitrate && baselineBacklog <= c.downThreshold {
		if c.lowSince.IsZero() {
			c.lowSince = now
		}
		if now.Sub(c.lastRaisedAt) >= c.holdDuration && now.Sub(c.lowSince) >= c.holdDuration {
			c.currentBitrate = c.baseBitrate
			c.lowSince = time.Time{}
			reason = "sustained_low_backlog"
		}
	} else {
		c.lowSince = time.Time{}
	}
	current := c.currentBitrate
	onTransition := c.onTransition
	c.mu.Unlock()
	if current != previous && onTransition != nil {
		onTransition(adaptivePacingTransition{
			fromBitrate:      previous,
			toBitrate:        current,
			pendingBytes:     pendingBytes,
			baselineBacklog:  baselineBacklog,
			effectiveBacklog: effectiveBacklog,
			reason:           reason,
		})
	}
}

func (c *adaptivePacingController) observeReceiverFeedback(feedback playbackFeedback, now time.Time) {
	if c == nil || !c.receiverDriven || feedback.StatsWindowMS < 500 {
		return
	}
	if now.IsZero() {
		now = time.Now()
	}
	c.mu.Lock()
	previous := c.currentPacketsPerBurst
	reason := ""
	lossRatio := 0.0
	if totalPackets := feedback.PacketsReceivedDelta + feedback.PacketsLostDelta; totalPackets > 0 {
		lossRatio = feedback.PacketsLostDelta / totalPackets
	}
	severe := feedback.FreezeCountDelta > 0 || feedback.PacketsLostDelta >= 20 || lossRatio >= 0.03 || feedback.JitterMS >= 250 || feedback.JitterBufferDelayMS >= 400
	// RTX is optional: generic NACK retransmission on the primary SSRC is still
	// a valid repair path. Missing NACK is the fragile case; missing RTX alone
	// must remain observable without permanently forcing the lowest tier.
	degraded := feedback.PacketsLostDelta >= 3 || lossRatio >= 0.005 || feedback.NACKCountDelta >= 6 || feedback.PLICountDelta > 0 || feedback.FIRCountDelta > 0 || feedback.JitterMS >= 120 || feedback.JitterBufferDelayMS >= 220 || !feedback.NegotiatedNACK
	if severe {
		c.currentPacketsPerBurst = 1
		c.lowSince = time.Time{}
		reason = "receiver_severe"
	} else if degraded {
		if c.currentPacketsPerBurst > 1 {
			c.currentPacketsPerBurst--
		}
		c.lowSince = time.Time{}
		reason = "receiver_degraded"
	} else if feedback.PlaybackVisible && feedback.FramesDecodedDelta > 0 && feedback.JitterMS < 60 && feedback.JitterBufferDelayMS < 160 && feedback.NACKCountDelta <= 2 {
		if c.lowSince.IsZero() {
			c.lowSince = now
		}
		if now.Sub(c.lowSince) >= c.stableHoldDuration && c.currentPacketsPerBurst < c.basePacketsPerBurst {
			c.currentPacketsPerBurst++
			c.lowSince = now
			reason = "receiver_stable"
		}
	} else {
		c.lowSince = time.Time{}
	}
	current := c.currentPacketsPerBurst
	onTransition := c.onTransition
	c.mu.Unlock()
	if current != previous && onTransition != nil {
		onTransition(adaptivePacingTransition{
			fromBitrate:         c.baseBitrate,
			toBitrate:           c.baseBitrate,
			fromPacketsPerBurst: previous,
			toPacketsPerBurst:   current,
			reason:              reason,
			feedback:            feedback,
		})
	}
}

func (c *adaptivePacingController) packetGroupSize(fallback int) int {
	fallback = normalizeMaxPacketsPerBurst(fallback)
	if c == nil || !c.receiverDriven {
		return fallback
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return normalizeMaxPacketsPerBurst(c.currentPacketsPerBurst)
}

func (c *adaptivePacingController) bitrate() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.currentBitrate
}

func (c *adaptivePacingController) maxQueuedBytes(maxDuration time.Duration, fallback int) int {
	if c != nil && c.receiverDriven {
		return fallback
	}
	bitrate := c.bitrate()
	if bitrate <= 0 || maxDuration <= 0 {
		return fallback
	}
	value := int(int64(bitrate) * maxDuration.Milliseconds() / 8 / 1000)
	if value < 32<<10 {
		return 32 << 10
	}
	return value
}

type pacingResult struct {
	payloadBytes    int
	scheduledWindow time.Duration
	queueDelay      time.Duration
}

// rtpTimestampMapper keeps the RTP media clock tied to scrcpy's absolute
// capture PTS. Dropped source frames therefore advance the clock naturally
// instead of compressing media time, and a hot-restarted source is rebased
// without making RTP timestamps run backwards.
type rtpTimestampMapper struct {
	initialized   bool
	sourceBasePTS int64
	rtpBase       uint64
	lastSourcePTS int64
	lastTimestamp uint64
	lastMappedAt  time.Time
}

type rtpTimestampMapping struct {
	timestamp      uint32
	sourceDelta    time.Duration
	timestampDelta uint64
	rebased        bool
}

func newRTPTimestampMapper(initialTimestamp uint32) *rtpTimestampMapper {
	return &rtpTimestampMapper{rtpBase: uint64(initialTimestamp)}
}

func (m *rtpTimestampMapper) mapPTS(sourcePTS int64, now time.Time) rtpTimestampMapping {
	if now.IsZero() {
		now = time.Now()
	}
	if !m.initialized {
		m.initialized = true
		m.sourceBasePTS = sourcePTS
		m.lastSourcePTS = sourcePTS
		m.lastTimestamp = m.rtpBase
		m.lastMappedAt = now
		return rtpTimestampMapping{timestamp: uint32(m.lastTimestamp)}
	}

	sourceDelta := time.Duration(0)
	if sourcePTS > 0 && m.lastSourcePTS > 0 && sourcePTS > m.lastSourcePTS {
		sourceDelta = time.Duration(sourcePTS-m.lastSourcePTS) * time.Microsecond
	}
	if sourcePTS <= 0 || m.sourceBasePTS <= 0 || sourcePTS <= m.lastSourcePTS {
		wallDelta := now.Sub(m.lastMappedAt)
		if wallDelta < time.Millisecond {
			wallDelta = time.Millisecond
		}
		advance := durationToRTPSamples64(wallDelta)
		m.rtpBase = m.lastTimestamp + advance
		m.sourceBasePTS = sourcePTS
		m.lastTimestamp = m.rtpBase
		m.lastSourcePTS = sourcePTS
		m.lastMappedAt = now
		return rtpTimestampMapping{
			timestamp:      uint32(m.lastTimestamp),
			sourceDelta:    sourceDelta,
			timestampDelta: advance,
			rebased:        true,
		}
	}

	logicalTimestamp := m.rtpBase + microsecondsToRTPSamples(uint64(sourcePTS-m.sourceBasePTS))
	if logicalTimestamp <= m.lastTimestamp {
		logicalTimestamp = m.lastTimestamp + 1
	}
	mapping := rtpTimestampMapping{
		timestamp:      uint32(logicalTimestamp),
		sourceDelta:    sourceDelta,
		timestampDelta: logicalTimestamp - m.lastTimestamp,
	}
	m.lastTimestamp = logicalTimestamp
	m.lastSourcePTS = sourcePTS
	m.lastMappedAt = now
	return mapping
}

func microsecondsToRTPSamples(microseconds uint64) uint64 {
	return microseconds * 90 / 1_000
}

func durationToRTPSamples64(duration time.Duration) uint64 {
	if duration <= 0 {
		return 1
	}
	samples := uint64(duration.Nanoseconds()) * 90_000 / uint64(time.Second)
	if samples == 0 {
		return 1
	}
	return samples
}

func newRTPPacer(bitrate int, adaptive ...*adaptivePacingController) *rtpPacer {
	if bitrate < 2_000_000 {
		bitrate = 12_000_000
	}
	pacer := &rtpPacer{baseBitrate: bitrate}
	if len(adaptive) > 0 {
		pacer.adaptive = adaptive[0]
	}
	return pacer
}

func (p *rtpPacer) reset() {
	p.nextSendAt = time.Time{}
}

func pacingDuration(bytes, bitrate int) time.Duration {
	if bytes <= 0 || bitrate <= 0 {
		return 0
	}
	nanoseconds := int64(bytes) * 8 * int64(time.Second) / int64(bitrate)
	return time.Duration(nanoseconds)
}

func (p *rtpPacer) bitrate() int {
	if p.adaptive != nil {
		if bitrate := p.adaptive.bitrate(); bitrate > 0 {
			return bitrate
		}
	}
	return p.baseBitrate
}

func (p *rtpPacer) wait(bytes int) (time.Duration, int) {
	now := time.Now()
	// Never compensate for a missed timer by sending several groups back to
	// back. That would recreate the UDP burst we are explicitly preventing.
	// A newly active screen therefore resumes its rate budget from now.
	if p.nextSendAt.IsZero() || p.nextSendAt.Before(now) {
		p.nextSendAt = now
	}
	target := p.nextSendAt
	queueDelay := time.Until(target)
	if queueDelay > 0 {
		time.Sleep(queueDelay)
	} else {
		queueDelay = 0
	}
	bitrate := p.bitrate()
	p.nextSendAt = target.Add(pacingDuration(bytes, bitrate))
	return queueDelay, bitrate
}

func main() {
	whipURL := flag.String("whip-url", "", "MediaMTX WHIP publish URL")
	signalURL := flag.String("signal-url", "", "Direct WebRTC signaling WebSocket URL")
	signalToken := flag.String("signal-token", "", "Direct WebRTC Agent bearer token")
	iceServersJSON := flag.String("ice-servers", "[]", "Direct WebRTC ICE server JSON")
	profileLevelID := flag.String("profile-level-id", "42e01f", "H264 profile-level-id from the source SPS")
	pacingBitrate := flag.Int("pacing-bitrate", 12_000_000, "maximum paced RTP wire bitrate in bits per second")
	adaptivePacing := flag.Bool("adaptive-pacing", false, "temporarily raise RTP pacing when the real pending-byte backlog crosses configured thresholds")
	adaptivePacingMidBitrate := flag.Int("adaptive-pacing-mid-bitrate", 15_000_000, "first adaptive RTP pacing tier in bits per second")
	adaptivePacingMaxBitrate := flag.Int("adaptive-pacing-max-bitrate", 20_000_000, "maximum adaptive RTP pacing tier in bits per second")
	adaptivePacingUpThreshold := flag.Duration("adaptive-pacing-up-threshold", 160*time.Millisecond, "pending drain time that raises baseline pacing to the middle tier")
	adaptivePacingMaxThreshold := flag.Duration("adaptive-pacing-max-threshold", 260*time.Millisecond, "pending drain time at the active tier that raises pacing to the maximum tier")
	adaptivePacingDownThreshold := flag.Duration("adaptive-pacing-down-threshold", 80*time.Millisecond, "baseline pending drain time considered low enough to begin decay")
	adaptivePacingHold := flag.Duration("adaptive-pacing-hold", 300*time.Millisecond, "minimum sustained low-backlog period before returning to baseline pacing")
	receiverFeedbackControl := flag.Bool("receiver-feedback-control", false, "smooth RTP packet grouping from browser WHEP feedback without reducing the pacing drain rate")
	receiverStableHold := flag.Duration("receiver-stable-hold", 15*time.Second, "continuous healthy receiver time before one pacing recovery step")
	maxPacketsPerBurst := flag.Int("max-packets-per-burst", 2, "maximum RTP packets written back-to-back in one paced group")
	queueLatency := flag.Duration("queue-latency", 400*time.Millisecond, "maximum queued source video age before a controlled IDR recovery")
	statsInterval := flag.Duration("stats-interval", 0, "emit WebRTC transport statistics at this interval; 0 disables it")
	flag.Parse()
	if *signalURL == "" && *whipURL == "" {
		fatal(errors.New("whip-url or signal-url is required"))
	}

	var stdoutMu sync.Mutex
	notifyKeyframeRequest := func(reason string) {
		stdoutMu.Lock()
		fmt.Printf("KEYFRAME_REQUEST:%s\n", reason)
		stdoutMu.Unlock()
	}
	var pc *webrtc.PeerConnection
	var track *webrtc.TrackLocalStaticRTP
	var err error
	if *signalURL != "" {
		var iceServers []webrtc.ICEServer
		if parseError := json.Unmarshal([]byte(*iceServersJSON), &iceServers); parseError != nil {
			fatal(fmt.Errorf("invalid_ice_servers:%w", parseError))
		}
		pc, track, err = connectDirectWebRTC(*signalURL, *signalToken, *profileLevelID, iceServers, notifyKeyframeRequest)
	} else {
		pc, track, err = connectWHIP(*whipURL, *profileLevelID, notifyKeyframeRequest)
	}
	if err != nil {
		fatal(err)
	}
	defer pc.Close()
	fmt.Println("READY")
	if *statsInterval > 0 {
		stopStats := make(chan struct{})
		defer close(stopStats)
		hop := "agent_to_mediamtx"
		if *signalURL != "" {
			hop = "agent_to_browser"
		}
		go reportTransportStats(pc, *statsInterval, stopStats, hop)
	}
	if err := publishFrames(os.Stdin, track, *pacingBitrate, *maxPacketsPerBurst, *queueLatency, adaptivePacingOptions{
		enabled:            *adaptivePacing,
		midBitrate:         *adaptivePacingMidBitrate,
		maxBitrate:         *adaptivePacingMaxBitrate,
		upThreshold:        *adaptivePacingUpThreshold,
		maxThreshold:       *adaptivePacingMaxThreshold,
		downThreshold:      *adaptivePacingDownThreshold,
		holdDuration:       *adaptivePacingHold,
		receiverDriven:     *receiverFeedbackControl,
		stableHoldDuration: *receiverStableHold,
	}, func() {
		stdoutMu.Lock()
		defer stdoutMu.Unlock()
		fmt.Println("RESYNC_REQUIRED")
	}); err != nil {
		fatal(err)
	}
}

// reportTransportStats makes the two WebRTC hops observable. RemoteInbound
// values are generated by MediaMTX and reported back to this publisher, so
// they isolate loss on Windows Agent -> MediaMTX from browser-side loss.
func reportTransportStats(pc *webrtc.PeerConnection, interval time.Duration, done <-chan struct{}, hop string) {
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var previousBytesSent uint64
	var previousPacketsSent uint32
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			reports := pc.GetStats()
			for _, report := range reports {
				stats, ok := report.(webrtc.OutboundRTPStreamStats)
				if !ok || stats.Kind != "video" {
					continue
				}
				bytesDelta := stats.BytesSent - previousBytesSent
				packetsDelta := stats.PacketsSent - previousPacketsSent
				previousBytesSent = stats.BytesSent
				previousPacketsSent = stats.PacketsSent
				fmt.Fprintf(os.Stderr,
					"whip publisher stats packets_sent=%d packets_delta=%d bytes_sent=%d bytes_delta=%d retransmitted_packets=%d retransmitted_bytes=%d nack=%d pli=%d discarded_packets=%d discarded_bytes=%d\n",
					stats.PacketsSent,
					packetsDelta,
					stats.BytesSent,
					bytesDelta,
					stats.RetransmittedPacketsSent,
					stats.RetransmittedBytesSent,
					stats.NACKCount,
					stats.PLICount,
					stats.PacketsDiscardedOnSend,
					stats.BytesDiscardedOnSend,
				)
				break
			}
			for _, report := range reports {
				stats, ok := report.(webrtc.RemoteInboundRTPStreamStats)
				if !ok || stats.Kind != "video" {
					continue
				}
				fmt.Fprintf(os.Stderr,
					"webrtc transport stats hop=%s lost=%d repaired=%d nack=%d jitter_ms=%.1f rtt_ms=%.1f fraction_lost=%.4f\n",
					hop,
					stats.PacketsLost,
					stats.PacketsRepaired,
					stats.NACKCount,
					stats.Jitter*1000,
					stats.RoundTripTime*1000,
					stats.FractionLost,
				)
				break
			}
			for _, report := range reports {
				stats, ok := report.(webrtc.ICECandidatePairStats)
				if !ok || !stats.Nominated {
					continue
				}
				fmt.Fprintf(os.Stderr,
					"whip ice stats state=%s rtt_ms=%.1f outgoing_bitrate=%.0f incoming_bitrate=%.0f packets_sent=%d packets_received=%d discarded_packets=%d\n",
					stats.State,
					stats.CurrentRoundTripTime*1000,
					stats.AvailableOutgoingBitrate,
					stats.AvailableIncomingBitrate,
					stats.PacketsSent,
					stats.PacketsReceived,
					stats.PacketsDiscardedOnSend,
				)
				break
			}
		}
	}
}

func connectWHIP(whipURL, profileLevelID string, onKeyframeRequest func(string)) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticRTP, error) {
	if len(profileLevelID) != 6 {
		profileLevelID = "42e01f"
	}
	codec := webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeH264,
		ClockRate:   90000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + profileLevelID,
	}
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: codec, PayloadType: 102}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, err
	}
	// Negotiate a dedicated RTX repair stream. Generic NACK still works when
	// the WHIP server declines RTX, while compatible servers can keep repairs
	// away from the primary H.264 sequence-number space.
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeRTX,
			ClockRate:   90000,
			SDPFmtpLine: "apt=102",
		},
		PayloadType: 103,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, nil, err
	}
	interceptorRegistry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptorsWithOptions(
		mediaEngine,
		interceptorRegistry,
		webrtc.WithNackResponderOptions(nack.ResponderSize(2048)),
	); err != nil {
		return nil, nil, err
	}
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(interceptorRegistry),
	)
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, nil, err
	}
	connected := make(chan error, 1)
	var connectedOnce sync.Once
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			connectedOnce.Do(func() { connected <- nil })
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			connectedOnce.Do(func() { connected <- fmt.Errorf("whip_peer_connection_%s", state.String()) })
		}
	})
	track, err := webrtc.NewTrackLocalStaticRTP(codec, "screen", "phone-cloud")
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	rtpSender, err := pc.AddTrack(track)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	// Pion requires applications to consume RTCP feedback. Leaving it unread
	// eventually blocks feedback processing under loss, exactly when a live
	// screen stream needs NACK/PLI handling to stay healthy.
	go drainRTCP(rtpSender, onKeyframeRequest)
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		return nil, nil, err
	}
	<-gathered

	req, err := http.NewRequest(http.MethodPost, whipURL, bytes.NewBufferString(pc.LocalDescription().SDP))
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/sdp")
	req.Header.Set("Accept", "application/sdp")
	response, err := (&http.Client{Timeout: 12 * time.Second}).Do(req)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	defer response.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK {
		pc.Close()
		return nil, nil, fmt.Errorf("whip_publish_failed:%d:%s", response.StatusCode, string(answer))
	}
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: string(answer)}); err != nil {
		pc.Close()
		return nil, nil, err
	}
	fmt.Fprintf(os.Stderr,
		"whip negotiated feedback nack=%t pli=%t transport_cc=%t rtx=%t\n",
		strings.Contains(string(answer), "a=rtcp-fb:102 nack"),
		strings.Contains(string(answer), "a=rtcp-fb:102 nack pli"),
		strings.Contains(string(answer), "a=rtcp-fb:102 transport-cc"),
		strings.Contains(string(answer), "a=rtpmap:103 rtx/90000"),
	)
	select {
	case connectionError := <-connected:
		if connectionError != nil {
			pc.Close()
			return nil, nil, connectionError
		}
	case <-time.After(8 * time.Second):
		pc.Close()
		return nil, nil, errors.New("whip_peer_connection_timeout")
	}
	return pc, track, nil
}

func connectDirectWebRTC(signalURL, signalToken, profileLevelID string, iceServers []webrtc.ICEServer, onKeyframeRequest func(string)) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticRTP, error) {
	if !strings.HasPrefix(signalURL, "ws://") && !strings.HasPrefix(signalURL, "wss://") {
		return nil, nil, errors.New("invalid_direct_webrtc_signal_url")
	}
	if strings.TrimSpace(signalToken) == "" {
		return nil, nil, errors.New("direct_webrtc_agent_token_required")
	}
	codec, api, err := buildWebRTCAPI(profileLevelID)
	if err != nil {
		return nil, nil, err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
	if err != nil {
		return nil, nil, err
	}
	connected := make(chan error, 1)
	var connectedOnce sync.Once
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			connectedOnce.Do(func() { connected <- nil })
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			connectedOnce.Do(func() { connected <- fmt.Errorf("direct_webrtc_peer_connection_%s", state.String()) })
		}
	})
	track, err := webrtc.NewTrackLocalStaticRTP(codec, "screen", "phone-cloud")
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	rtpSender, err := pc.AddTrack(track)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	go drainRTCP(rtpSender, onKeyframeRequest)

	conn, _, err := websocket.DefaultDialer.Dial(signalURL, http.Header{
		"Authorization": []string{"Bearer " + signalToken},
	})
	if err != nil {
		pc.Close()
		return nil, nil, fmt.Errorf("direct_webrtc_signal_connect_failed:%w", err)
	}
	closed := make(chan struct{})
	keepSignal := false
	defer func() {
		if !keepSignal {
			close(closed)
			conn.Close()
		}
	}()

	_, payload, err := conn.ReadMessage()
	if err != nil {
		pc.Close()
		return nil, nil, fmt.Errorf("direct_webrtc_offer_read_failed:%w", err)
	}
	var offerMessage struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}
	if err := json.Unmarshal(payload, &offerMessage); err != nil || offerMessage.Type != "offer" || offerMessage.SDP == "" {
		pc.Close()
		return nil, nil, errors.New("direct_webrtc_offer_invalid")
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerMessage.SDP}); err != nil {
		pc.Close()
		return nil, nil, fmt.Errorf("direct_webrtc_offer_apply_failed:%w", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return nil, nil, err
	}
	<-gathered
	answerPayload, _ := json.Marshal(struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}{Type: "answer", SDP: pc.LocalDescription().SDP})
	if err := conn.WriteMessage(websocket.TextMessage, answerPayload); err != nil {
		pc.Close()
		return nil, nil, fmt.Errorf("direct_webrtc_answer_send_failed:%w", err)
	}
	go func() {
		for {
			if _, _, readError := conn.ReadMessage(); readError != nil {
				select {
				case <-closed:
				default:
					pc.Close()
				}
				return
			}
		}
	}()
	select {
	case connectionError := <-connected:
		if connectionError != nil {
			pc.Close()
			return nil, nil, connectionError
		}
	case <-time.After(12 * time.Second):
		pc.Close()
		return nil, nil, errors.New("direct_webrtc_peer_connection_timeout")
	}
	keepSignal = true
	return pc, track, nil
}

func buildWebRTCAPI(profileLevelID string) (webrtc.RTPCodecCapability, *webrtc.API, error) {
	if len(profileLevelID) != 6 {
		profileLevelID = "42e01f"
	}
	codec := webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeH264,
		ClockRate:   90000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + profileLevelID,
	}
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: codec, PayloadType: 102}, webrtc.RTPCodecTypeVideo); err != nil {
		return codec, nil, err
	}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeRTX, ClockRate: 90000, SDPFmtpLine: "apt=102"},
		PayloadType:        103,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return codec, nil, err
	}
	interceptorRegistry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptorsWithOptions(mediaEngine, interceptorRegistry, webrtc.WithNackResponderOptions(nack.ResponderSize(2048))); err != nil {
		return codec, nil, err
	}
	return codec, webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(interceptorRegistry)), nil
}

func publishFrames(input io.Reader, track *webrtc.TrackLocalStaticRTP, pacingBitrate int, maxPacketsPerBurst int, queueLatency time.Duration, adaptiveOptions adaptivePacingOptions, onResyncRequired func()) error {
	reader := bufio.NewReaderSize(input, 1<<20)
	packetizer := rtp.NewPacketizer(1200, 102, 0, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90_000)
	timestampMapper := newRTPTimestampMapper(uint32(time.Now().UnixNano()))
	adaptiveOptions.receiverPacketsPerBurst = maxPacketsPerBurst
	adaptive := newAdaptivePacingController(pacingBitrate, adaptiveOptions, func(transition adaptivePacingTransition) {
		if adaptiveOptions.receiverDriven {
			fmt.Fprintf(os.Stderr,
				"whip receiver_smoothing packets_per_group=%d->%d pacing_mbps=%.1f reason=%s received_delta=%.0f lost_delta=%.0f nack_delta=%.0f rtx_delta=%.0f pli_delta=%.0f freeze_delta=%.0f jitter_ms=%.1f jitter_buffer_ms=%.1f ice_rtt_ms=%.1f incoming_bitrate=%.0f\n",
				transition.fromPacketsPerBurst,
				transition.toPacketsPerBurst,
				float64(transition.toBitrate)/1_000_000,
				transition.reason,
				transition.feedback.PacketsReceivedDelta,
				transition.feedback.PacketsLostDelta,
				transition.feedback.NACKCountDelta,
				transition.feedback.RetransmittedPacketsDelta,
				transition.feedback.PLICountDelta,
				transition.feedback.FreezeCountDelta,
				transition.feedback.JitterMS,
				transition.feedback.JitterBufferDelayMS,
				transition.feedback.ICERTTMS,
				transition.feedback.AvailableIncomingBitrate,
			)
			return
		}
		fmt.Fprintf(os.Stderr,
			"whip adaptive_pacing rate_mbps=%.1f->%.1f reason=%s pending_bytes=%d baseline_backlog_ms=%d effective_backlog_ms=%d\n",
			float64(transition.fromBitrate)/1_000_000,
			float64(transition.toBitrate)/1_000_000,
			transition.reason,
			transition.pendingBytes,
			transition.baselineBacklog.Milliseconds(),
			transition.effectiveBacklog.Milliseconds(),
		)
	})
	pacer := newRTPPacer(pacingBitrate, adaptive)
	// Queue in milliseconds and bytes, never in an arbitrary number of frames.
	// At 40fps an IDR paced for 400ms naturally overlaps sixteen source frames.
	if queueLatency < 100*time.Millisecond {
		queueLatency = 100 * time.Millisecond
	}
	maxQueuedBytes := int(int64(pacingBitrate) * queueLatency.Milliseconds() / 8 / 1000)
	queue := newRealtimeFrameQueue(queueLatency, maxQueuedBytes, adaptive)
	if adaptive != nil {
		if adaptive.receiverDriven {
			fmt.Fprintf(os.Stderr,
				"whip receiver_smoothing enabled pacing_mbps=%.1f packets_per_group=%d->1 stable_hold_ms=%d fixed_queue_bytes=%d\n",
				float64(pacingBitrate)/1_000_000,
				adaptive.basePacketsPerBurst,
				adaptive.stableHoldDuration.Milliseconds(),
				maxQueuedBytes,
			)
		} else {
			fmt.Fprintf(os.Stderr,
				"whip adaptive_pacing enabled base_mbps=%.1f mid_mbps=%.1f max_mbps=%.1f up_ms=%d max_up_ms=%d down_ms=%d hold_ms=%d base_queue_bytes=%d\n",
				float64(pacingBitrate)/1_000_000,
				float64(adaptive.midBitrate)/1_000_000,
				float64(adaptive.maxBitrate)/1_000_000,
				adaptive.upThreshold.Milliseconds(),
				adaptive.maxThreshold.Milliseconds(),
				adaptive.downThreshold.Milliseconds(),
				adaptive.holdDuration.Milliseconds(),
				maxQueuedBytes,
			)
		}
	}
	readResult := make(chan error, 1)
	var queueDropLogs eventLogLimiter
	go func() {
		defer queue.close()
		var config []byte
		for {
			value, err := readFrame(reader)
			if errors.Is(err, io.EOF) {
				readResult <- nil
				return
			}
			if err != nil {
				readResult <- err
				return
			}
			if value.kind == frameKindConfiguration {
				config = append(config[:0], value.data...)
				continue
			}
			if value.kind == frameKindPlaybackFeedback {
				if adaptive != nil && adaptive.receiverDriven {
					var feedback playbackFeedback
					if err := json.Unmarshal(value.data, &feedback); err != nil {
						fmt.Fprintf(os.Stderr, "whip receiver_feedback invalid_json=%q\n", err.Error())
						continue
					}
					adaptive.observeReceiverFeedback(feedback, time.Now())
				}
				continue
			}
			keyframe := value.kind == frameKindKeyframe
			data := value.data
			if keyframe && len(config) > 0 {
				data = prependH264Configuration(config, value.data)
			}
			result := queue.push(queuedFrame{
				data:     data,
				keyframe: keyframe,
				pts:      value.pts,
			})
			if result.dropped > 0 {
				signature := fmt.Sprintf("%s/%t", result.reason, result.waitingForIDR)
				if shouldLog, suppressed := queueDropLogs.allow(time.Now(), signature); shouldLog {
					fmt.Fprintf(os.Stderr,
						"whip realtime queue_drop frames=%d reason=%s waiting_for_idr=%t queued_frames=%d queued_bytes=%d in_flight_bytes=%d queue_age_ms=%d max_bytes=%d max_age_ms=%d suppressed=%d\n",
						result.dropped,
						result.reason,
						result.waitingForIDR,
						result.queuedFrames,
						result.queuedBytes,
						result.inFlightBytes,
						result.queuedAge.Milliseconds(),
						result.maxQueuedBytes,
						result.maxQueuedAge.Milliseconds(),
						suppressed,
					)
				}
			}
			if result.resyncRequired {
				// Re-inserting an old IDR in the middle of a newer H.264 GOP resets
				// the decoder reference picture buffer. The following source P-frames
				// then reference pictures the browser never received, causing visible
				// tearing and stale-image artifacts. Hold the queue until Android
				// produces a fresh IDR instead.
				if onResyncRequired != nil {
					onResyncRequired()
				}
			}
		}
	}()

	for {
		frame, ok := queue.pop()
		if !ok {
			return <-readResult
		}
		if frame.discontinuity {
			pacer.reset()
		}
		mapping := timestampMapper.mapPTS(frame.pts, time.Now())
		packets := packetizer.Packetize(frame.data, 0)
		for _, packet := range packets {
			packet.Timestamp = mapping.timestamp
		}
		if len(packets) == 0 {
			queue.completeInFlight()
			continue
		}
		packetsPerBurst := maxPacketsPerBurst
		if adaptive != nil {
			packetsPerBurst = adaptive.packetGroupSize(maxPacketsPerBurst)
		}
		result, err := writePacketsPaced(track, packets, pacer, packetsPerBurst)
		queue.completeInFlight()
		if err != nil {
			return err
		}
		if frame.keyframe || len(packets) >= 24 {
			fmt.Fprintf(os.Stderr, "whip packetize frame_bytes=%d packets=%d source_delta_ms=%d rtp_delta=%d rtp_rebased=%t keyframe=%t discontinuity=%t pacing_mbps=%.1f max_packets_per_burst=%d pacing_window_ms=%d queue_delay_ms=%d\n", len(frame.data), len(packets), mapping.sourceDelta.Milliseconds(), mapping.timestampDelta, mapping.rebased, frame.keyframe, frame.discontinuity, float64(pacer.bitrate())/1_000_000, normalizeMaxPacketsPerBurst(packetsPerBurst), result.scheduledWindow.Milliseconds(), result.queueDelay.Milliseconds())
		}
		if frame.keyframe {
			// READY only means WHIP negotiation completed. Do not let the browser
			// create a WHEP reader until a decodable IDR has actually been written
			// into the MediaMTX track; otherwise MediaMTX correctly answers 404.
			fmt.Println("KEYFRAME_SENT")
		}
	}
}

func prependH264Configuration(configuration, keyframe []byte) []byte {
	if len(configuration) == 0 {
		return keyframe
	}
	data := make([]byte, 0, len(configuration)+len(keyframe))
	data = append(data, configuration...)
	data = append(data, keyframe...)
	return data
}

func normalizeMaxPacketsPerBurst(value int) int {
	if value < 1 || value > 8 {
		return 8
	}
	return value
}

func writePacketsPaced(track *webrtc.TrackLocalStaticRTP, packets []*rtp.Packet, pacer *rtpPacer, maxPacketsPerBurst int) (pacingResult, error) {
	result := pacingResult{}
	if len(packets) == 0 {
		return result, nil
	}
	// The old implementation split every large frame into a fixed 120ms
	// window. That still emitted small frames at 30-40Mbps and stalled the
	// scrcpy reader during motion. Pace actual RTP byte volume continuously,
	// in small groups to keep Windows timer overhead practical.
	maxPacketsPerBurst = normalizeMaxPacketsPerBurst(maxPacketsPerBurst)
	for start := 0; start < len(packets); start += maxPacketsPerBurst {
		end := start + maxPacketsPerBurst
		if end > len(packets) {
			end = len(packets)
		}
		burstBytes := 0
		for _, packet := range packets[start:end] {
			burstBytes += packet.MarshalSize()
		}
		result.payloadBytes += burstBytes
		queueDelay, bitrate := pacer.wait(burstBytes)
		if queueDelay > result.queueDelay {
			result.queueDelay = queueDelay
		}
		result.scheduledWindow += pacingDuration(burstBytes, bitrate)
		for _, packet := range packets[start:end] {
			if err := track.WriteRTP(packet); err != nil {
				return result, err
			}
		}
	}
	return result, nil
}

func drainRTCP(sender *webrtc.RTPSender, onKeyframeRequest func(string)) {
	var lastKeyframeRequest time.Time
	var nackLogs eventLogLimiter
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, packet := range packets {
			if nack, ok := packet.(*rtcp.TransportLayerNack); ok {
				lost := 0
				sequences := make([]uint16, 0, 12)
				for index := range nack.Nacks {
					list := nack.Nacks[index].PacketList()
					lost += len(list)
					for _, sequence := range list {
						if len(sequences) < cap(sequences) {
							sequences = append(sequences, sequence)
						}
					}
				}
				signature := fmt.Sprintf("%d/%d", len(nack.Nacks), lost)
				if shouldLog, suppressed := nackLogs.allow(time.Now(), signature); shouldLog {
					fmt.Fprintf(os.Stderr, "whip rtcp nack pairs=%d lost_packets=%d sample_sequences=%v suppressed=%d\n", len(nack.Nacks), lost, sequences, suppressed)
				}
			}
			reason := ""
			switch packet.(type) {
			case *rtcp.PictureLossIndication:
				reason = "pli"
			case *rtcp.FullIntraRequest:
				reason = "fir"
			}
			if reason == "" || onKeyframeRequest == nil || time.Since(lastKeyframeRequest) < 750*time.Millisecond {
				continue
			}
			lastKeyframeRequest = time.Now()
			onKeyframeRequest(reason)
		}
	}
}

func readFrame(reader io.Reader) (frame, error) {
	var header [frameHeaderSize]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return frame{}, err
	}
	length := binary.BigEndian.Uint32(header[9:])
	if length == 0 || length > 8<<20 {
		return frame{}, fmt.Errorf("invalid_frame_size:%d", length)
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(reader, data); err != nil {
		return frame{}, err
	}
	return frame{kind: header[0], pts: int64(binary.BigEndian.Uint64(header[1:9])), data: data}, nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(1)
}
