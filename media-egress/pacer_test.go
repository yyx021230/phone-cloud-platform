package egress

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
)

func config() Config { return Config{8_000_000, 2, 350 * time.Millisecond} }

func TestConfigBounds(t *testing.T) {
	for _, c := range []Config{{0, 2, time.Second}, {1_999_999, 2, time.Millisecond}, {12_000_001, 2, time.Millisecond}, {8_000_000, 8, time.Millisecond}, {8_000_000, 2, 351 * time.Millisecond}} {
		if _, err := New(c); err == nil {
			t.Fatalf("accepted %+v", c)
		}
	}
	for _, n := range []int{1, 2} {
		c := config()
		c.PacketsPerGroup = n
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGroupBudgetAndNoIdleCredit(t *testing.T) {
	c := config()
	var b budget
	now := time.Unix(1, 0)
	for i := 0; i < 2; i++ {
		if !b.due(now, c).Equal(now) {
			t.Fatal("partial group held")
		}
		b.sent(now, 1200, c)
	}
	if want := now.Add(2400 * time.Microsecond); !b.due(now, c).Equal(want) {
		t.Fatal("group not charged")
	}
	now = now.Add(time.Hour)
	b.sent(now, 1200, c)
	b.sent(now, 1200, c)
	if !b.due(now, c).After(now) {
		t.Fatal("idle earned a catch-up burst")
	}
}

func TestBytePreservationAndPacing(t *testing.T) {
	p, _ := New(config())
	defer p.Close()
	body := bytes.Repeat([]byte{0x77}, 1100)
	var times []time.Time
	w := p.BindLocalStream(&interceptor.StreamInfo{}, interceptor.RTPWriterFunc(func(h *rtp.Header, b []byte, a interceptor.Attributes) (int, error) {
		if h.SequenceNumber != uint16(len(times)) || !bytes.Equal(body, b) || a["test"] != true {
			t.Fatal("packet changed")
		}
		times = append(times, time.Now())
		return len(b), nil
	}))
	for i := 0; i < 100; i++ {
		if _, err := w.Write(&rtp.Header{Version: 2, SSRC: 1, SequenceNumber: uint16(i)}, body, interceptor.Attributes{"test": true}); err != nil {
			t.Fatal(err)
		}
	}
	span := times[99].Sub(times[0])
	if span < 110*time.Millisecond || span > time.Second {
		t.Fatalf("unexpected span %v", span)
	}
	if s := p.Stats(); s.Packets != 100 || s.Bypass || s.WriteErrors != 0 || s.Waiting != 0 {
		t.Fatalf("bad stats %+v", s)
	}
}

func TestIndependentFifteenViewers(t *testing.T) {
	var wg sync.WaitGroup
	for peer := 0; peer < 15; peer++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, _ := New(config())
			defer p.Close()
			n := 0
			w := p.BindLocalStream(&interceptor.StreamInfo{}, interceptor.RTPWriterFunc(func(_ *rtp.Header, b []byte, _ interceptor.Attributes) (int, error) { n++; return len(b), nil }))
			start := time.Now()
			for i := 0; i < 156; i++ {
				if _, err := w.Write(&rtp.Header{Version: 2}, make([]byte, 1100), nil); err != nil {
					t.Error(err)
					return
				}
			}
			if n != 156 || p.Stats().Bypass {
				t.Errorf("viewer n=%d stats=%+v", n, p.Stats())
			}
			if elapsed := time.Since(start); elapsed > 2*time.Second {
				t.Errorf("viewers serialized: %v", elapsed)
			}
		}()
	}
	wg.Wait()
}

func TestConcurrentTracksShareBudget(t *testing.T) {
	p, _ := New(config())
	defer p.Close()
	var times []time.Time
	sink := interceptor.RTPWriterFunc(func(_ *rtp.Header, b []byte, _ interceptor.Attributes) (int, error) {
		times = append(times, time.Now())
		return len(b), nil
	})
	a := p.BindLocalStream(&interceptor.StreamInfo{SSRC: 1}, sink)
	b := p.BindLocalStream(&interceptor.StreamInfo{SSRC: 2}, sink)
	var wg sync.WaitGroup
	for _, w := range []interceptor.RTPWriter{a, b} {
		wg.Add(1)
		go func(w interceptor.RTPWriter) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				_, err := w.Write(&rtp.Header{Version: 2}, make([]byte, 1100), nil)
				if err != nil {
					t.Error(err)
				}
			}
		}(w)
	}
	wg.Wait()
	if len(times) != 100 || times[99].Sub(times[0]) < 110*time.Millisecond {
		t.Fatal("tracks had separate budgets")
	}
}

