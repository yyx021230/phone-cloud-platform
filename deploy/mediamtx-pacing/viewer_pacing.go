package webrtc

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/bluenviron/mediamtx/internal/logger"
	"github.com/pion/interceptor"
	egress "phonecloud/media-egress"
)

// Only server-side pc/ viewers opt into this hook. Publishers, data-channel
// control, SDP codecs and existing Windows pacing remain unchanged.
func registerViewerPacing(registry *interceptor.Registry, log logger.Writer) error {
	raw := os.Getenv("PHONECLOUD_VIEWER_PACING_BPS")
	if raw == "" || raw == "0" {
		return nil
	}
	rate, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid PHONECLOUD_VIEWER_PACING_BPS")
	}
	group := 2
	if rawGroup := os.Getenv("PHONECLOUD_VIEWER_PACING_GROUP_PACKETS"); rawGroup != "" {
		group, err = strconv.Atoi(rawGroup)
		if err != nil {
			return fmt.Errorf("invalid PHONECLOUD_VIEWER_PACING_GROUP_PACKETS")
		}
	}
	c := egress.Config{BitsPerSecond: rate, PacketsPerGroup: group, MaxWait: 350 * time.Millisecond}
	if err := c.Validate(); err != nil {
		return err
	}
	registry.Add(&egress.Factory{Config: c, OnCreate: func(p *egress.Pacer) {
		log.Log(logger.Info, "viewer_pacing enabled rate_bps=%d group_packets=%d", rate, group)
		go func() {
			t := time.NewTicker(10 * time.Second)
			defer t.Stop()
			reportedBypass := false
			emit := func() {
				s := p.Stats()
				log.Log(logger.Info, "viewer_pacing packets=%d budget_bytes=%d wait_max_us=%d waiting=%d write_errors=%d bypass=%t", s.Packets, s.BudgetBytes, s.MaxWaitUs, s.Waiting, s.WriteErrors, s.Bypass)
				if s.Bypass && !reportedBypass {
					reportedBypass = true
					log.Log(logger.Warn, "viewer_pacing bounded-wait exceeded; this viewer is pass-through, not a pacing success")
				}
			}
			for {
				select {
				case <-t.C:
					emit()
				case <-p.Done():
					emit()
					return
				}
			}
		}()
	}})
	return nil
}
