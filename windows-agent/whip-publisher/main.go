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
	frameKindConfiguration byte = 0
	frameKindData          byte = 1
	frameKindKeyframe      byte = 2
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
	now                func() time.Time
}

func newRealtimeFrameQueue(maxDuration time.Duration, maxBytes int) *realtimeFrameQueue {
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
	dropped := 0
	if value.keyframe {
		queueAge := q.queueAgeLocked(now)
		byteLimitExceeded := q.inFlightBytes+q.queuedBytes+len(value.data) > q.maxBytes
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
		byteLimitExceeded := q.inFlightBytes+q.queuedBytes+len(value.data) > q.maxBytes
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
		maxQueuedBytes: q.maxBytes,
		maxQueuedAge:   q.maxDuration,
	}
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
	q.mu.Unlock()
}

func (q *realtimeFrameQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

type rtpPacer struct {
	bitrate    int
	nextSendAt time.Time
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

func newRTPPacer(bitrate int) *rtpPacer {
	if bitrate < 2_000_000 {
		bitrate = 12_000_000
	}
	return &rtpPacer{bitrate: bitrate}
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

func (p *rtpPacer) wait(bytes int) time.Duration {
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
	p.nextSendAt = target.Add(pacingDuration(bytes, p.bitrate))
	return queueDelay
}

func main() {
	whipURL := flag.String("whip-url", "", "MediaMTX WHIP publish URL")
	signalURL := flag.String("signal-url", "", "Direct WebRTC signaling WebSocket URL")
	signalToken := flag.String("signal-token", "", "Direct WebRTC Agent bearer token")
	iceServersJSON := flag.String("ice-servers", "[]", "Direct WebRTC ICE server JSON")
	profileLevelID := flag.String("profile-level-id", "42e01f", "H264 profile-level-id from the source SPS")
	pacingBitrate := flag.Int("pacing-bitrate", 12_000_000, "maximum paced RTP wire bitrate in bits per second")
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
		go reportTransportStats(pc, *statsInterval, stopStats)
	}
	if err := publishFrames(os.Stdin, track, *pacingBitrate, *queueLatency, func() {
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
func reportTransportStats(pc *webrtc.PeerConnection, interval time.Duration, done <-chan struct{}) {
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
					"whip transport stats hop=agent_to_mediamtx lost=%d repaired=%d nack=%d jitter_ms=%.1f rtt_ms=%.1f fraction_lost=%.4f\n",
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

func publishFrames(input io.Reader, track *webrtc.TrackLocalStaticRTP, pacingBitrate int, queueLatency time.Duration, onResyncRequired func()) error {
	reader := bufio.NewReaderSize(input, 1<<20)
	packetizer := rtp.NewPacketizer(1200, 102, 0, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90_000)
	timestampMapper := newRTPTimestampMapper(uint32(time.Now().UnixNano()))
	pacer := newRTPPacer(pacingBitrate)
	// Queue in milliseconds and bytes, never in an arbitrary number of frames.
	// At 40fps an IDR paced for 400ms naturally overlaps sixteen source frames.
	if queueLatency < 100*time.Millisecond {
		queueLatency = 100 * time.Millisecond
	}
	maxQueuedBytes := int(int64(pacingBitrate) * queueLatency.Milliseconds() / 8 / 1000)
	queue := newRealtimeFrameQueue(queueLatency, maxQueuedBytes)
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
			keyframe := value.kind == frameKindKeyframe
			data := value.data
			if keyframe && len(config) > 0 {
				data = make([]byte, 0, len(config)+len(value.data))
				data = append(data, config...)
				data = append(data, value.data...)
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
		result, err := writePacketsPaced(track, packets, pacer)
		queue.completeInFlight()
		if err != nil {
			return err
		}
		if frame.keyframe || len(packets) >= 24 {
			fmt.Fprintf(os.Stderr, "whip packetize frame_bytes=%d packets=%d source_delta_ms=%d rtp_delta=%d rtp_rebased=%t keyframe=%t discontinuity=%t pacing_mbps=%.1f pacing_window_ms=%d queue_delay_ms=%d\n", len(frame.data), len(packets), mapping.sourceDelta.Milliseconds(), mapping.timestampDelta, mapping.rebased, frame.keyframe, frame.discontinuity, float64(pacer.bitrate)/1_000_000, result.scheduledWindow.Milliseconds(), result.queueDelay.Milliseconds())
		}
		if frame.keyframe {
			// READY only means WHIP negotiation completed. Do not let the browser
			// create a WHEP reader until a decodable IDR has actually been written
			// into the MediaMTX track; otherwise MediaMTX correctly answers 404.
			fmt.Println("KEYFRAME_SENT")
		}
	}
}

func writePacketsPaced(track *webrtc.TrackLocalStaticRTP, packets []*rtp.Packet, pacer *rtpPacer) (pacingResult, error) {
	result := pacingResult{}
	if len(packets) == 0 {
		return result, nil
	}
	// The old implementation split every large frame into a fixed 120ms
	// window. That still emitted small frames at 30-40Mbps and stalled the
	// scrcpy reader during motion. Pace actual RTP byte volume continuously,
	// in small groups to keep Windows timer overhead practical.
	const maxPacketsPerBurst = 8
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
		queueDelay := pacer.wait(burstBytes)
		if queueDelay > result.queueDelay {
			result.queueDelay = queueDelay
		}
		for _, packet := range packets[start:end] {
			if err := track.WriteRTP(packet); err != nil {
				return result, err
			}
		}
	}
	result.scheduledWindow = pacingDuration(result.payloadBytes, pacer.bitrate)
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
