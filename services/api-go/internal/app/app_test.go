package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/app"
)

func TestServeAnswersThenStopsWhenCancelled(t *testing.T) {
	t.Parallel()

	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)

	go func() { done <- app.Serve(ctx, listener, time.Second, slog.New(slog.DiscardHandler)) }()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listener.Addr().String()+"/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	_ = res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("healthz = %d", res.StatusCode)
	}

	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve returned %v, want nil after cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not stop within 5s of cancellation")
	}
}

func TestServeReportsItsPortAndShutdownTimeout(t *testing.T) {
	t.Parallel()

	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)

	go func() {
		done <- app.Serve(ctx, listener, 1500*time.Millisecond, slog.New(slog.NewJSONHandler(&out, nil)))
	}()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listener.Addr().String()+"/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	_ = res.Body.Close()

	cancel()

	if err := <-done; err != nil {
		t.Fatal(err)
	}

	var line struct {
		Msg               string  `json:"msg"`
		Port              int     `json:"port"`
		ShutdownTimeoutMs float64 `json:"shutdownTimeoutMs"`
	}

	first, _, _ := bytes.Cut(out.Bytes(), []byte("\n"))
	if err := json.Unmarshal(first, &line); err != nil {
		t.Fatalf("first log line %q: %v", first, err)
	}

	want := listener.Addr().(*net.TCPAddr).Port
	if line.Msg != "listening" || line.Port != want || line.ShutdownTimeoutMs != 1500 {
		t.Fatalf("first log line = %s, want listening on port %d with shutdownTimeoutMs 1500", first, want)
	}
}
