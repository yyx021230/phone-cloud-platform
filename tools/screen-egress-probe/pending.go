package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"sync"
)

// Diagnostic opt-in only. Compare the entire opaque UDP payload, not just an
// RTP sequence number. A changed payload, RTX packet or truncated copy cannot
// be coalesced. Nothing is decrypted, logged or persisted.
type pendingKey [32]byte
type pendingEntry struct {
	owner   uint32
	payload []byte
	copies  []uint32
}
type pendingCopies struct {
	mu      sync.Mutex
	entries map[pendingKey]*pendingEntry
}

func (f flow) opaquePayload(p []byte) ([]byte, bool) {
	n, ok := f.mediaSize(p)
	if !ok || len(p) < n {
		return nil, false
	}
	ihl := int(p[0]&15) * 4
	end := ihl + int(binary.BigEndian.Uint16(p[ihl+4:]))
	return p[ihl+8 : end], true
}

// add returns duplicate=true only while an identical original is waiting.
// The duplicate stays in NFQUEUE until the original verdict succeeds; it is
// not discarded on receipt. Repeats arriving after release remain eligible.
func (p *pendingCopies) add(id uint32, payload []byte) (key pendingKey, duplicate bool, tracked bool) {
	key = sha256.Sum256(payload)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.entries == nil {
		p.entries = make(map[pendingKey]*pendingEntry)
	}
	if entry, ok := p.entries[key]; ok {
		if !bytes.Equal(entry.payload, payload) {
			return key, false, false
		}
		entry.copies = append(entry.copies, id)
		return key, true, true
	}
	p.entries[key] = &pendingEntry{owner: id, payload: append([]byte(nil), payload...)}
	return key, false, true
}

func (p *pendingCopies) release(key pendingKey, owner uint32) []uint32 {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.entries[key]
	if !ok || entry.owner != owner {
		return nil
	}
	delete(p.entries, key)
	return entry.copies
}
