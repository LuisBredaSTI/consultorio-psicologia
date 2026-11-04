//go:build !windows

package main

import "fmt"

// Versão para teste em Linux/macOS.
func startLauncher(script string) error { fmt.Println("[abre]", script); return nil }
func showError(text string)             { fmt.Println("[erro]", text) }
