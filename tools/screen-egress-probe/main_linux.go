//go:build linux

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/netip"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	nfqueue "github.com/florianl/go-nfqueue/v2"
	"golang.org/x/sys/unix"
)

type item struct {
	id      uint32
	size    int
	at      time.Time
	key     pendingKey
	tracked bool
}

// Go timer wakeups rounded the 1.2ms/2ms intervals to nearly the same 2.1ms
// on the diagnostic host. A kernel nanosleep avoids interpreting an 8Mbps
// setting as an actual 4.6Mbps intervention. No busy-spin or elevated priority.
func sleepUntil(deadline time.Time) {
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return
		}
		req := unix.NsecToTimespec(left.Nanoseconds())
		if err := unix.Nanosleep(&req, nil); err != nil && err != unix.EINTR {
			time.Sleep(left)
			return
		}
	}
}

func main() {
	dst := flag.String("destination", "", "Exact IPv4 destination; no ranges")
	port := flag.Uint("destination-port", 0, "Exact UDP destination port")
	source := flag.Uint("source-port", 0, "Exact UDP source port")
	queue := flag.Uint("queue", 0, "Private NFQUEUE number")
	rate := flag.Int64("rate", 5000000, "Intervention IP bit rate, not encoder bit rate")
	burst := flag.Int("packets-per-group", 1, "Maximum immediate RTP packets per group: 1, 2, 4 or 8")
	block := flag.Duration("block", 20*time.Second, "ABA block length, total 3 blocks")
	manual := flag.Duration("manual-duration", 0, "Opt-in continuous manual trial, 10s to 60m; zero retains ABA")
	maxAge := flag.Duration("max-age", 350*time.Millisecond, "Abort intervention above this latency")
	coalesce := flag.Bool("coalesce-pending", false, "During intervention only, coalesce byte-identical opaque UDP copies still waiting for release")
	flag.Parse()
	if !validManualDuration(*manual) {
		fmt.Fprintln(os.Stderr, "invalid manual trial duration")
		os.Exit(2)
	}
	ip, err := netip.ParseAddr(*dst)
	if err != nil || !ip.Is4() || *source == 0 || *source > 65535 || *port == 0 || *port > 65535 || *queue < 10000 || *queue > 65000 || *rate < 2000000 || *rate > 12000000 || (*burst != 1 && *burst != 2 && *burst != 4 && *burst != 8) || *block < 2*time.Second || *block > 30*time.Second || *maxAge < 50*time.Millisecond || *maxAge > 400*time.Millisecond {
		fmt.Fprintln(os.Stderr, "invalid bounded probe parameters")
		os.Exit(2)
	}
	f := flow{ip, uint16(*source), uint16(*port)}
	var logMu sync.Mutex
	emit := func(v map[string]any) {
		logMu.Lock()
		defer logMu.Unlock()
		v["utc"] = time.Now().UTC().Format(time.RFC3339Nano)
		_ = json.NewEncoder(os.Stdout).Encode(v)
	}
	copyLen := uint32(128)
	if *coalesce {
		copyLen = 65535
	}
	nf, err := nfqueue.Open(&nfqueue.Config{NfQueue: uint16(*queue), MaxPacketLen: copyLen, MaxQueueLen: 1024, Copymode: nfqueue.NfQnlCopyPacket, Flags: nfqueue.NfQaCfgFlagFailOpen, AfFamily: syscall.AF_INET, WriteTimeout: 25 * time.Millisecond})
	if err != nil {
		emit(map[string]any{"event": "open_failed", "error": err.Error()})
		os.Exit(1)
	}
	defer nf.Close()
	if err = nf.Con.SetReadBuffer(4 << 20); err != nil {
		emit(map[string]any{"event": "receive_buffer_failed"})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	jobs := make(chan item, 1024)
	var bypass atomic.Bool
	var closing atomic.Bool
	var received, accepted, bytes, maxDelay, errors atomic.Uint64
	var coalesced atomic.Uint64
	var pending pendingCopies
	var startMu sync.RWMutex
	var start time.Time
	current := func() (string, int64) {
		startMu.RLock()
		s := start
		startMu.RUnlock()
		if s.IsZero() {
			return "armed", 0
		}
		return trialPhase(time.Since(s), *block, *manual, *rate)
	}
	accept := func(id uint32) bool {
		if e := nf.SetVerdict(id, nfqueue.NfAccept); e != nil {
			errors.Add(1)
			bypass.Store(true)
			return false
		} else {
			accepted.Add(1)
			return true
		}
	}
	release := func(j item, allowCoalesce bool) {
		var copies []uint32
		if j.tracked {
			copies = pending.release(j.key, j.id)
		}
		originalAccepted := accept(j.id)
		for _, id := range copies {
			// On a gate/error/shutdown flush, pass every copy through. Only
			// suppress a copy after the original received a successful verdict.
			if originalAccepted && allowCoalesce && !bypass.Load() {
				if e := nf.SetVerdict(id, nfqueue.NfDrop); e != nil {
					errors.Add(1)
					bypass.Store(true)
				} else {
					coalesced.Add(1)
				}
			} else {
				accept(id)
			}
		}
	}
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		pacer := groupPacer{rate: *rate, limit: *burst}
		for j := range jobs {
			_, speed := current()
			now := time.Now()
			if !bypass.Load() && speed > 0 {
				next := pacer.due(now)
				if next.Sub(j.at) > *maxAge {
					bypass.Store(true)
					emit(map[string]any{"event": "latency_gate_failed", "delayMs": float64(next.Sub(j.at)) / float64(time.Millisecond)})
				} else if time.Until(next) > 0 {
					sleepUntil(next)
				}
			}
			release(j, speed > 0)
			if !bypass.Load() && speed > 0 {
				pacer.sent(time.Now(), j.size)
			} else {
				pacer = groupPacer{rate: *rate, limit: *burst}
			}
			delay := uint64(time.Since(j.at).Microseconds())
			for old := maxDelay.Load(); delay > old; old = maxDelay.Load() {
				if maxDelay.CompareAndSwap(old, delay) {
					break
				}
			}
		}
	}()
	callback := func(a nfqueue.Attribute) int {
		if a.PacketID == nil {
			return 0
		}
		received.Add(1)
		if a.Payload == nil {
			accept(*a.PacketID)
			return 0
		}
		n, ok := f.mediaSize(*a.Payload)
		if !ok {
			accept(*a.PacketID)
			return 0
		}
		bytes.Add(uint64(n))
		j := item{id: *a.PacketID, size: n, at: time.Now()}
		_, speed := current()
		if *coalesce && speed > 0 && !bypass.Load() {
			if payload, complete := f.opaquePayload(*a.Payload); complete {
				key, duplicate, tracked := pending.add(j.id, payload)
				if duplicate {
					return 0
				}
				j.key, j.tracked = key, tracked
			}
		}
		// Baseline also traverses the same reader/worker, isolating only pacing.
		select {
		case jobs <- j:
		default:
			bypass.Store(true)
			errors.Add(1)
			release(j, false)
		}
		return 0
	}
	err = nf.RegisterWithErrorFunc(ctx, callback, func(e error) int {
		if closing.Load() {
			return -1
		}
		bypass.Store(true)
		errors.Add(1)
		emit(map[string]any{"event": "netlink_error", "error": e.Error()})
		return 0
	})
	if err != nil {
		emit(map[string]any{"event": "register_failed", "error": err.Error()})
		close(jobs)
		<-workerDone
		return
	}
	emit(map[string]any{"event": "armed", "pid": os.Getpid(), "queue": *queue, "rate": *rate, "packetsPerGroup": *burst, "maxAgeMs": maxAge.Milliseconds(), "coalescePending": *coalesce})
	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGUSR1, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sig)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	duration := 3 * *block
	if *manual > 0 {
		duration = *manual
	}
	hard := time.NewTimer(duration + 30*time.Second)
	defer hard.Stop()
	finished := false
	completed := false
	for !finished {
		select {
		case s := <-sig:
			if s == syscall.SIGUSR1 {
				startMu.Lock()
				if start.IsZero() {
					start = time.Now()
					emit(map[string]any{"event": "started", "blockSeconds": block.Seconds(), "manualDurationSeconds": manual.Seconds()})
				}
				startMu.Unlock()
			} else {
				finished = true
			}
		case <-tick.C:
			p, r := current()
			emit(map[string]any{"event": "stats", "phase": p, "rate": r, "received": received.Load(), "accepted": accepted.Load(), "coalescedCopies": coalesced.Load(), "ipBytes": bytes.Load(), "pending": len(jobs), "maxDelayUs": maxDelay.Load(), "errors": errors.Load(), "bypass": bypass.Load()})
			startMu.RLock()
			s := start
			startMu.RUnlock()
			if !completed && !s.IsZero() && time.Since(s) >= duration {
				bypass.Store(true)
				completed = true
				emit(map[string]any{"event": "completed"})
			}
		case <-hard.C:
			bypass.Store(true)
			emit(map[string]any{"event": "hard_deadline"})
			finished = true
		}
	}
	// The launcher removes the exact rule before requesting termination. Allow
	// queued items to drain before unbinding; --queue-bypass handles later input.
	bypass.Store(true)
	time.Sleep(100 * time.Millisecond)
	closing.Store(true)
	_ = nf.Close() // Stops callback before closing its channel.
	close(jobs)
	<-workerDone
	emit(map[string]any{"event": "exit", "received": received.Load(), "accepted": accepted.Load(), "coalescedCopies": coalesced.Load(), "errors": errors.Load(), "maxDelayUs": maxDelay.Load()})
}
