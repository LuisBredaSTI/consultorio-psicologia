package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mkzip(t *testing.T, files map[string]string) []byte {
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for n, c := range files {
		f, _ := w.Create(n)
		f.Write([]byte(c))
	}
	w.Close()
	return b.Bytes()
}

func TestUnzipOK(t *testing.T) {
	d := t.TempDir()
	if err := unzip(mkzip(t, map[string]string{"app/server.js": "x", "scripts/install.ps1": "y"}), d); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(d, "scripts", "install.ps1")); string(b) != "y" {
		t.Fatal("conteúdo errado")
	}
}

func TestUnzipRejectsTraversal(t *testing.T) {
	d := t.TempDir()
	err := unzip(mkzip(t, map[string]string{"../evil.txt": "x"}), d)
	if err == nil || !strings.Contains(err.Error(), "inválido") {
		t.Fatalf("deveria rejeitar, got %v", err)
	}
}

func TestBackupDB(t *testing.T) {
	root := t.TempDir()
	if err := backupDB(root); err != nil { // sem banco: não faz nada
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(root, "data"), 0o755)
	os.WriteFile(filepath.Join(root, "data", "consultorio.db"), []byte("dados"), 0o644)
	if err := backupDB(root); err != nil {
		t.Fatal(err)
	}
	m, _ := filepath.Glob(filepath.Join(root, "data", "backups", "pre-instalacao-*.db"))
	if len(m) != 1 {
		t.Fatalf("esperava 1 backup, got %d", len(m))
	}
	if b, _ := os.ReadFile(m[0]); string(b) != "dados" {
		t.Fatal("backup com conteúdo diferente")
	}
}
