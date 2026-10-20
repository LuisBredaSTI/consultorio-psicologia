//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var msgBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

const (
	mbOK, mbYesNo               = 0x0, 0x4
	mbIconError, mbIconQuestion = 0x10, 0x20
	mbIconInfo                  = 0x40
	idYes                       = 6
	createNoWindow              = 0x08000000
)

func box(text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	r, _, _ := msgBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
	return int(r)
}

func askYesNo(text string) bool { return box(text, mbYesNo|mbIconQuestion) == idYes }
func showInfo(text string)      { box(text, mbOK|mbIconInfo) }
func showError(text string)     { box(text, mbOK|mbIconError) }

func powershell() string {
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

func runInstallScript(script string) (string, error) {
	out, err := hidden(exec.Command(powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script)).CombinedOutput()
	return string(out), err
}

func startApp(launcher string) error {
	return hidden(exec.Command(powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", launcher)).Start()
}
