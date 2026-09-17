// udp-network-probe measures UDP delivery independently from the screen stack.
// It is intentionally dependency-free so it can be copied to Windows and Linux.
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

const headerSize = 16

type result struct {
	Mode       string  `json:"mode"`
	DurationMs int64   `json:"durationMs"`
	Packets    uint64  `json:"packets"`
	Bytes      uint64  `json:"bytes"`
	Lost       uint64  `json:"lost"`
	LossPct    float64 `json:"lossPct"`
	Mbps       float64 `json:"mbps"`
}

func main() {
	mode := flag.String("mode", "server", "server or client")
	addr := flag.String("addr", ":8190", "listen address or server address")
	seconds := flag.Int("seconds", 15, "test duration")
	mbps := flag.Float64("mbps", 10, "client sending rate")
	payloadBytes := flag.Int("payload-bytes", 1200, "UDP payload size including header")
	flag.Parse()

	if *mode == "server" {
		serve(*addr)
		return
	}
	if *mode != "client" || *payloadBytes < headerSize+1 || *seconds < 1 || *mbps <= 0 {
		fmt.Fprintln(os.Stderr, "usage: -mode server|client -addr host:port [-seconds 15] [-mbps 10]")
		os.Exit(2)
	}
	client(*addr, *seconds, *mbps, *payloadBytes)
}

func serve(addr string) {
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	buf := make([]byte, 65535)
	for {
		n, peer, err := conn.ReadFrom(buf)
		if err != nil || n < headerSize {
			continue
		}
		if string(buf[:4]) == "PCNP" {
			conn.WriteTo(buf[:headerSize], peer)
		}
	}
}

func client(addr string, seconds int, rateMbps float64, size int) {
	conn, err := net.Dial("udp", addr)
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	packet := make([]byte, size)
	copy(packet[:4], "PCNP")
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	interval := time.Duration(float64(time.Second) * float64(size*8) / (rateMbps * 1_000_000))
	if interval < time.Microsecond {
		interval = time.Microsecond
	}
	var sent uint64
	var received uint64
	seen := make(map[uint64]struct{})
	var mu sync.Mutex
	stop := make(chan struct{})
	go func() {
		buf := make([]byte, headerSize)
		for {
			conn.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
			n, err := conn.Read(buf)
			if err != nil {
				select {
				case <-stop:
					return
				default:
					continue
				}
			}
			if n >= headerSize && string(buf[:4]) == "PCNP" {
				mu.Lock()
				seen[binary.BigEndian.Uint64(buf[8:16])] = struct{}{}
				mu.Unlock()
			}
		}
	}()
	started := time.Now()
	next := started
	for time.Now().Before(deadline) {
		binary.BigEndian.PutUint64(packet[8:16], sent)
		if _, err := conn.Write(packet); err == nil {
			sent++
		}
		next = next.Add(interval)
		if wait := time.Until(next); wait > 0 {
			time.Sleep(wait)
		}
	}
	time.Sleep(time.Second)
	close(stop)
	mu.Lock()
	received = uint64(len(seen))
	mu.Unlock()
	elapsed := time.Since(started)
	r := result{Mode: "client", DurationMs: elapsed.Milliseconds(), Packets: sent, Bytes: sent * uint64(size), Lost: sent - received}
	if sent > 0 {
		r.LossPct = float64(r.Lost) * 100 / float64(sent)
	}
	r.Mbps = float64(r.Bytes*8) / elapsed.Seconds() / 1_000_000
	json.NewEncoder(os.Stdout).Encode(r)
}
