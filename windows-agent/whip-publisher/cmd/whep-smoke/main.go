package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type result struct {
	Connected       bool    `json:"connected"`
	ConnectionState string  `json:"connectionState"`
	FirstPacketMs   int64   `json:"firstPacketMs"`
	Packets         uint64  `json:"packets"`
	Frames          uint64  `json:"frames"`
	Bytes           uint64  `json:"bytes"`
	BitrateMbps     float64 `json:"bitrateMbps"`
	Fps             float64 `json:"fps"`
	FpsMin          float64 `json:"fpsMin"`
	FpsP50          float64 `json:"fpsP50"`
	FpsP95          float64 `json:"fpsP95"`
	Keyframes       uint64  `json:"keyframes"`
	SPS             uint64  `json:"sps"`
	PPS             uint64  `json:"pps"`
	DurationMs      int64   `json:"durationMs"`
	Error           string  `json:"error,omitempty"`
}

func main() {
	whepURL := flag.String("url", "", "WHEP endpoint")
	token := flag.String("token", "", "media bearer token")
	duration := flag.Duration("duration", 20*time.Second, "measurement duration")
	flag.Parse()
	if *whepURL == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "url and token are required")
		os.Exit(2)
	}

	started := time.Now()
	var packets, frames, payloadBytes, keyframes, sps, pps atomic.Uint64
	var firstPacketMs atomic.Int64
	var connectionState atomic.Value
	connectionState.Store("new")
	connected := make(chan struct{}, 1)

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		finish(result{Error: err.Error()}, started, *duration)
	}
	defer pc.Close()

	_, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	})
	if err != nil {
		finish(result{Error: err.Error()}, started, *duration)
	}

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		connectionState.Store(state.String())
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			_ = pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
			for {
				packet, _, readErr := track.ReadRTP()
				if readErr != nil {
					return
				}
				if packets.Add(1) == 1 {
					firstPacketMs.Store(time.Since(started).Milliseconds())
				}
				payloadBytes.Add(uint64(len(packet.Payload)))
				if packet.Marker {
					frames.Add(1)
				}
				inspectH264(packet, &keyframes, &sps, &pps)
			}
		}()
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		finish(result{Error: err.Error()}, started, *duration)
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		finish(result{Error: err.Error()}, started, *duration)
	}
	select {
	case <-gatherComplete:
	case <-time.After(5 * time.Second):
	}

	resourceURL, answer, err := postOffer(*whepURL, *token, pc.LocalDescription().SDP)
	if err != nil {
		finish(result{Error: err.Error()}, started, *duration)
	}
	defer deleteSession(resourceURL, *token)
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		finish(result{Error: err.Error()}, started, *duration)
	}

	select {
	case <-connected:
	case <-time.After(15 * time.Second):
		finish(result{ConnectionState: connectionState.Load().(string), Error: "peer connection timeout"}, started, *duration)
	}

	fpsSamples := measureFrames(&frames, *duration)
	elapsed := time.Since(started)
	byteCount := payloadBytes.Load()
	mediaDuration := elapsed - time.Duration(firstPacketMs.Load())*time.Millisecond
	if mediaDuration <= 0 {
		mediaDuration = elapsed
	}
	deleteSession(resourceURL, *token)
	finish(result{
		Connected:       connectionState.Load().(string) == "connected",
		ConnectionState: connectionState.Load().(string),
		FirstPacketMs:   firstPacketMs.Load(),
		Packets:         packets.Load(),
		Frames:          frames.Load(),
		Bytes:           byteCount,
		BitrateMbps:     float64(byteCount*8) / mediaDuration.Seconds() / 1_000_000,
		Fps:             float64(frames.Load()) / mediaDuration.Seconds(),
		FpsMin:          percentile(fpsSamples, 0),
		FpsP50:          percentile(fpsSamples, 0.50),
		FpsP95:          percentile(fpsSamples, 0.95),
		Keyframes:       keyframes.Load(),
		SPS:             sps.Load(),
		PPS:             pps.Load(),
		DurationMs:      elapsed.Milliseconds(),
	}, started, *duration)
}

func measureFrames(frames *atomic.Uint64, duration time.Duration) []float64 {
	deadline := time.Now().Add(duration)
	samples := make([]float64, 0, int(duration/time.Second)+1)
	for time.Now().Before(deadline) {
		started := time.Now()
		before := frames.Load()
		remaining := time.Until(deadline)
		wait := time.Second
		if remaining < wait {
			wait = remaining
		}
		if wait <= 0 {
			break
		}
		time.Sleep(wait)
		seconds := time.Since(started).Seconds()
		if seconds > 0 {
			samples = append(samples, float64(frames.Load()-before)/seconds)
		}
	}
	return samples
}

func percentile(values []float64, quantile float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	index := int(float64(len(sorted)-1) * quantile)
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return sorted[index]
}

func postOffer(endpoint, token, sdp string) (string, string, error) {
	deadline := time.Now().Add(15 * time.Second)
	for {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewBufferString(sdp))
		if err != nil {
			return "", "", err
		}
		req.Header.Set("Content-Type", "application/sdp")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", "", err
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		resp.Body.Close()
		if readErr != nil {
			return "", "", readErr
		}
		if resp.StatusCode == http.StatusNotFound && time.Now().Before(deadline) {
			time.Sleep(250 * time.Millisecond)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", "", fmt.Errorf("WHEP returned %d: %s", resp.StatusCode, string(body))
		}
		resourceURL := endpoint
		if location := resp.Header.Get("Location"); location != "" {
			base, _ := url.Parse(endpoint)
			relative, _ := url.Parse(location)
			resourceURL = base.ResolveReference(relative).String()
		}
		return resourceURL, string(body), nil
	}
}

func deleteSession(resourceURL, token string) {
	req, err := http.NewRequest(http.MethodDelete, resourceURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

func inspectH264(packet *rtp.Packet, keyframes, sps, pps *atomic.Uint64) {
	payload := packet.Payload
	if len(payload) == 0 {
		return
	}
	nalType := payload[0] & 0x1f
	switch nalType {
	case 5:
		keyframes.Add(1)
	case 7:
		sps.Add(1)
	case 8:
		pps.Add(1)
	case 24:
		for offset := 1; offset+2 <= len(payload); {
			size := int(payload[offset])<<8 | int(payload[offset+1])
			offset += 2
			if size <= 0 || offset+size > len(payload) {
				break
			}
			inspectNAL(payload[offset], keyframes, sps, pps)
			offset += size
		}
	case 28:
		if len(payload) > 1 && payload[1]&0x80 != 0 {
			inspectNAL(payload[1]&0x1f, keyframes, sps, pps)
		}
	}
}

func inspectNAL(nal byte, keyframes, sps, pps *atomic.Uint64) {
	switch nal & 0x1f {
	case 5:
		keyframes.Add(1)
	case 7:
		sps.Add(1)
	case 8:
		pps.Add(1)
	}
}

func finish(value result, started time.Time, expected time.Duration) {
	if value.DurationMs == 0 {
		value.DurationMs = time.Since(started).Milliseconds()
	}
	encoded, _ := json.Marshal(value)
	fmt.Println(string(encoded))
	if value.Error != "" || (expected > 0 && value.Packets == 0 && value.DurationMs >= expected.Milliseconds()) {
		os.Exit(1)
	}
	os.Exit(0)
}
