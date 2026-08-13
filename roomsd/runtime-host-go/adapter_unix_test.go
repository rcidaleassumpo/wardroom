// SPDX-License-Identifier: Apache-2.0
//go:build darwin || linux

package main

import (
	"bytes"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestPtyChildOwnsAControllingTerminal(t *testing.T) {
	child, err := SpawnPtyChild([]string{"/bin/sh", "-c", "test -t 0 && test -t 1 && printf PTY-OK"}, []string{"PATH=/usr/bin:/bin", "TERM=xterm-256color"}, "", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer child.Master.Close()
	if child.Pgid != child.ChildPid {
		t.Fatalf("process group %d does not match session leader %d", child.Pgid, child.ChildPid)
	}
	if pgid, err := syscall.Getpgid(child.ChildPid); err != nil || pgid != child.ChildPid {
		t.Fatalf("kernel process group = %d, %v; want %d", pgid, err, child.ChildPid)
	}
	if err := child.Master.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 256)
	n, err := child.Master.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(buf[:n], []byte("PTY-OK")) {
		t.Fatalf("child output %q does not prove a controlling terminal", buf[:n])
	}
	if code := child.Wait(); code != 0 {
		t.Fatalf("child exit code = %d", code)
	}
}

func TestPtyPreservesAnsiAndColorEnvironment(t *testing.T) {
	want := []byte("\x1b[31mred\x1b[1mbold\x1b[2mdim\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07 plain")
	child, err := SpawnPtyChild([]string{"/bin/sh", "-c", `test "$TERM" = xterm-256color && test "$COLORTERM" = truecolor && printf '\033[31mred\033[1mbold\033[2mdim\033[0m\033]8;;https://example.com\007link\033]8;;\007 plain'`}, []string{"PATH=/usr/bin:/bin", "TERM=xterm-256color", "COLORTERM=truecolor"}, "", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer child.Master.Close()
	if err := child.Master.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 512)
	n, err := child.Master.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(buf[:n], want) {
		t.Fatalf("PTY changed ANSI bytes: got %q, want sequence %q", buf[:n], want)
	}
	if code := child.Wait(); code != 0 {
		t.Fatalf("child exit code = %d", code)
	}
}

func TestPeerUIDReadsSameUserUnixCredential(t *testing.T) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fds[0])
	defer syscall.Close(fds[1])
	uid, err := PeerUID(uintptr(fds[0]))
	if err != nil {
		t.Fatal(err)
	}
	if uid != uint32(os.Getuid()) {
		t.Fatalf("peer uid = %d, want %d", uid, os.Getuid())
	}
}
