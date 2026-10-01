package config_test

import (
	"testing"
	"time"

	"github.com/Ultra-Solo/ultra-template/services/api-go/internal/config"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestDefaults(t *testing.T) {
	t.Parallel()

	cfg, err := config.FromEnv(env(nil))
	if err != nil || cfg.Port != 8080 || cfg.ShutdownTimeout != 10*time.Second || cfg.Addr() != ":8080" {
		t.Fatalf("cfg = %+v, %v", cfg, err)
	}
}

func TestValidValuesAreRead(t *testing.T) {
	t.Parallel()

	cfg, err := config.FromEnv(env(map[string]string{"PORT": "9000", "SHUTDOWN_TIMEOUT": "3s"}))
	if err != nil || cfg.Port != 9000 || cfg.ShutdownTimeout != 3*time.Second {
		t.Fatalf("cfg = %+v, %v", cfg, err)
	}
}

func TestInvalidValuesAreRefused(t *testing.T) {
	t.Parallel()

	for _, values := range []map[string]string{
		{"PORT": "http"},
		{"PORT": "0"},
		{"PORT": "65536"},
		{"SHUTDOWN_TIMEOUT": "10"},
		{"SHUTDOWN_TIMEOUT": "-1s"},
	} {
		if cfg, err := config.FromEnv(env(values)); err == nil {
			t.Errorf("FromEnv(%v) = %+v, want an error", values, cfg)
		}
	}
}
