package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

func TestDirectWebRTCAdvertisesH264NACKAndRTX(t *testing.T) {
	codec, publisherAPI, err := buildWebRTCAPI("42e01f")
	if err != nil {
		t.Fatal(err)
	}
	_, browserAPI, err := buildWebRTCAPI("42e01f")
	if err != nil {
		t.Fatal(err)
	}
	browser, err := browserAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	if _, err = browser.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	offer, err := browser.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}

	publisher, err := publisherAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(codec, "screen", "phone-cloud")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = publisher.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	if err = publisher.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := publisher.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		"a=rtpmap:102 H264/90000",
		"a=rtpmap:103 rtx/90000",
		"a=fmtp:103 apt=102",
		"a=rtcp-fb:102 nack",
	} {
		if !strings.Contains(answer.SDP, line) {
			t.Fatalf("direct WebRTC answer is missing %q:\n%s", line, answer.SDP)
		}
	}
}

func TestEventLogLimiterSuppressesRepeatedFeedback(t *testing.T) {
	var limiter eventLogLimiter
	base := time.Date(2026, time.July, 29, 0, 0, 0, 0, time.UTC)
	if shouldLog, suppressed := limiter.allow(base, "1/1"); !shouldLog || suppressed != 0 {
		t.Fatalf("first NACK: shouldLog=%t suppressed=%d", shouldLog, suppressed)
	}
	if shouldLog, suppressed := limiter.allow(base.Add(time.Second), "1/1"); shouldLog || suppressed != 0 {
		t.Fatalf("repeated NACK inside interval: shouldLog=%t suppressed=%d", shouldLog, suppressed)
	}
	if shouldLog, suppressed := limiter.allow(base.Add(2*time.Second), "1/1"); !shouldLog || suppressed != 1 {
		t.Fatalf("repeated NACK after interval: shouldLog=%t suppressed=%d", shouldLog, suppressed)
	}
}

func TestEventLogLimiterLogsDifferentLossShapeImmediately(t *testing.T) {
	var limiter eventLogLimiter
	base := time.Date(2026, time.July, 29, 0, 0, 0, 0, time.UTC)
	_, _ = limiter.allow(base, "1/1")
	if shouldLog, _ := limiter.allow(base.Add(time.Millisecond), "2/3"); !shouldLog {
		t.Fatal("different loss shape should be logged immediately")
	}
}

func TestNormalizeMaxPacketsPerBurstKeepsCanaryAndDefaultsSafely(t *testing.T) {
	for _, testCase := range []struct {
		input int
		want  int
	}{
		{input: 2, want: 2},
		{input: 8, want: 8},
		{input: 0, want: 8},
		{input: 9, want: 8},
	} {
		if got := normalizeMaxPacketsPerBurst(testCase.input); got != testCase.want {
			t.Fatalf("normalizeMaxPacketsPerBurst(%d)=%d, want %d", testCase.input, got, testCase.want)
		}
	}
}

func TestRealtimeFrameQueueWaitsForAnIDR(t *testing.T) {
	queue := newRealtimeFrameQueue(100*time.Millisecond, 1024)
	if result := queue.push(queuedFrame{data: []byte{1}}); result.dropped != 1 || result.discontinuity || result.resyncRequired || result.reason != "waiting_for_idr" {
		t.Fatalf("delta frame before the first keyframe: %#v", result)
	}
	if result := queue.push(queuedFrame{data: []byte{2}, keyframe: true}); result.dropped != 0 || !result.discontinuity || result.resyncRequired {
		t.Fatalf("first keyframe: %#v", result)
	}
	value, ok := queue.pop()
	if !ok || !value.keyframe || !value.discontinuity {
		t.Fatalf("expected the first queue entry to be a discontinuity keyframe: %#v, ok=%t", value, ok)
	}
}

