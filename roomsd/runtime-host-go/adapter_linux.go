// SPDX-License-Identifier: Apache-2.0
//go:build linux

// Linux platform adapter for the production Rooms runtime host.
//
// Linux exposes the same PTY, controlling-terminal, process-group, Unix
// credential, and descriptor-passing capabilities as Darwin, but with Linux
// ioctl and SO_PEERCRED spellings. Keep those details here so the protocol and
// lifecycle code remain platform-neutral.

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

const (
	tiocgptn   = 0x80045430
	tiocsptlck = 0x40045431
)

type PtyChild struct {
	Master   *os.File
	ChildPid int
	Pgid     int
	cmd      *exec.Cmd
}

func ioctl(fd uintptr, req uintptr, arg uintptr) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); errno != 0 {
		return errno
	}
	return nil
}

func openPty() (*os.File, string, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, "", err
	}
	unlock := int32(0)
	if err := ioctl(master.Fd(), tiocsptlck, uintptr(unsafe.Pointer(&unlock))); err != nil {
		master.Close()
		return nil, "", fmt.Errorf("TIOCSPTLCK: %w", err)
	}
	var number uint32
	if err := ioctl(master.Fd(), tiocgptn, uintptr(unsafe.Pointer(&number))); err != nil {
		master.Close()
		return nil, "", fmt.Errorf("TIOCGPTN: %w", err)
	}
	return master, fmt.Sprintf("/dev/pts/%d", number), nil
}

func SpawnPtyChild(argv []string, env []string, cwd string, cols, rows uint16) (*PtyChild, error) {
	master, slaveName, err := openPty()
	if err != nil {
		return nil, err
	}
	slave, err := os.OpenFile(slaveName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		return nil, err
	}
	defer slave.Close()
	if err := SetWinsize(master, cols, rows); err != nil {
		master.Close()
		return nil, err
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = env
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		master.Close()
		return nil, err
	}
	return &PtyChild{Master: master, ChildPid: cmd.Process.Pid, Pgid: cmd.Process.Pid, cmd: cmd}, nil
}

func SetWinsize(master *os.File, cols, rows uint16) error {
	ws := struct{ Row, Col, X, Y uint16 }{rows, cols, 0, 0}
	return ioctl(master.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

func SignalProcessGroup(pgid int, sig syscall.Signal) error {
	err := syscall.Kill(-pgid, sig)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

func TerminateProcessGroup(pgid int, grace time.Duration) error {
	if err := SignalProcessGroup(pgid, syscall.SIGTERM); err != nil {
		return err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if syscall.Kill(-pgid, 0) != nil {
			return nil
		}
		time.Sleep(25 * time.Millisecond)
	}
	return SignalProcessGroup(pgid, syscall.SIGKILL)
}

func PeerUID(fd uintptr) (uint32, error) {
	cred, err := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	if err != nil {
		return 0, err
	}
	return cred.Uid, nil
}

func RecvFd(fd int, buf []byte) (int, int, error) {
	oob := make([]byte, syscall.CmsgSpace(4))
	n, oobn, _, _, err := syscall.Recvmsg(fd, buf, oob, 0)
	if err != nil {
		return 0, -1, err
	}
	if oobn == 0 {
		return n, -1, nil
	}
	msgs, err := syscall.ParseSocketControlMessage(oob[:oobn])
	if err != nil {
		return n, -1, err
	}
	for _, message := range msgs {
		if message.Header.Level == syscall.SOL_SOCKET && message.Header.Type == syscall.SCM_RIGHTS {
			fds, err := syscall.ParseUnixRights(&message)
			if err == nil && len(fds) > 0 {
				return n, fds[0], nil
			}
		}
	}
	return n, -1, nil
}

func (p *PtyChild) Wait() int {
	err := p.cmd.Wait()
	if err == nil {
		return 0
	}
	if exit, ok := err.(*exec.ExitError); ok {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Exited() {
			return status.ExitStatus()
		}
	}
	return -1
}
