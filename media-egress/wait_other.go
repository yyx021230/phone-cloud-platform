//go:build !linux

package egress

import "time"

func waitUntil(deadline time.Time, done <-chan struct{}) bool {
	left := time.Until(deadline)
	if left <= 0 {
		select {
		case <-done:
			return false
		default:
			return true
		}
	}
	t := time.NewTimer(left)
	defer t.Stop()
	select {
	case <-done:
		return false
	case <-t.C:
		return true
	}
}