func TestRealtimeFrameQueueDropsDependencyChainWhenOverloaded(t *testing.T) {
	queue := newRealtimeFrameQueue(100*time.Millisecond, 32<<10)
	queue.push(queuedFrame{data: []byte{1}, keyframe: true})
	_, _ = queue.pop()
	queue.completeInFlight()
	queue.push(queuedFrame{data: make([]byte, 12<<10)})
	queue.push(queuedFrame{data: make([]byte, 12<<10)})
	if result := queue.push(queuedFrame{data: make([]byte, 12<<10)}); result.dropped != 3 || result.discontinuity || !result.resyncRequired || result.reason != "bytes" {
		t.Fatalf("overflow should discard the dependency chain: %#v", result)
	}
	if result := queue.push(queuedFrame{data: []byte{5}}); result.dropped != 1 || result.discontinuity || result.resyncRequired {
		t.Fatalf("delta frame after overflow: %#v", result)
	}
	if result := queue.push(queuedFrame{data: []byte{6}, keyframe: true}); result.dropped != 0 || !result.discontinuity || result.resyncRequired {
		t.Fatalf("recovery keyframe: %#v", result)
	}
	value, ok := queue.pop()
	if !ok || !value.keyframe || !value.discontinuity || value.data[0] != 6 {
		t.Fatalf("expected fresh keyframe after recovery: %#v, ok=%t", value, ok)
	}
}

func TestRealtimeFrameQueueKeepsBootstrapIDROnStartupOverflow(t *testing.T) {
	queue := newRealtimeFrameQueue(400*time.Millisecond, 32<<10)
	bootstrap := queuedFrame{data: make([]byte, 28<<10), keyframe: true}
	if result := queue.push(bootstrap); result.dropped != 0 || !result.discontinuity || result.resyncRequired {
		t.Fatalf("bootstrap IDR: %#v", result)
	}
	if result := queue.push(queuedFrame{data: make([]byte, 8<<10)}); result.dropped != 1 || result.discontinuity || result.resyncRequired || result.reason != "bootstrap_bytes" {
		t.Fatalf("startup overflow must retain the bootstrap IDR: %#v", result)
	}
	value, ok := queue.pop()
	if !ok || !value.keyframe || !value.discontinuity {
		t.Fatalf("expected queued bootstrap IDR after overflow: %#v, ok=%t", value, ok)
	}
	queue.completeInFlight()
	if result := queue.push(queuedFrame{data: []byte{1}}); result.dropped != 1 || result.discontinuity || result.resyncRequired {
		t.Fatalf("delta frames must wait for a later IDR after bootstrap delivery: %#v", result)
	}
}

func TestRealtimeFrameQueueIncludesInFlightFrameInByteBudget(t *testing.T) {
	queue := newRealtimeFrameQueue(400*time.Millisecond, 200_000)
	queue.push(queuedFrame{data: make([]byte, 150_000), keyframe: true})
	_, _ = queue.pop()
	if result := queue.push(queuedFrame{data: make([]byte, 40_000)}); result.dropped != 0 || result.resyncRequired {
		t.Fatalf("frame inside remaining byte budget should be accepted: %#v", result)
	}
	if result := queue.push(queuedFrame{data: make([]byte, 20_000)}); result.dropped != 2 || !result.resyncRequired || result.reason != "bytes" || result.inFlightBytes != 150_000 {
		t.Fatalf("in-flight IDR must count toward the real-time byte budget: %#v", result)
	}
}

func TestRealtimeFrameQueuePreservesRoutineGOPBeforeIDR(t *testing.T) {
	queue := newRealtimeFrameQueue(400*time.Millisecond, 500_000)
	queue.push(queuedFrame{data: []byte{1}, keyframe: true})
	_, _ = queue.pop()
	queue.completeInFlight()
	queue.push(queuedFrame{data: []byte{2}})
	queue.push(queuedFrame{data: []byte{3}})
	result := queue.push(queuedFrame{data: []byte{4}, keyframe: true})
	if result.dropped != 0 || result.discontinuity || result.resyncRequired || result.reason != "accepted" {
		t.Fatalf("routine IDR must not discard a healthy queued GOP: %#v", result)
	}
	for index, expected := range []byte{2, 3, 4} {
		value, ok := queue.pop()
		if !ok || len(value.data) != 1 || value.data[0] != expected {
			t.Fatalf("queued frame %d must remain in source order: %#v, ok=%t", index, value, ok)
		}
		queue.completeInFlight()
	}
}

