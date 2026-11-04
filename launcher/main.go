// Consultorio.exe: abre o Consultório de Psicologia.
// É o alvo do atalho da Área de Trabalho. Executa scripts\launcher.ps1 (na pasta ao lado)
// sem janela, assim o atalho não precisa chamar o PowerShell diretamente.
package main

import (
	"os"
	"path/filepath"
)

func main() {
	exe, err := os.Executable()
	if err != nil {
		showError("Não foi possível localizar o programa:\n\n" + err.Error())
		return
	}
	script := filepath.Join(filepath.Dir(exe), "scripts", "launcher.ps1")
	if _, err := os.Stat(script); err != nil {
		showError("Arquivo não encontrado:\n\n" + script + "\n\nReinstale o Consultório de Psicologia.")
		return
	}
	if err := startLauncher(script); err != nil {
		showError("Não foi possível abrir o programa:\n\n" + err.Error())
	}
}