func TestCloseUnblocksAndPreservesWriteErrors(t *testing.T) {
	p, _ := New(config())
	<-p.gate
	result := make(chan error, 1)
	w := p.BindLocalStream(nil, interceptor.RTPWriterFunc(func(*rtp.Header, []byte, interceptor.Attributes) (int, error) {
		t.Error("write after close")
		return 0, nil
	}))
	go func() { _, e := w.Write(&rtp.Header{}, nil, nil); result <- e }()
	p.Close()
	p.Close()
	select {
	case err := <-result:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown blocked")
	}
	p.gate <- struct{}{}
	p2, _ := New(config())
	defer p2.Close()
	sentinel := errors.New("transport failure")
	w = p2.BindLocalStream(nil, interceptor.RTPWriterFunc(func(*rtp.Header, []byte, interceptor.Attributes) (int, error) { return 0, sentinel }))
	_, err := w.Write(&rtp.Header{}, nil, nil)
	if err != sentinel || p2.Stats().WriteErrors != 1 {
		t.Fatal("write failure swallowed")
	}
}

func TestOverloadIsExplicitNoDropOrRestart(t *testing.T) {
	p, _ := New(config())
	defer p.Close()
	p.b = budget{time.Now().Add(time.Second), 2, 2400}
	n := 0
	w := p.BindLocalStream(nil, interceptor.RTPWriterFunc(func(_ *rtp.Header, b []byte, _ interceptor.Attributes) (int, error) { n++; return len(b), nil }))
	for i := 0; i < 10; i++ {
		_, err := w.Write(&rtp.Header{}, []byte{1}, nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	if n != 10 || !p.Stats().Bypass {
		t.Fatal("overload silently paced/dropped")
	}
}

func TestRTCPBypassesMediaGate(t *testing.T) {
	p, _ := New(config())
	defer p.Close()
	<-p.gate
	defer func() { p.gate <- struct{}{} }()
	w := p.BindRTCPWriter(interceptor.RTCPWriterFunc(func(packets []rtcp.Packet, _ interceptor.Attributes) (int, error) { return len(packets), nil }))
	if n, e := w.Write([]rtcp.Packet{&rtcp.PictureLossIndication{}}, nil); e != nil || n != 1 {
		t.Fatal("RTCP changed")
	}
}

// Exercise the actual production Pion NACK responder, not a mock resend path.
// Its saved writer must include this pacer; registering after NACK would fail.
func TestActualNACKRetransmissionsArePaced(t *testing.T) {
	p, _ := New(config())
	f, _ := nack.NewResponderInterceptor(nack.ResponderStreamsFilter(func(*interceptor.StreamInfo) bool { return true }))
	r, err := f.NewInterceptor("test")
	if err != nil {
		t.Fatal(err)
	}
	chain := interceptor.NewChain([]interceptor.Interceptor{p, r})
	defer chain.Close()
	var mu sync.Mutex
	var times []time.Time
	var seqs []uint16
	body := bytes.Repeat([]byte{0x55}, 1100)
	sink := interceptor.RTPWriterFunc(func(h *rtp.Header, b []byte, _ interceptor.Attributes) (int, error) {
		if !bytes.Equal(b, body) {
			t.Error("retransmission payload changed")
		}
		mu.Lock()
		times = append(times, time.Now())
		seqs = append(seqs, h.SequenceNumber)
		mu.Unlock()
		return len(b), nil
	})
	w := chain.BindLocalStream(&interceptor.StreamInfo{SSRC: 7}, sink)
	for i := 0; i < 32; i++ {
		if _, e := w.Write(&rtp.Header{Version: 2, SSRC: 7, SequenceNumber: uint16(i)}, body, nil); e != nil {
			t.Fatal(e)
		}
	}
	nacks := []rtcp.NackPair{{PacketID: 0, LostPackets: 0xffff}, {PacketID: 17, LostPackets: 0x3fff}}
	raw, _ := rtcp.Marshal([]rtcp.Packet{&rtcp.TransportLayerNack{SenderSSRC: 9, MediaSSRC: 7, Nacks: nacks}})
	reader := chain.BindRTCPReader(interceptor.RTCPReaderFunc(func(b []byte, a interceptor.Attributes) (int, interceptor.Attributes, error) {
		return copy(b, raw), a, nil
	}))
	if _, _, err = reader.Read(make([]byte, 1500), nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(times)
		mu.Unlock()
		if n == 64 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d packets", n)
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if times[63].Sub(times[32]) < 33*time.Millisecond {
		t.Fatalf("NACK bypassed pacing: %v", times[63].Sub(times[32]))
	}
	for i := 0; i < 32; i++ {
		if seqs[32+i] != uint16(i) {
			t.Fatal("NACK changed order/sequence")
		}
	}
	if p.Stats().Packets != 64 {
		t.Fatal("NACK not in common budget")
	}
}