func TestRealtimeFrameQueueUsesNewIDRAsOverloadBoundary(t *testing.T) {
	queue := newRealtimeFrameQueue(400*time.Millisecond, 32<<10)
	queue.push(queuedFrame{data: make([]byte, 12<<10), keyframe: true})
	_, _ = queue.pop()
	queue.push(queuedFrame{data: make([]byte, 8<<10)})
	result := queue.push(queuedFrame{data: make([]byte, 16<<10), keyframe: true})
	if result.dropped != 1 || !result.discontinuity || result.resyncRequired || result.reason != "recovery_idr" {
		t.Fatalf("over-budget IDR must replace only the queued dependency chain: %#v", result)
	}
	queue.completeInFlight()
	value, ok := queue.pop()
	if !ok || !value.keyframe || !value.discontinuity || len(value.data) != 16<<10 {
		t.Fatalf("fresh overload-boundary IDR must be next: %#v, ok=%t", value, ok)
	}
}

func TestRealtimeFrameQueueRecoversFromObservedLargeIDRBurst(t *testing.T) {
	// Production logs showed roughly 229KB IDRs. At a 500KB real-time budget,
	// the in-flight IDR plus following P-frames may exceed the budget, but the
	// queue must discard the dependent GOP and resume only from a fresh IDR.
	queue := newRealtimeFrameQueue(400*time.Millisecond, 500_000)
	firstIDR := queue.push(queuedFrame{data: make([]byte, 229_344), keyframe: true, pts: 1_000_000})
	if firstIDR.dropped != 0 || !firstIDR.discontinuity {
		t.Fatalf("first observed-size IDR must start the stream: %#v", firstIDR)
	}
	_, _ = queue.pop()
	for range 22 {
		result := queue.push(queuedFrame{data: make([]byte, 12_000)})
		if result.dropped != 0 {
			t.Fatalf("burst should fit until the measured byte budget is reached: %#v", result)
		}
	}
	overflow := queue.push(queuedFrame{data: make([]byte, 12_000)})
	if overflow.dropped != 23 || !overflow.resyncRequired || overflow.reason != "bytes" || !overflow.waitingForIDR {
		t.Fatalf("large-IDR burst must discard one complete dependent chain: %#v", overflow)
	}
	queue.completeInFlight()
	if waiting := queue.push(queuedFrame{data: make([]byte, 8_000)}); waiting.reason != "waiting_for_idr" {
		t.Fatalf("delta frame after overload must not be emitted: %#v", waiting)
	}
	fresh := queue.push(queuedFrame{data: make([]byte, 210_000), keyframe: true, pts: 2_000_000})
	if fresh.dropped != 0 || !fresh.discontinuity || fresh.waitingForIDR {
		t.Fatalf("fresh source IDR must recover the stream: %#v", fresh)
	}
}

func TestRealtimeFrameQueueUsesWallAgeInsteadOfStaticSourceGap(t *testing.T) {
	queue := newRealtimeFrameQueue(400*time.Millisecond, 1<<20)
	now := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	queue.now = func() time.Time { return now }
	queue.push(queuedFrame{data: []byte{1}, keyframe: true, pts: 1_000_000})
	_, _ = queue.pop()
	queue.completeInFlight()
	// A ten-minute source PTS jump is a static-screen gap, not queued latency.
	if result := queue.push(queuedFrame{data: []byte{2}, pts: 601_000_000}); result.dropped != 0 || result.resyncRequired {
		t.Fatalf("static source gap must not overflow the realtime queue: %#v", result)
	}
	now = now.Add(450 * time.Millisecond)
	if result := queue.push(queuedFrame{data: []byte{3}, pts: 601_025_000}); result.dropped != 2 || !result.resyncRequired || result.reason != "age" {
		t.Fatalf("real wall-clock queue age must trigger resync: %#v", result)
	}
}

