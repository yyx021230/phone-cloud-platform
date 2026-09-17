package main

import (
	"encoding/binary"
	"net/netip"
	"testing"
	"time"
)

func packet() []byte {
	p := make([]byte, 40)
	p[0] = 0x45
	p[9] = 17
	p[16] = 192
	p[17] = 0
	p[18] = 2
	p[19] = 1
	binary.BigEndian.PutUint16(p[2:], 1228)
	binary.BigEndian.PutUint16(p[20:], 8189)
	binary.BigEndian.PutUint16(p[22:], 50000)
	binary.BigEndian.PutUint16(p[24:], 1208)
	p[28] = 0x80
	p[29] = 108
	return p
}
func TestExactFlowAndProtocol(t *testing.T) {
	f := flow{netip.MustParseAddr("192.0.2.1"), 8189, 50000}
	if n, ok := f.mediaSize(packet()); !ok || n != 1228 {
		t.Fatal(n, ok)
	}
	for _, test := range []struct {
		name   string
		offset int
		value  byte
	}{{"destination", 19, 2}, {"source-port", 20, 1}, {"destination-port", 22, 1}, {"TCP", 9, 6}, {"STUN", 28, 0}, {"DTLS", 28, 22}, {"RTCP", 29, 200}, {"fragment", 6, 0x20}, {"bad-length", 24, 0}} {
		t.Run(test.name, func(t *testing.T) {
			p := packet()
			p[test.offset] = test.value
			if _, ok := f.mediaSize(p); ok {
				t.Fatal("unexpected matching packet")
			}
		})
	}
	for i := 0; i < 40; i++ {
		if _, ok := f.mediaSize(packet()[:i]); ok {
			t.Fatalf("short %d", i)
		}
	}
	p := packet()
	p[29] = 108 | 128
	if _, ok := f.mediaSize(p); !ok {
		t.Fatal("marker must be allowed")
	}
}
func TestSpacingAndIdleNoCredit(t *testing.T) {
	if spacing(1200, 10000000) != 960*time.Microsecond {
		t.Fatal("10Mbps pacing")
	}
	if spacing(1200, 5000000) != 1920*time.Microsecond {
		t.Fatal("5Mbps pacing")
	}
	if spacing(1200, 0) != 0 {
		t.Fatal("baseline")
	}
	// 156 equal packets need 155 intervals, not a catch-up burst after idle.
	if spacing(1200, 5000000)*155 != 297600*time.Microsecond {
		t.Fatal("frame schedule")
	}
}
func TestABAPhases(t *testing.T) {
	for _, x := range []struct {
		s    int
		want string
		rate int64
	}{{0, "baseline-a", 0}, {19, "baseline-a", 0}, {20, "paced-b", 5000000}, {39, "paced-b", 5000000}, {40, "baseline-a2", 0}, {59, "baseline-a2", 0}} {
		n, r := phase(time.Duration(x.s)*time.Second, 20*time.Second, 5000000)
		if n != x.want || r != x.rate {
			t.Fatal(x, n, r)
		}
	}
}

func TestGroupBudgetAndIdle(t *testing.T) {
	for _, burst := range []int{1, 2, 4, 8} {
		for _, rate := range []int64{5000000, 8000000, 10000000} {
			p := groupPacer{rate: rate, limit: burst}
			t0 := time.Unix(100, 0)
			for i := 0; i < burst; i++ {
				if p.due(t0) != t0 {
					t.Fatal("packet held within group", burst, rate, i)
				}
				p.sent(t0, 1200)
			}
			want := t0.Add(spacing(1200*burst, rate))
			if got := p.due(t0); got != want {
				t.Fatal("group budget", burst, rate, got, want)
			}
			p.sent(want, 600)
			if p.count != 1 || p.bytes != 600 || p.started != want {
				t.Fatal("group not reset")
			}
			idle := t0.Add(time.Second)
			if p.due(idle) != idle {
				t.Fatal("idle delayed")
			}
			for i := 0; i < burst; i++ {
				p.sent(idle, 1200)
			}
			if p.due(idle) != idle.Add(spacing(1200*burst, rate)) {
				t.Fatal("idle accumulated credit")
			}
		}
	}
}

func TestPartialAndMixedGroup(t *testing.T) {
	p := groupPacer{rate: 8000000, limit: 4}
	t0 := time.Unix(100, 0)
	p.sent(t0, 600)
	if p.due(t0.Add(100*time.Microsecond)) != t0.Add(100*time.Microsecond) {
		t.Fatal("partial group held")
	}
	p.sent(t0.Add(100*time.Microsecond), 1200)
	p.sent(t0.Add(200*time.Microsecond), 800)
	p.sent(t0.Add(300*time.Microsecond), 100)
	if p.due(t0.Add(300*time.Microsecond)) != t0.Add(2700*time.Microsecond) {
		t.Fatal("mixed byte budget")
	}
	later := t0.Add(time.Second)
	p.sent(later, 600)
	if p.count != 1 || p.bytes != 600 {
		t.Fatal("partial stale group")
	}
}
