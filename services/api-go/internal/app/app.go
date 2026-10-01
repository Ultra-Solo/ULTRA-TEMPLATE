// Package app is the composition root: the one place that chooses concrete implementations for the
// use case ports and starts the transport. It holds wiring, not business logic.
package app

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/controller/httpapi"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/repo/memory"
	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/usecase"
)

// Timeouts for every connection. Without them a client that sends headers slowly holds a
// connection open indefinitely.
const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 15 * time.Second
	writeTimeout      = 15 * time.Second
	idleTimeout       = 60 * time.Second
)

// Serve handles HTTP on listener until ctx is cancelled, then drains in-flight requests for at most
// shutdownTimeout.
func Serve(ctx context.Context, listener net.Listener, shutdownTimeout time.Duration, log *slog.Logger) error {
	tasks := usecase.NewTasks(memory.NewTaskRepository(), time.Now, rand.Text)
	server := &http.Server{
		Handler:           httpapi.WithRequestLog(httpapi.NewRouter(tasks, log), log, time.Now, rand.Text),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}

	served := make(chan error, 1)

	go func() {
		log.Info("listening", "port", port(listener), "shutdownTimeoutMs", float64(shutdownTimeout)/float64(time.Millisecond))
		served <- server.Serve(listener)
	}()

	select {
	case err := <-served:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	if err := <-served; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}

	log.Info("stopped")

	return nil
}

// port is the TCP port listener accepts on: PORT's value in effect, which the listening line reports.
func port(listener net.Listener) int {
	if addr, ok := listener.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}

	return 0
}
