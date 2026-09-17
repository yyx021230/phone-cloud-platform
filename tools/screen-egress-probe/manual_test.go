package main

import (
	"testing"
	"time"
)

func TestManualModeBoundedAndDefaultUnchanged(t *testing.T) {
	for _, d := range []time.Duration{-1, time.Second, 9 * time.Second, time.Hour + 1} {
		if validManualDuration(d) {
			t.Fatalf("accepted %v", d)
		}
	}
	for _, d := range []time.Duration{0, 10 * time.Second, 30 * time.Minute, time.Hour} {
		if !validManualDuration(d) {
			t.Fatalf("rejected %v", d)
		}
	}
	for _, elapsed := range []time.Duration{0, 15 * time.Second, 29 * time.Second, time.Minute} {
		a, b := phase(elapsed, 15*time.Second, 8000000)
		c, d := trialPhase(elapsed, 15*time.Second, 0, 8000000)
		if a != c || b != d {
			t.Fatal("ABA default changed")
		}
	}
	for _, elapsed := range []time.Duration{0, 15 * time.Second, 29 * time.Minute} {
		p, r := trialPhase(elapsed, 15*time.Second, 30*time.Minute, 8000000)
		if p != "manual-paced" || r != 8000000 {
			t.Fatal("manual pacing missing")
		}
	}
	for _, elapsed := range []time.Duration{30 * time.Minute, 31 * time.Minute} {
		_, r := trialPhase(elapsed, 15*time.Second, 30*time.Minute, 8000000)
		if r != 0 {
			t.Fatal("manual trial did not expire")
		}
	}
}
