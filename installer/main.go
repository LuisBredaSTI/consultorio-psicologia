// Instalador do Consultório de Psicologia.
// Extrai o pacote embutido (app + scripts), roda scripts\install.ps1 (que copia para
// %LOCALAPPDATA%\ConsultorioPsicologia, cria o atalho e preserva a pasta data) e abre o programa.
package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed payload.zip
var payload []byte

// preenchido na compilação: -ldflags "-X main.version=28.2.1"
var version = "dev"

const title = "Consultório de Psicologia"

func main() {
	root := filepath.Join(os.Getenv("LOCALAPPDATA"), "ConsultorioPsicologia")
	if !askYesNo(fmt.Sprintf("Instalar ou atualizar o Consultório de Psicologia para a versão %s?\n\nSeus pacientes e dados são preservados: antes de instalar é feita uma cópia de segurança do banco de dados.", version)) {
		return
	}
	if err := install(root); err != nil {
		showError("Não foi possível concluir a instalação:\n\n" + err.Error())
		os.Exit(1)
	}
	showInfo("Instalação concluída.\n\nO programa vai abrir no navegador em instantes. Se for a primeira instalação neste computador, a primeira abertura pode levar um a dois minutos (é baixado o componente que executa o programa; é preciso internet).\n\nDaqui para frente use o atalho \"Consultório Psicologia\" da Área de Trabalho. As atualizações são automáticas.")
}

func install(root string) error {
	tmp, err := os.MkdirTemp("", "consultorio-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := unzip(payload, tmp); err != nil {
		return fmt.Errorf("extraindo arquivos: %w", err)
	}
	if err := backupDB(root); err != nil {
		return fmt.Errorf("cópia de segurança do banco: %w", err)
	}
	if out, err := runInstallScript(filepath.Join(tmp, "scripts", "install.ps1")); err != nil {
		return fmt.Errorf("%w\n%s", err, strings.TrimSpace(out))
	}
	return startApp(filepath.Join(root, "scripts", "launcher.ps1"))
}

// Copia data\consultorio.db para data\backups antes de mexer em qualquer arquivo.
func backupDB(root string) error {
	db := filepath.Join(root, "data", "consultorio.db")
	if _, err := os.Stat(db); err != nil {
		return nil // instalação nova: nada a copiar
	}
	dir := filepath.Join(root, "data", "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return copyFile(db, filepath.Join(dir, "pre-instalacao-"+time.Now().Format("20060102-150405")+".db"))
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func unzip(data []byte, dest string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	base := filepath.Clean(dest) + string(os.PathSeparator)
	for _, f := range zr.File {
		target := filepath.Join(dest, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(target, base) {
			return fmt.Errorf("caminho inválido no pacote: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(target)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
	}
	return nil
}
