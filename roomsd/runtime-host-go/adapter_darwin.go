// macOS platform adapter for the production Rooms runtime host.
//
// Every OS-specific call lives here. Generic host code must not contain
// setsid, TIOCSCTTY, or pgid calls: a child that never acquires a
// controlling terminal still passes a naive byte test while silently
// losing job control and signal delivery, which would make the candidate
// hosts non-equivalent in a way the wire protocol cannot observe.
//
// No cgo and no third-party modules: the PTY is opened through /dev/ptmx
// with the darwin TIOCPTY* ioctls, so this host has zero dependencies.

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
	tiocPtyGrant = 0x20007454
	tiocPtyUnlk  = 0x20007452
	tiocPtyGname = 0x40807453

	solLocal      = 0
	localPeercred = 1
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

// openPty returns the master file and the slave device path.
func openPty() (*os.File, string, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, "", err
	}
	fd := master.Fd()
	if err := ioctl(fd, tiocPtyGrant, 0); err != nil {
		master.Close()
		return nil, "", fmt.Errorf("TIOCPTYGRANT: %w", err)
	}
	if err := ioctl(fd, tiocPtyUnlk, 0); err != nil {
		master.Close()
		return nil, "", fmt.Errorf("TIOCPTYUNLK: %w", err)
	}
	var name [128]byte
	if err := ioctl(fd, tiocPtyGname, uintptr(unsafe.Pointer(&name[0]))); err != nil {
		master.Close()
		return nil, "", fmt.Errorf("TIOCPTYGNAME: %w", err)
	}
	n := 0
	for n < len(name) && name[n] != 0 {
		n++
	}
	return master, string(name[:n]), nil
}

// SpawnPtyChild opens a PTY and starts argv on the slave side as a session
// leader with the slave as its controlling terminal and its own process
// group. Setsid plus Setctty is the whole contract; it is not split across
// generic code.
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
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true, // new session: own process group, no inherited tty
		Setctty: true, // acquire the slave as the controlling terminal
		Ctty:    0,    // index into the child's fds: stdin, i.e. the slave
	}
	if err := cmd.Start(); err != nil {
		master.Close()
		return nil, err
	}
	// Setsid made the child a session and process-group leader, so the
	// process-group id equals its pid.
	return &PtyChild{Master: master, ChildPid: cmd.Process.Pid, Pgid: cmd.Process.Pid, cmd: cmd}, nil
}

func SetWinsize(master *os.File, cols, rows uint16) error {
	ws := struct{ Row, Col, X, Y uint16 }{rows, cols, 0, 0}
	return ioctl(master.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

// SignalProcessGroup targets the group, never a bare pid, so the shell's
// own children die with the host instead of being reparented and leaked.
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

// PeerUID reads LOCAL_PEERCRED. The contract is the capability -- prove
// the peer is the same uid -- not this syscall spelling.
func PeerUID(fd uintptr) (uint32, error) {
	type xucred struct {
		Version uint32
		UID     uint32
		Ngroups int16
		Groups  [16]uint32
	}
	var cred xucred
	size := uintptr(unsafe.Sizeof(cred))
	if _, _, errno := syscall.Syscall6(
		syscall.SYS_GETSOCKOPT, fd, solLocal, localPeercred,
		uintptr(unsafe.Pointer(&cred)), uintptr(unsafe.Pointer(&size)), 0,
	); errno != 0 {
		return 0, errno
	}
	return cred.UID, nil
}

// RecvFd receives one descriptor passed as SCM_RIGHTS ancillary data
// alongside up to len(buf) ordinary bytes.
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
	for _, m := range msgs {
		if m.Header.Level == syscall.SOL_SOCKET && m.Header.Type == syscall.SCM_RIGHTS {
			fds, err := syscall.ParseUnixRights(&m)
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
	if ee, ok := err.(*exec.ExitError); ok {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok {
			if ws.Exited() {
				return ws.ExitStatus()
			}
		}
	}
	return -1
}
