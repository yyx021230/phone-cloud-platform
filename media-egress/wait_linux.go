//go:build linux

package egress

import (
	"golang.org/x/sys/unix"
	"time"
)

// Kernel sleeps avoid the millisecond Go-timer rounding observed in the cloud
// canary. No busy spinning or real-time priority. Shutdown is checked at most
// every 2ms; no thread is held while a viewer is idle.
func waitUntil(deadline time.Time, done <-chan struct{}) bool {
	for {
		select {
		case <-done:
			return false
		default:
		}
		left := time.Until(deadline)
		if left <= 0 {
			return true
		}
		if left > 2*time.Millisecond {
			left = 2 * time.Millisecond
		}
		req := unix.NsecToTimespec(left.Nanoseconds())
		if err := unix.Nanosleep(&req, nil); err != nil && err != unix.EINTR {
			time.Sleep(left)
		}
	}
}
