//go:build !windows

package main

// Versão para teste em Linux/macOS: não abre janelas nem executa PowerShell.
import (
	"fmt"
	"os"
)

func askYesNo(text string) bool {
	fmt.Println("[pergunta]", text)
	return os.Getenv("SETUP_ANSWER") != "no"
}
func showInfo(text string)  { fmt.Println("[info]", text) }
func showError(text string) { fmt.Println("[erro]", text) }

func runInstallScript(script string) (string, error) {
	fmt.Println("[powershell] install.ps1 em", script)
	if _, err := os.Stat(script); err != nil {
		return "", err
	}
	return "", nil
}

func startApp(launcher string) error { fmt.Println("[abre]", launcher); return nil }