func TestAdaptivePacingRaisesThroughTiersAndDecaysWithHysteresis(t *testing.T) {
	controller := newAdaptivePacingController(10_000_000, adaptivePacingOptions{
		enabled:       true,
		midBitrate:    15_000_000,
		maxBitrate:    20_000_000,
		upThreshold:   160 * time.Millisecond,
		maxThreshold:  260 * time.Millisecond,
		downThreshold: 80 * time.Millisecond,
		holdDuration:  300 * time.Millisecond,
	}, nil)
	base := time.Date(2026, time.August, 28, 0, 0, 0, 0, time.UTC)

	controller.observePendingBytes(216_842, base)
	if got := controller.bitrate(); got != 15_000_000 {
		t.Fatalf("observed 173ms baseline burst should raise to 15Mbps, got %d", got)
	}
	controller.observePendingBytes(500_000, base.Add(10*time.Millisecond))
	if got := controller.bitrate(); got != 20_000_000 {
		t.Fatalf("observed 266ms mid-tier backlog should raise to 20Mbps, got %d", got)
	}
	controller.observePendingBytes(50_000, base.Add(100*time.Millisecond))
	if got := controller.bitrate(); got != 20_000_000 {
		t.Fatalf("rate must not decay before the low-backlog hold, got %d", got)
	}
	controller.observePendingBytes(50_000, base.Add(399*time.Millisecond))
	if got := controller.bitrate(); got != 20_000_000 {
		t.Fatalf("rate must require a full sustained-low hold, got %d", got)
	}
	controller.observePendingBytes(50_000, base.Add(401*time.Millisecond))
	if got := controller.bitrate(); got != 10_000_000 {
		t.Fatalf("rate should return directly to the proven baseline, got %d", got)
	}
}

func TestAdaptiveQueueAbsorbsObservedMotionBurstWithoutDroppingReferenceChain(t *testing.T) {
	controller := newAdaptivePacingController(10_000_000, adaptivePacingOptions{
		enabled:       true,
		midBitrate:    15_000_000,
		maxBitrate:    20_000_000,
		upThreshold:   160 * time.Millisecond,
		maxThreshold:  260 * time.Millisecond,
		downThreshold: 80 * time.Millisecond,
		holdDuration:  300 * time.Millisecond,
	}, nil)
	queue := newRealtimeFrameQueue(400*time.Millisecond, 500_000, controller)

	first := queue.push(queuedFrame{data: make([]byte, 216_842), keyframe: true})
	if first.dropped != 0 || first.resyncRequired || first.maxQueuedBytes != 750_000 {
		t.Fatalf("observed keyframe should raise the queue to the 15Mbps budget: %#v", first)
	}
	_, _ = queue.pop()
	for index, bytes := range []int{155_130, 83_328, 45_188} {
		result := queue.push(queuedFrame{data: make([]byte, bytes)})
		if result.dropped != 0 || result.resyncRequired {
			t.Fatalf("observed motion frame %d should remain in the same decodable GOP: %#v", index, result)
		}
	}
	if got := controller.bitrate(); got != 20_000_000 {
		t.Fatalf("combined observed burst should use the maximum temporary tier, got %d", got)
	}
	result := queue.resultLocked(0, false, false, "accepted", time.Now())
	if result.maxQueuedBytes != 1_000_000 {
		t.Fatalf("400ms queue budget must scale with 20Mbps to 1MB, got %d", result.maxQueuedBytes)
	}
}

