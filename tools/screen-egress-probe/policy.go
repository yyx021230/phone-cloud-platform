package main

import (
	"encoding/binary"
	"net/netip"
	"time"
)

// Probe only: no payload modification, decryption, frame dropping or adaptation.
// A failed latency gate reverts to pass-through rather than sacrificing frames.
type flow struct {
	dst          netip.Addr
	sport, dport uint16
}

func (f flow) mediaSize(p []byte) (int, bool) {
	if len(p) < 40 || p[0]>>4 != 4 || p[9] != 17 {
		return 0, false
	}
	ihl := int(p[0]&15) * 4
	if ihl < 20 || len(p) < ihl+20 || binary.BigEndian.Uint16(p[6:8])&0x3fff != 0 {
		return 0, false
	}
	if netip.AddrFrom4([4]byte{p[16], p[17], p[18], p[19]}) != f.dst || binary.BigEndian.Uint16(p[ihl:]) != f.sport || binary.BigEndian.Uint16(p[ihl+2:]) != f.dport {
		return 0, false
	}
	udpLength := int(binary.BigEndian.Uint16(p[ihl+4:]))
	if udpLength < 20 || int(binary.BigEndian.Uint16(p[2:])) != ihl+udpLength {
		return 0, false
	}
	// RFC 5761: RTP v2 but not the RTCP type range. STUN/DTLS/RTCP bypass.
	if p[ihl+8]>>6 != 2 || (p[ihl+9] >= 192 && p[ihl+9] <= 223) {
		return 0, false
	}
	return ihl + udpLength, true // Budget IP+UDP overhead too, not just encoded bytes.
}

func spacing(bytes int, bitsPerSecond int64) time.Duration {
	if bitsPerSecond <= 0 {
		return 0
	}
	return time.Duration((int64(bytes)*8*int64(time.Second) + bitsPerSecond - 1) / bitsPerSecond)
}

// A group may send at most limit packets back-to-back. Its actual IP bytes
// must be paid for before the next group. Idle time never earns multiple groups.
// Partial groups are not held waiting for more packets to arrive.
type groupPacer struct {
	rate                int64
	limit, count, bytes int
	started             time.Time
}

func (p *groupPacer) due(now time.Time) time.Time {
	if p.count == 0 || p.count < p.limit {
		return now
	}
	deadline := p.started.Add(spacing(p.bytes, p.rate))
	if deadline.After(now) {
		return deadline
	}
	return now
}

func (p *groupPacer) sent(now time.Time, size int) {
	if p.count == 0 || p.count >= p.limit || !now.Before(p.started.Add(spacing(p.bytes, p.rate))) {
		p.started, p.count, p.bytes = now, 0, 0
	}
	p.count++
	p.bytes += size
}

// Baseline / intervention / baseline, measured on the same established flow.
func phase(elapsed, block time.Duration, rate int64) (string, int64) {
	if elapsed < block {
		return "baseline-a", 0
	}
	if elapsed < 2*block {
		return "paced-b", rate
	}
	return "baseline-a2", 0
}

func validManualDuration(d time.Duration) bool {
	return d == 0 || (d >= 10*time.Second && d <= time.Hour)
}

func trialPhase(elapsed, block, manual time.Duration, rate int64) (string, int64) {
	if manual == 0 {
		return phase(elapsed, block, rate)
	}
	if elapsed >= manual {
		return "manual-completed", 0
	}
	return "manual-paced", rate
}
