package main

import (
	"testing"
	"time"
)

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