func TestReceiverFeedbackSmoothsPacketsWithoutReducingDrainRate(t *testing.T) {
	var transitions []adaptivePacingTransition
	controller := newAdaptivePacingController(10_000_000, adaptivePacingOptions{
		receiverDriven:          true,
		receiverPacketsPerBurst: 2,
		stableHoldDuration:      15 * time.Second,
	}, func(transition adaptivePacingTransition) {
		transitions = append(transitions, transition)
	})
	base := time.Date(2026, time.August, 28, 0, 0, 0, 0, time.UTC)
	controller.observePendingBytes(900_000, base)
	if got := controller.bitrate(); got != 10_000_000 {
		t.Fatalf("source backlog must never raise receiver-driven pacing, got %d", got)
	}
	controller.observeReceiverFeedback(playbackFeedback{
		StatsWindowMS: 1_000, PacketsLostDelta: 25, FreezeCountDelta: 1,
		PlaybackVisible: true, NegotiatedNACK: true, NegotiatedRTX: true,
	}, base)
	if got := controller.bitrate(); got != 10_000_000 {
		t.Fatalf("receiver feedback must not reduce the proven drain rate, got %d", got)
	}
	if got := controller.packetGroupSize(2); got != 1 {
		t.Fatalf("severe receiver loss must switch to one packet per group, got %d", got)
	}
	if len(transitions) != 1 || transitions[0].fromPacketsPerBurst != 2 || transitions[0].toPacketsPerBurst != 1 {
		t.Fatalf("receiver transition must report the packet group, not the bitrate: %#v", transitions)
	}
	controller.observeReceiverFeedback(playbackFeedback{
		StatsWindowMS: 1_000, PacketsLostDelta: 25, FreezeCountDelta: 1,
		PlaybackVisible: true, NegotiatedNACK: true, NegotiatedRTX: true,
	}, base.Add(500*time.Millisecond))
	if len(transitions) != 1 {
		t.Fatalf("unchanged one-packet smoothing must not emit another transition: %#v", transitions)
	}
	healthy := playbackFeedback{
		StatsWindowMS: 1_000, FramesDecodedDelta: 30, JitterMS: 12,
		JitterBufferDelayMS: 30, PlaybackVisible: true, NegotiatedNACK: true, NegotiatedRTX: true,
	}
	controller.observeReceiverFeedback(healthy, base.Add(time.Second))
	controller.observeReceiverFeedback(healthy, base.Add(16*time.Second))
	if got := controller.packetGroupSize(2); got != 2 {
		t.Fatalf("a healthy hold may restore the configured two-packet group, got %d", got)
	}
}

func TestQueueAdaptiveTransitionReportsBitratesNotPacketGroups(t *testing.T) {
	var transitions []adaptivePacingTransition
	controller := newAdaptivePacingController(10_000_000, adaptivePacingOptions{
		enabled:       true,
		midBitrate:    15_000_000,
		maxBitrate:    20_000_000,
		upThreshold:   160 * time.Millisecond,
		maxThreshold:  260 * time.Millisecond,
		downThreshold: 80 * time.Millisecond,
		holdDuration:  300 * time.Millisecond,
	}, func(transition adaptivePacingTransition) {
		transitions = append(transitions, transition)
	})
	controller.observePendingBytes(220_000, time.Now())
	if len(transitions) != 1 || transitions[0].fromBitrate != 10_000_000 || transitions[0].toBitrate != 15_000_000 {
		t.Fatalf("queue transition must report bitrate tiers, not packet groups: %#v", transitions)
	}
}

func TestReceiverFeedbackKeepsQueueBudgetFixed(t *testing.T) {
	controller := newAdaptivePacingController(10_000_000, adaptivePacingOptions{
		receiverDriven: true, receiverPacketsPerBurst: 2,
	}, nil)
	controller.observeReceiverFeedback(playbackFeedback{
		StatsWindowMS: 1_000, PacketsLostDelta: 30, PlaybackVisible: true,
		NegotiatedNACK: true, NegotiatedRTX: true,
	}, time.Now())
	if got := controller.maxQueuedBytes(400*time.Millisecond, 500_000); got != 500_000 {
		t.Fatalf("receiver smoothing must not silently resize the realtime queue, got %d", got)
	}
}

