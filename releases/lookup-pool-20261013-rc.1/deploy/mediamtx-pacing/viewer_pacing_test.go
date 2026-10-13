package webrtc

import (
	"bytes"
	"github.com/bluenviron/mediamtx/internal/logger"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	pwebrtc "github.com/pion/webrtc/v4"
	"testing"
	"time"
)

type pacingTestLogger struct{}

func (pacingTestLogger) Log(logger.Level, string, ...any) {}

func TestViewerPacingEnvironment(t *testing.T) {
	for _, tc := range []struct {
		rate, group string
		valid       bool
	}{
		{"", "", true}, {"0", "", true}, {"8000000", "2", true},
		{"8000000", "1", true}, {"8000000", "8", false},
		{"not-a-rate", "2", false}, {"13000000", "2", false},
	} {
		t.Run(tc.rate+"/"+tc.group, func(t *testing.T) {
			t.Setenv("PHONECLOUD_VIEWER_PACING_BPS", tc.rate)
			t.Setenv("PHONECLOUD_VIEWER_PACING_GROUP_PACKETS", tc.group)
			r := &interceptor.Registry{}
			err := registerViewerPacing(r, pacingTestLogger{})
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%t err=%v", tc.valid, err)
			}
			if err == nil {
				chain, e := r.Build("")
				if e != nil {
					t.Fatal(e)
				}
				chain.Close()
			}
		})
	}
}

// Exercise real ICE/DTLS/SRTP through the modified MediaMTX PeerConnection.
// Packet receipt is protocol evidence, not a browser rendering-quality test.
func TestViewerPacingPeerConnectionMedia(t *testing.T) {
	for _, rate := range []string{"0", "8000000"} {
		t.Run(rate, func(t *testing.T) {
			t.Setenv("PHONECLOUD_VIEWER_PACING_BPS", rate)
			t.Setenv("PHONECLOUD_VIEWER_PACING_GROUP_PACKETS", "2")
			settings := pwebrtc.SettingEngine{}
			settings.SetIncludeLoopbackCandidate(true)
			client, err := pwebrtc.NewAPI(pwebrtc.WithSettingEngine(settings)).NewPeerConnection(pwebrtc.Configuration{})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			for _, kind := range []pwebrtc.RTPCodecType{pwebrtc.RTPCodecTypeVideo, pwebrtc.RTPCodecTypeAudio} {
				if _, err = client.AddTransceiverFromKind(kind, pwebrtc.RTPTransceiverInit{Direction: pwebrtc.RTPTransceiverDirectionRecvonly}); err != nil {
					t.Fatal(err)
				}
			}
			packets := make(chan *rtp.Packet, 200)
			client.OnTrack(func(track *pwebrtc.TrackRemote, _ *pwebrtc.RTPReceiver) {
				if track.Kind() != pwebrtc.RTPCodecTypeVideo {
					return
				}
				for {
					pkt, _, e := track.ReadRTP()
					if e != nil {
						return
					}
					select {
					case packets <- pkt:
					default:
					}
				}
			})
			pc := &PeerConnection{LocalRandomUDP: true, IPsFromInterfaces: true, Publish: true, ViewerPacing: true, Log: pacingTestLogger{},
				OutgoingTracks: []*OutgoingTrack{{Caps: pwebrtc.RTPCodecCapability{MimeType: pwebrtc.MimeTypeH264, ClockRate: 90000}}}}
			if err = pc.Start(); err != nil {
				t.Fatal(err)
			}
			defer pc.Close()
			offer, err := client.CreateOffer(nil)
			if err != nil {
				t.Fatal(err)
			}
			gather := pwebrtc.GatheringCompletePromise(client)
			if err = client.SetLocalDescription(offer); err != nil {
				t.Fatal(err)
			}
			select {
			case <-gather:
			case <-time.After(5 * time.Second):
				t.Fatal("gather timeout")
			}
			answer, err := pc.CreateFullAnswer(client.LocalDescription(), false)
			if err != nil {
				t.Fatal(err)
			}
			if err = client.SetRemoteDescription(*answer); err != nil {
				t.Fatal(err)
			}
			if err = pc.WaitUntilConnected(5 * time.Second); err != nil {
				t.Fatal(err)
			}
			body := bytes.Repeat([]byte{0x65}, 1100)
			start := time.Now()
			for i := 0; i < 100; i++ {
				err = pc.OutgoingTracks[0].WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, Marker: true, SequenceNumber: uint16(1000 + i), Timestamp: uint32(i * 3000)}, Payload: body})
				if err != nil {
					t.Fatal(err)
				}
			}
			elapsed := time.Since(start)
			if rate != "0" && elapsed < 100*time.Millisecond {
				t.Fatalf("real transport bypassed pacer: %v", elapsed)
			}
			seen := make(map[uint16]bool)
			timeout := time.NewTimer(3 * time.Second)
			defer timeout.Stop()
			for len(seen) < 100 {
				select {
				case p := <-packets:
					if !bytes.Equal(p.Payload, body) {
						t.Fatal("payload changed")
					}
					seen[p.SequenceNumber] = true
				case <-timeout.C:
					t.Fatalf("received only %d", len(seen))
				}
			}
			t.Logf("rate=%s received_unique=%d send_duration_ms=%.3f", rate, len(seen), float64(elapsed)/float64(time.Millisecond))
		})
	}
}
