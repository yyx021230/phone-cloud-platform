package main

import (
	"encoding/binary"
	"net/netip"
	"sync"
	"testing"
)

func TestOpaquePayloadRequiresWholePacket(t *testing.T) {
	f := flow{netip.MustParseAddr("192.0.2.1"), 8189, 50000}
	if _, ok := f.opaquePayload(packet()); ok {
		t.Fatal("truncated data coalesced")
	}
	p := make([]byte, 1228)
	copy(p, packet())
	p[len(p)-1] = 99
	b, ok := f.opaquePayload(p)
	if !ok || len(b) != 1200 || b[len(b)-1] != 99 {
		t.Fatal("incorrect opaque bytes")
	}
	p[29] = 200
	if _, ok := f.opaquePayload(p); ok {
		t.Fatal("RTCP coalesced")
	}
}
func TestPendingCopiesExactAndOnlyBeforeRelease(t *testing.T) {
	var p pendingCopies
	key, dup, tracked := p.add(1, []byte{1, 2, 3})
	if dup || !tracked {
		t.Fatal("original")
	}
	_, dup, _ = p.add(2, []byte{1, 2, 3})
	if !dup {
		t.Fatal("identical waiting copy")
	}
	other, dup, _ := p.add(3, []byte{1, 2, 4})
	if dup {
		t.Fatal("different content merged")
	}
	if len(p.release(key, 99)) != 0 {
		t.Fatal("wrong owner released data")
	}
	copies := p.release(key, 1)
	if len(copies) != 1 || copies[0] != 2 {
		t.Fatal(copies)
	}
	_, dup, _ = p.add(4, []byte{1, 2, 3})
	if dup {
		t.Fatal("post-release retransmission suppressed")
	}
	p.release(key, 4)
	p.release(other, 3)
}
func TestPendingOwnsMemory(t *testing.T) {
	var p pendingCopies
	b := []byte{1, 2, 3}
	key, _, _ := p.add(1, b)
	b[0] = 4
	_, dup, _ := p.add(2, []byte{1, 2, 3})
	if !dup {
		t.Fatal("callback buffer reused")
	}
	p.release(key, 1)
}
func TestPendingConcurrent(t *testing.T) {
	var p pendingCopies
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b := make([]byte, 12)
			binary.BigEndian.PutUint32(b, uint32(i))
			key, _, _ := p.add(uint32(i), b)
			_, dup, _ := p.add(uint32(100+i), b)
			if !dup {
				t.Error("copy not found")
			}
			if len(p.release(key, uint32(i))) != 1 {
				t.Error("copy not released")
			}
		}(i)
	}
	wg.Wait()
	if len(p.entries) != 0 {
		t.Fatal("pending cache leaked")
	}
}