func TestReceiverSmoothingDoesNotRecreateObservedSixMbpsQueueDrop(t *testing.T) {
	controller := newAdaptivePacingController(10_000_000, adaptivePacingOptions{
		receiverDriven: true, receiverPacketsPerBurst: 2,
	}, nil)
	controller.observeReceiverFeedback(playbackFeedback{
		StatsWindowMS: 1_000, FreezeCountDelta: 1, PlaybackVisible: true,
		NegotiatedNACK: true, NegotiatedRTX: true,
	}, time.Now())
	if got := controller.bitrate(); got != 10_000_000 {
		t.Fatalf("a receiver freeze must keep the 10Mbps drain rate, got %d", got)
	}
	if got := controller.packetGroupSize(2); got != 1 {
		t.Fatalf("a receiver freeze should smooth to one packet per group, got %d", got)
	}
	queue := newRealtimeFrameQueue(400*time.Millisecond, 500_000, controller)
	if result := queue.push(queuedFrame{data: make([]byte, 10_000), keyframe: true}); result.dropped != 0 {
		t.Fatalf("the queue must first receive a decodable IDR: %#v", result)
	}
	_, _ = queue.pop()
	queue.completeInFlight()
	if result := queue.push(queuedFrame{data: make([]byte, 150_268)}); result.dropped != 0 {
		t.Fatalf("first observed motion frame should enter the fixed-rate queue: %#v", result)
	}
	_, _ = queue.pop()
	for _, bytes := range []int{167_885, 74_015} {
		if result := queue.push(queuedFrame{data: make([]byte, bytes)}); result.dropped != 0 || result.resyncRequired {
			t.Fatalf("the observed burst must stay below 400ms at 10Mbps: %#v", result)
		}
	}
}

func TestReceiverFeedbackWeakNetworkLossMatrix(t *testing.T) {
	testCases := []struct {
		name                string
		lost                float64
		received            float64
		jitterMS            float64
		wantPacketsPerGroup int
	}{
		{name: "clean", lost: 0, received: 1_000, jitterMS: 20, wantPacketsPerGroup: 2},
		{name: "one_percent_loss", lost: 10, received: 990, jitterMS: 50, wantPacketsPerGroup: 1},
		{name: "three_percent_loss", lost: 30, received: 970, jitterMS: 80, wantPacketsPerGroup: 1},
		{name: "five_percent_loss_and_jitter", lost: 50, received: 950, jitterMS: 180, wantPacketsPerGroup: 1},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			controller := newAdaptivePacingController(10_000_000, adaptivePacingOptions{
				receiverDriven: true, receiverPacketsPerBurst: 2,
			}, nil)
			controller.observeReceiverFeedback(playbackFeedback{
				StatsWindowMS: 1_000, PacketsLostDelta: testCase.lost, PacketsReceivedDelta: testCase.received,
				FramesDecodedDelta: 30, JitterMS: testCase.jitterMS, PlaybackVisible: true,
				NegotiatedNACK: true, NegotiatedRTX: true,
			}, time.Now())
			if got := controller.bitrate(); got != 10_000_000 {
				t.Fatalf("weak-network feedback must keep drain rate at 10Mbps, got %d", got)
			}
			if got := controller.packetGroupSize(2); got != testCase.wantPacketsPerGroup {
				t.Fatalf("weak-network packets per group=%d, want %d", got, testCase.wantPacketsPerGroup)
			}
		})
	}
}

func TestReadFrameAcceptsPlaybackFeedbackControl(t *testing.T) {
	payload, err := json.Marshal(playbackFeedback{StatsWindowMS: 1_000, PacketsLostDelta: 4, NegotiatedNACK: true, NegotiatedRTX: true})
	if err != nil {
		t.Fatal(err)
	}
	header := make([]byte, frameHeaderSize)
	header[0] = frameKindPlaybackFeedback
	binary.BigEndian.PutUint32(header[9:], uint32(len(payload)))
	value, err := readFrame(bytes.NewReader(append(header, payload...)))
	if err != nil {
		t.Fatal(err)
	}
	if value.kind != frameKindPlaybackFeedback || !bytes.Equal(value.data, payload) {
		t.Fatalf("unexpected control frame: %#v", value)
	}
}

