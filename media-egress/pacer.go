// Package egress implements a per-viewer RTP pacing interceptor. Register it
// FIRST, before the NACK responder, so retransmissions use the same budget.
package egress

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

type Config struct {
	BitsPerSecond   int64
	PacketsPerGroup int
	MaxWait         time.Duration
}

func (c Config) Validate() error {
	if c.BitsPerSecond < 2_000_000 || c.BitsPerSecond > 12_000_000 ||
		(c.PacketsPerGroup != 1 && c.PacketsPerGroup != 2) ||
		c.MaxWait < 50*time.Millisecond || c.MaxWait > 350*time.Millisecond {
		return errors.New("invalid viewer egress pacing limits")
	}
	return nil
}

// Stats contains no media, network addresses or credentials. Bypass means the
// bound was exceeded: never report this viewer as continuously paced afterward.
type Stats struct {
	Packets     uint64 `json:"packets"`
	BudgetBytes uint64 `json:"budgetBytes"`
	WriteErrors uint64 `json:"writeErrors"`
	MaxWaitUs   uint64 `json:"maxWaitUs"`
	Waiting     int64  `json:"waiting"`
	Bypass      bool   `json:"bypass"`
}

type Factory struct {
	Config   Config
	OnCreate func(*Pacer)
}

func (f *Factory) NewInterceptor(_ string) (interceptor.Interceptor, error) {
	p, err := New(f.Config)
	if err == nil && f.OnCreate != nil {
		f.OnCreate(p)
	}
	return p, err
}

type budget struct {
	started      time.Time
	count, bytes int
}

func cost(size int, rate int64) time.Duration {
	return time.Duration((int64(size)*8*int64(time.Second) + rate - 1) / rate)
}

func (b *budget) due(now time.Time, c Config) time.Time {
	if b.count < c.PacketsPerGroup {
		return now
	}
	due := b.started.Add(cost(b.bytes, c.BitsPerSecond))
	if due.After(now) {
		return due
	}
	return now
}

func (b *budget) sent(now time.Time, size int, c Config) {
	if b.count == 0 || b.count >= c.PacketsPerGroup ||
		!now.Before(b.started.Add(cost(b.bytes, c.BitsPerSecond))) {
		b.started, b.count, b.bytes = now, 0, 0
	}
	b.count++
	b.bytes += size
}

// Pacer borrows packet buffers only until Write returns, and uses the caller's
// goroutine. It adds no asynchronous packet queue or per-packet goroutine.
// A peer has one gate shared by all its tracks and NACK retransmissions; peers
// never share gates. RTCP and the ICE/DTLS/data-channel path are untouched.
type Pacer struct {
	interceptor.NoOp
	c                                    Config
	gate                                 chan struct{}
	done                                 chan struct{}
	once                                 sync.Once
	b                                    budget // gate-owned
	packets, bytes, writeErrors, maxWait atomic.Uint64
	waiting                              atomic.Int64
	bypass                               atomic.Bool
}

func New(c Config) (*Pacer, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	p := &Pacer{c: c, gate: make(chan struct{}, 1), done: make(chan struct{})}
	p.gate <- struct{}{}
	return p, nil
}

func (p *Pacer) Stats() Stats {
	return Stats{p.packets.Load(), p.bytes.Load(), p.writeErrors.Load(),
		p.maxWait.Load(), p.waiting.Load(), p.bypass.Load()}
}

func (p *Pacer) Done() <-chan struct{} { return p.done }

func (p *Pacer) Close() error {
	p.once.Do(func() { close(p.done) })
	return nil
}

func (p *Pacer) BindLocalStream(_ *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	return interceptor.RTPWriterFunc(func(h *rtp.Header, data []byte, a interceptor.Attributes) (int, error) {
		started := time.Now()
		p.waiting.Add(1)
		defer p.waiting.Add(-1)
		select {
		case <-p.done:
			return 0, io.ErrClosedPipe
		case <-p.gate:
		}
		defer func() { p.gate <- struct{}{} }()
		select {
		case <-p.done:
			return 0, io.ErrClosedPipe
		default:
		}

		if !p.bypass.Load() {
			due := p.b.due(time.Now(), p.c)
			if due.Sub(started) > p.c.MaxWait {
				// Same conservative bound as the proven external canary: do not
				// grow latency without limit, discard H264 references or restart.
				// Latch pass-through for this peer and expose it to monitoring.
				p.bypass.Store(true)
			} else if !waitUntil(due, p.done) {
				return 0, io.ErrClosedPipe
			}
		}
		// Budget RTP plus conservative IPv6/UDP/SRTP overhead. This is not
		// encoder bitrate or guaranteed wire throughput (TURN/TCP differ).
		size := h.MarshalSize() + len(data) + 64
		n, err := writer.Write(h, data, a)
		if err != nil {
			p.writeErrors.Add(1)
			return n, err
		}
		p.b.sent(time.Now(), size, p.c)
		p.packets.Add(1)
		p.bytes.Add(uint64(size))
		wait := uint64(time.Since(started).Microseconds())
		for old := p.maxWait.Load(); wait > old; old = p.maxWait.Load() {
			if p.maxWait.CompareAndSwap(old, wait) {
				break
			}
		}
		return n, nil
	})
}