func TestH264KeyframeCarriesConfigurationAndPacketizesWithOneFrameMarker(t *testing.T) {
	configuration := []byte{0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x06}
	keyframe := append([]byte{0, 0, 0, 1, 0x65}, make([]byte, 3_000)...)
	accessUnit := prependH264Configuration(configuration, keyframe)
	if !bytes.HasPrefix(accessUnit, configuration) || !bytes.HasSuffix(accessUnit, keyframe) {
		t.Fatal("every source IDR must carry the latest SPS/PPS before packetization")
	}
	packetizer := rtp.NewPacketizer(1200, 102, 0, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90_000)
	packets := packetizer.Packetize(accessUnit, 3_000)
	if len(packets) < 3 {
		t.Fatalf("expected a fragmented IDR, got %d RTP packets", len(packets))
	}
	foundFUA := false
	for index, packet := range packets {
		if index > 0 && packet.SequenceNumber != packets[index-1].SequenceNumber+1 {
			t.Fatalf("RTP sequence gap at packet %d", index)
		}
		if packet.Marker != (index == len(packets)-1) {
			t.Fatalf("marker must appear only on the last packet: index=%d marker=%t", index, packet.Marker)
		}
		if len(packet.Payload) > 0 && packet.Payload[0]&0x1f == 28 {
			foundFUA = true
		}
	}
	if !foundFUA {
		t.Fatal("large IDR must exercise H264 FU-A fragmentation")
	}
}

func TestRTPTimestampMapperPreservesDroppedSourceTime(t *testing.T) {
	mapper := newRTPTimestampMapper(1000)
	now := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	first := mapper.mapPTS(1_000_000, now)
	second := mapper.mapPTS(1_025_000, now.Add(25*time.Millisecond))
	// Frames at 1.050s, 1.075s and 1.100s were dropped. The next sent frame
	// must still be 100ms after the previous sent frame on the RTP clock.
	fifth := mapper.mapPTS(1_125_000, now.Add(125*time.Millisecond))
	if first.timestamp != 1000 || second.timestamp-first.timestamp != 2250 || fifth.timestamp-second.timestamp != 9000 {
		t.Fatalf("absolute PTS mapping compressed dropped time: first=%d second=%d fifth=%d", first.timestamp, second.timestamp, fifth.timestamp)
	}
}

func TestRTPTimestampMapperPreservesLongStaticGap(t *testing.T) {
	mapper := newRTPTimestampMapper(500)
	now := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	first := mapper.mapPTS(1_000_000, now)
	next := mapper.mapPTS(3_500_000, now.Add(2500*time.Millisecond))
	if next.timestamp-first.timestamp != 225_000 {
		t.Fatalf("2.5s source gap must not be clamped: delta=%d", next.timestamp-first.timestamp)
	}
}

func TestRTPTimestampMapperRebasesHotRestartMonotonically(t *testing.T) {
	mapper := newRTPTimestampMapper(9000)
	now := time.Date(2026, time.August, 5, 0, 0, 0, 0, time.UTC)
	_ = mapper.mapPTS(5_000_000, now)
	beforeRestart := mapper.mapPTS(5_025_000, now.Add(25*time.Millisecond))
	afterRestart := mapper.mapPTS(100_000, now.Add(225*time.Millisecond))
	if !afterRestart.rebased || afterRestart.timestamp <= beforeRestart.timestamp || afterRestart.timestamp-beforeRestart.timestamp != 18_000 {
		t.Fatalf("hot restart must rebase from elapsed wall time: before=%#v after=%#v", beforeRestart, afterRestart)
	}
}
