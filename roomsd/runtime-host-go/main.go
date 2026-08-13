// SPDX-License-Identifier: Apache-2.0
// Rooms production per-session runtime host (Go).
//
// This source is intentionally maintained in the production packaging tree;
// the benchmark candidate is not an installed/runtime dependency.
//
// One process, one PTY, blocking goroutines, zero dependencies. Implements
// PROTOCOL.md exactly; every OS call is in an adapter_<os>.go file.

package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	enrollFd    = 3
	queueCap    = 262144
	observerCap = 32
)

type client struct {
	id         uint64
	controller bool
	queue      []byte // unsent frame bytes; over queueCap the client is dropped
	inFlight   int
	conn       net.Conn
	dead       bool
	authed     bool
	actions    map[string]bool
	expiresAt  int64
	wake       chan struct{}
}

type shared struct {
	mu         sync.Mutex
	ring       *Ring
	clients    map[uint64]*client
	controller uint64
	hasCtl     bool
	secret     []byte
	enrollment enrollment
	exited     bool
	exitCode   int32
	wiped      bool
	seenHello  map[string]struct{}
	delivered  map[string]deliveryState
	terminated bool
	master     *os.File
	pgid       int
	listener   net.Listener
}
type deliveryState struct {
	InProgress   bool
	Written      bool
	Uncertain    bool
	BytesWritten int
	Generation   uint32
}
type allWriteConn struct{ net.Conn }

func (c allWriteConn) Write(p []byte) (int, error) {
	err := writeAll(c.Conn, p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

const maxSeenCredentials = 4096
const maxDeliveries = 4096

func main() {
	args := os.Args[1:]
	for _, a := range args {
		if a == "--fuzz-parse" {
			os.Exit(FuzzParse())
		}
	}
	if len(args) == 0 || args[0] != "run" {
		fmt.Fprintln(os.Stderr, "usage: go-host run --ring-bytes N [--shell /bin/sh] | go-host --fuzz-parse")
		os.Exit(2)
	}
	ringBytes := 262144
	shell := "/bin/sh"
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--ring-bytes":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "--ring-bytes requires a positive integer")
				os.Exit(2)
			}
			if _, err := fmt.Sscanf(args[i+1], "%d", &ringBytes); err != nil || ringBytes < 1 {
				fmt.Fprintln(os.Stderr, "--ring-bytes requires a positive integer")
				os.Exit(2)
			}
			i++
		case "--shell":
			if i+1 >= len(args) || args[i+1] == "" {
				fmt.Fprintln(os.Stderr, "--shell requires a path")
				os.Exit(2)
			}
			shell = args[i+1]
			i++
		default:
			fmt.Fprintf(os.Stderr, "unknown option: %s\n", args[i])
			os.Exit(2)
		}
	}
	run(ringBytes, shell)
}

func readEnrollFrame(f *os.File, buf *[]byte) (byte, []byte, error) {
	for {
		p := ParseFrame(*buf)
		switch p.Kind {
		case KindFrame:
			*buf = (*buf)[p.Consumed:]
			return p.Type, p.Payload, nil
		case KindFatal:
			return 0, nil, fmt.Errorf("bad enrollment frame")
		}
		chunk := make([]byte, 4096)
		n, err := f.Read(chunk)
		if err != nil || n == 0 {
			return 0, nil, fmt.Errorf("enrollment closed: %v", err)
		}
		*buf = append(*buf, chunk[:n]...)
	}
}

func run(ringBytes int, shell string) {
	enroll := os.NewFile(enrollFd, "enroll")
	if enroll == nil {
		fmt.Fprintln(os.Stderr, "no enrollment descriptor on fd 3")
		os.Exit(2)
	}
	var buf []byte

	ftype, payload, err := readEnrollFrame(enroll, &buf)
	if err != nil || ftype != TEnroll {
		fmt.Fprintln(os.Stderr, "enrollment failed: transport_or_type")
		os.Exit(2)
	}
	e, secret, err := parseEnrollment(payload)
	if err != nil {
		fmt.Fprintln(os.Stderr, "enrollment failed: invalid_contract")
		os.Exit(2)
	}
	if err := persistEnrollmentState(e, secret); err != nil {
		fmt.Fprintln(os.Stderr, "enrollment state unavailable")
		os.Exit(2)
	}
	if parent := filepath.Dir(e.SocketPath); os.MkdirAll(parent, 0700) != nil || os.Chmod(parent, 0700) != nil {
		fmt.Fprintln(os.Stderr, "socket state unavailable")
		os.Exit(2)
	}
	for i := range payload {
		payload[i] = 0
	}
	e.ReconnectSecret = ""
	enrolledRing := e.RingBytes
	sockPath := e.SocketPath
	if enrolledRing > 0 {
		ringBytes = enrolledRing
	}

	// Optional SCM_RIGHTS capability probe (gate G3). One nonblocking read is
	// deliberately bounded: absence of the optional probe never delays READY.
	_ = syscall.SetNonblock(enrollFd, true)
	probe := make([]byte, 512)
	if n, fd, err := RecvFd(enrollFd, probe); err == nil && n > 0 {
		p := ParseFrame(probe[:n])
		if p.Kind == KindFrame && p.Type == TFdProbe && len(p.Payload) == 0 && fd >= 0 {
			_ = writeAllFd(fd, []byte(fmt.Sprintf("FD-OK:%d", os.Getpid())))
			_ = syscall.Close(fd)
		} else if fd >= 0 {
			_ = syscall.Close(fd)
		}
	}

	providerPath := os.Getenv("PATH")
	if providerPath == "" {
		providerPath = "/usr/bin:/bin:/usr/sbin:/sbin"
	}
	userBin := os.Getenv("ROOMS_USER_BIN")
	if userBin == "" && os.Getenv("HOME") != "" {
		userBin = filepath.Join(os.Getenv("HOME"), ".local", "bin")
	}
	if userBin != "" {
		providerPath = userBin + ":" + providerPath
	}
	if systemBin := os.Getenv("ROOMS_SYSTEM_BIN"); systemBin != "" {
		providerPath = systemBin + ":" + providerPath
	}
	env := []string{
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"HOME=" + os.Getenv("HOME"),
		"USER=" + os.Getenv("USER"),
		"LOGNAME=" + os.Getenv("LOGNAME"),
		"SHELL=" + shell,
		"PATH=" + providerPath,
		"ROOMS_SESSION_ID=" + e.SessionID,
		"ROOMS_CHANNEL_ID=" + e.ChannelID,
		"CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1",
		"LANG=C",
	}
	command := e.Command
	if len(command) == 0 {
		command = []string{shell}
	}
	if resolved, err := resolveExecutable(command[0], providerPath); err == nil {
		command = append([]string{resolved}, command[1:]...)
		// Provider launchers may use /usr/bin/env to locate a sibling runtime
		// (for example, a Node-based CLI). Preserve the provider's installation
		// directory in the child PATH without assuming a machine-specific prefix.
		providerPath = providerPath + ":" + filepath.Dir(resolved)
		for i, value := range env {
			if strings.HasPrefix(value, "PATH=") {
				env[i] = "PATH=" + providerPath
				break
			}
		}
	}
	child, err := SpawnPtyChild(command, env, e.Cwd, 80, 24)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spawn pty child: %v\n", err)
		os.Exit(2)
	}

	s := &shared{
		ring:       NewRing(ringBytes),
		clients:    make(map[uint64]*client),
		seenHello:  make(map[string]struct{}),
		delivered:  make(map[string]deliveryState),
		secret:     append([]byte(nil), secret...),
		enrollment: e,
		master:     child.Master,
		pgid:       child.Pgid,
	}
	parent := filepath.Dir(sockPath)
	if err := os.MkdirAll(parent, 0o700); err != nil || os.Chmod(parent, 0o700) != nil {
		fmt.Fprintf(os.Stderr, "prepare socket directory: %v\n", err)
		_ = TerminateProcessGroup(child.Pgid, 2*time.Second)
		_ = child.Master.Close()
		return
	}
	os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bind control socket: %v\n", err)
		_ = TerminateProcessGroup(child.Pgid, 2*time.Second)
		_ = child.Master.Close()
		return
	}
	if err := os.Chmod(sockPath, 0o600); err != nil {
		ln.Close()
		os.Remove(sockPath)
		_ = TerminateProcessGroup(child.Pgid, 2*time.Second)
		_ = child.Master.Close()
		return
	}
	s.listener = ln

	ready := make([]byte, 12)
	binary.BigEndian.PutUint32(ready[0:4], e.Generation)
	binary.BigEndian.PutUint32(ready[4:8], uint32(os.Getpid()))
	binary.BigEndian.PutUint32(ready[8:12], uint32(child.ChildPid))
	enroll.Write(Frame(TReady, ready))

	go s.ptyReader(child)

	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, syscall.SIGTERM)
	signal.Ignore(syscall.SIGPIPE)
	go func() {
		<-sigc
		ln.Close()
		_ = TerminateProcessGroup(child.Pgid, 2*time.Second)
	}()

	var nextID uint64 = 1
	for {
		conn, err := ln.Accept()
		if err != nil {
			break
		}
		// Same-uid peer check before the connection is served at all.
		uc, ok := conn.(*net.UnixConn)
		if !ok {
			conn.Close()
			continue
		}
		raw, err := uc.SyscallConn()
		if err != nil {
			conn.Close()
			continue
		}
		okUID := false
		controlErr := raw.Control(func(fd uintptr) {
			uid, peerErr := PeerUID(fd)
			okUID = peerErr == nil && uid == uint32(os.Getuid())
		})
		if controlErr != nil || !okUID {
			conn.Close()
			continue
		}
		go s.serve(conn, nextID)
		nextID++
	}
	_ = TerminateProcessGroup(child.Pgid, 2*time.Second)
	s.closeClients()
	child.Master.Close()
	os.Remove(sockPath)
}

func resolveExecutable(name, pathValue string) (string, error) {
	if filepath.IsAbs(name) {
		if _, err := os.Stat(name); err != nil {
			return "", err
		}
		return name, nil
	}
	for _, directory := range filepath.SplitList(pathValue) {
		candidate := filepath.Join(directory, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("executable %q not found in PATH", name)
}

func writeAllFd(fd int, b []byte) error {
	for len(b) > 0 {
		n, err := syscall.Write(fd, b)
		if err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

func writeAll(conn net.Conn, b []byte) error {
	for len(b) > 0 {
		n, err := conn.Write(b)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}

// ptyReader must never block, drop, or slow down because of client state:
// the ring always advances (PROTOCOL.md §Backpressure).
func (s *shared) ptyReader(child *PtyChild) {
	buf := make([]byte, 65536)
	for {
		n, err := child.Master.Read(buf)
		if n > 0 {
			s.mu.Lock()
			seq := s.ring.Total()
			s.ring.Append(buf[:n])
			s.enqueueOutputLocked(seq, buf[:n])
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	code := child.Wait()
	s.mu.Lock()
	s.exited = true
	s.exitCode = int32(code)
	ep := make([]byte, 4)
	binary.BigEndian.PutUint32(ep, uint32(int32(code)))
	s.enqueueAllLocked(Frame(TExit, ep))
	s.mu.Unlock()
	// Keep serving replay briefly, then exit.
	time.Sleep(10 * time.Second)
	_ = s.listener.Close()
}

// enqueueAll appends to every client queue, dropping any client that
// exceeds the cap. Caller holds the lock.
func (s *shared) enqueueOutputLocked(seq uint64, data []byte) {
	const maxPayload = MaxFrame - 1 - 8
	for off := 0; off < len(data); {
		n := len(data) - off
		if n > maxPayload {
			n = maxPayload
		}
		p := make([]byte, 8+n)
		binary.BigEndian.PutUint64(p, seq+uint64(off))
		copy(p[8:], data[off:off+n])
		s.enqueueAllLocked(Frame(TOutput, p))
		off += n
	}
}

func (s *shared) enqueueAllLocked(b []byte) {
	var lagged []*client
	for _, c := range s.clients {
		if c.dead {
			continue
		}
		if len(c.queue)+c.inFlight+len(b) > queueCap {
			lagged = append(lagged, c)
			continue
		}
		c.queue = append(c.queue, b...)
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
	for _, c := range lagged {
		// Best-effort notify, then close. The ring is untouched. Closing the
		// blocked connection also unblocks that client's independent writer.
		c.dead = true
		if s.hasCtl && s.controller == c.id {
			s.hasCtl = false
		}
		delete(s.clients, c.id)
		_ = c.conn.Close()
	}
}

// clientWriter owns delivery for exactly one client. A blocked observer can
// therefore consume only its own queue and in-flight budget; healthy clients
// continue draining independently while the ring always advances.
func (s *shared) clientWriter(c *client) {
	for {
		<-c.wake
		for {
			s.mu.Lock()
			current, ok := s.clients[c.id]
			if !ok || current.dead || len(c.queue) == 0 {
				s.mu.Unlock()
				break
			}
			chunk := c.queue
			c.queue = nil
			c.inFlight += len(chunk)
			s.mu.Unlock()
			err := writeAll(c.conn, chunk)
			s.mu.Lock()
			if current, ok = s.clients[c.id]; ok {
				current.inFlight -= len(chunk)
			}
			if err != nil {
				if current, ok = s.clients[c.id]; ok {
					current.dead = true
					delete(s.clients, c.id)
					if s.hasCtl && s.controller == c.id {
						s.hasCtl = false
					}
				}
			}
			s.mu.Unlock()
			if err != nil {
				_ = c.conn.Close()
				return
			}
		}
	}
}

func (s *shared) closeClients() {
	s.mu.Lock()
	clients := make([]net.Conn, 0, len(s.clients))
	for id, c := range s.clients {
		clients = append(clients, c.conn)
		c.dead = true
		delete(s.clients, id)
	}
	s.hasCtl = false
	s.mu.Unlock()
	for _, conn := range clients {
		_ = conn.Close()
	}
}

func (s *shared) serve(conn net.Conn, id uint64) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok || unixConn.SetWriteBuffer(16*1024) != nil {
		_ = conn.Close()
		return
	}
	conn = allWriteConn{Conn: conn}
	defer func() {
		s.mu.Lock()
		if s.hasCtl && s.controller == id {
			s.hasCtl = false
		}
		delete(s.clients, id)
		s.mu.Unlock()
		conn.Close()
	}()

	var buf []byte
	chunk := make([]byte, 8192)
	for {
		n, err := conn.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			for {
				p := ParseFrame(buf)
				if p.Kind == KindIncomplete {
					break
				}
				if p.Kind == KindFatal {
					writeAll(conn, ErrorFrame(p.Code, "protocol error"))
					return
				}
				buf = buf[p.Consumed:]
				if !s.handle(conn, id, p.Type, p.Payload) {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// handle returns false when the connection must close.
func (s *shared) handle(conn net.Conn, id uint64, ftype byte, payload []byte) bool {
	s.mu.Lock()
	current, authenticated := s.clients[id]
	if ftype != THello && (!authenticated || !current.authed) {
		s.mu.Unlock()
		writeAll(conn, ErrorFrame(EAuthFailed, "HELLO required"))
		return false
	}
	if ftype != THello && time.Now().Unix() >= current.expiresAt {
		s.mu.Unlock()
		writeAll(conn, ErrorFrame(EAuthFailed, "capability expired"))
		return false
	}
	// No socket, PTY, replay, or delay I/O is performed while shared.mu is held.
	s.mu.Unlock()

	switch ftype {
	case THello:
		h := ParseHello(payload)
		e := h.Envelope
		s.mu.Lock()
		existing, renewing := s.clients[id]
		invalid := s.wiped || time.Now().Unix() >= e.Expiry || e.Issuer != "roomsd" || e.Audience != s.enrollment.RuntimeID || e.SessionID != s.enrollment.SessionID || e.RuntimeID != s.enrollment.RuntimeID || e.HomeAuthorityID != s.enrollment.HomeAuthorityID || e.Generation != s.enrollment.Generation || !secretEqual(h.Secret, s.secret)
		s.mu.Unlock()
		if invalid {
			writeAll(conn, ErrorFrame(EAuthFailed, "bad secret"))
			return false
		}
		s.mu.Lock()
		_, replayed := s.seenHello[e.ID]
		full := len(s.seenHello) >= maxSeenCredentials
		controllerBusy := s.hasCtl
		s.mu.Unlock()
		if replayed || full || e.ID == "" {
			writeAll(conn, ErrorFrame(EAuthFailed, "replayed credential"))
			return false
		}
		s.mu.Lock()
		if _, replayed = s.seenHello[e.ID]; replayed || len(s.seenHello) >= maxSeenCredentials {
			s.mu.Unlock()
			writeAll(conn, ErrorFrame(EAuthFailed, "replayed credential"))
			return false
		}
		s.seenHello[e.ID] = struct{}{}
		s.mu.Unlock()
		wantControl := h.Mode == 1
		if wantControl && !containsAction(e.Actions, "controller") {
			writeAll(conn, ErrorFrame(EAuthFailed, "controller capability required"))
			return false
		}
		actions := make(map[string]bool, len(e.Actions))
		for _, action := range e.Actions {
			actions[action] = true
		}
		// A live authenticated socket renews with a fresh, non-replayed HELLO
		// before its short-lived capability expires. Renewal keeps the same
		// controller/observer slot and never replays terminal output.
		if renewing {
			if existing.controller != wantControl {
				writeAll(conn, ErrorFrame(EAuthFailed, "capability mode change"))
				return false
			}
			s.mu.Lock()
			existing.expiresAt = e.Expiry
			existing.actions = actions
			next := s.ring.Total()
			s.mu.Unlock()
			ack := make([]byte, 0, 23)
			ack = binary.BigEndian.AppendUint16(ack, Version)
			ack = binary.BigEndian.AppendUint32(ack, s.enrollment.Generation)
			ack = binary.BigEndian.AppendUint64(ack, next)
			ack = binary.BigEndian.AppendUint64(ack, next)
			ack = append(ack, 0)
			writeAll(conn, Frame(THelloAck, ack))
			return true
		}
		if wantControl && controllerBusy {
			writeAll(conn, ErrorFrame(EControllerBsy, "controller already attached"))
			return false
		}
		s.mu.Lock()
		observers := observerCount(s.clients)
		s.mu.Unlock()
		if !wantControl && observers >= observerCap {
			writeAll(conn, ErrorFrame(EBadFrame, "observer cap"))
			return false
		}
		// Atomically claim controller/observer capacity, snapshot replay, and register.
		s.mu.Lock()
		if wantControl && s.hasCtl {
			s.mu.Unlock()
			writeAll(conn, ErrorFrame(EControllerBsy, "controller already attached"))
			return false
		}
		if !wantControl && observerCount(s.clients) >= observerCap {
			s.mu.Unlock()
			writeAll(conn, ErrorFrame(EBadFrame, "observer cap"))
			return false
		}
		rp := s.ring.ReplayFrom(h.Cursor)
		next := s.ring.Total()
		exited := s.exited
		exitCode := s.exitCode
		newClient := &client{id: id, controller: wantControl, conn: conn, authed: true, actions: actions, expiresAt: e.Expiry, wake: make(chan struct{}, 1)}
		s.clients[id] = newClient
		if wantControl {
			s.controller = id
			s.hasCtl = true
		}
		s.mu.Unlock()
		go s.clientWriter(newClient)
		if rp.Invalid {
			writeAll(conn, ErrorFrame(EBadFrame, "cursor past head"))
			return false
		}
		ack := make([]byte, 0, 23)
		ack = binary.BigEndian.AppendUint16(ack, Version)
		ack = binary.BigEndian.AppendUint32(ack, s.enrollment.Generation)
		ack = binary.BigEndian.AppendUint64(ack, rp.From)
		ack = binary.BigEndian.AppendUint64(ack, next)
		if rp.Gap {
			ack = append(ack, 1)
		} else {
			ack = append(ack, 0)
		}
		writeAll(conn, Frame(THelloAck, ack))
		for off := 0; off < len(rp.Bytes); {
			n := len(rp.Bytes) - off
			if n > MaxFrame-1-8 {
				n = MaxFrame - 1 - 8
			}
			p := make([]byte, 8+n)
			binary.BigEndian.PutUint64(p, rp.From+uint64(off))
			copy(p[8:], rp.Bytes[off:off+n])
			if err := writeAll(conn, Frame(TOutput, p)); err != nil {
				return false
			}
			off += n
		}
		if exited {
			ep := make([]byte, 4)
			binary.BigEndian.PutUint32(ep, uint32(exitCode))
			writeAll(conn, Frame(TExit, ep))
		}
		return true

	case TInput:
		s.mu.Lock()
		ctl, exited := s.hasCtl && s.controller == id, s.exited
		s.mu.Unlock()
		if !current.actions["input"] {
			writeAll(conn, ErrorFrame(EAuthFailed, "input capability required"))
			return false
		}
		if !ctl {
			writeAll(conn, ErrorFrame(ENotController, "input requires controller"))
			return false
		}
		if exited {
			writeAll(conn, ErrorFrame(EExited, "child exited"))
			return false
		}
		_, _ = s.master.Write(payload)
		return true

	case TResize:
		s.mu.Lock()
		ctl := s.hasCtl && s.controller == id
		s.mu.Unlock()
		if !current.actions["resize"] {
			writeAll(conn, ErrorFrame(EAuthFailed, "resize capability required"))
			return false
		}
		if !ctl {
			writeAll(conn, ErrorFrame(ENotController, "resize requires controller"))
			return false
		}
		cols := binary.BigEndian.Uint16(payload[0:2])
		rows := binary.BigEndian.Uint16(payload[2:4])
		SetWinsize(s.master, cols, rows)
		return true

	case TSignal:
		if !current.actions["signal"] || len(payload) != 1 {
			writeAll(conn, ErrorFrame(EAuthFailed, "signal capability required"))
			return false
		}
		if payload[0] != byte(syscall.SIGINT) && payload[0] != byte(syscall.SIGTERM) && payload[0] != byte(syscall.SIGHUP) && payload[0] != byte(syscall.SIGWINCH) {
			writeAll(conn, ErrorFrame(EBadFrame, "signal not allowed"))
			return false
		}
		if err := SignalProcessGroup(s.pgid, syscall.Signal(payload[0])); err != nil {
			writeAll(conn, ErrorFrame(EBadFrame, "signal failed"))
			return false
		}
		return true

	case TTerminate:
		if !current.actions["terminate"] {
			writeAll(conn, ErrorFrame(EAuthFailed, "terminate capability required"))
			return false
		}
		s.mu.Lock()
		already := s.terminated
		s.terminated = true
		s.mu.Unlock()
		if !already {
			_ = TerminateProcessGroup(s.pgid, 2*time.Second)
		}
		writeAll(conn, Frame(TTerminateAck, []byte("terminated")))
		return true

	case TDeliverMessage:
		if !current.actions["deliverMessage"] {
			writeAll(conn, ErrorFrame(EAuthFailed, "deliverMessage capability required"))
			return false
		}
		s.mu.Lock()
		exited := s.exited
		s.mu.Unlock()
		if exited {
			writeAll(conn, ErrorFrame(EExited, "child exited"))
			return false
		}
		var tx struct {
			ID     string   `json:"id"`
			Frames [][]byte `json:"frames"`
			Delays []uint32 `json:"delaysMs"`
		}
		decodeErr := decodeStrict(payload, &tx)
		totalPayload, totalDelay := 0, uint64(0)
		for i, f := range tx.Frames {
			if i >= len(tx.Delays) || len(f) > 65536 {
				totalPayload = 1 << 30
				break
			}
			totalPayload += len(f)
			totalDelay += uint64(tx.Delays[i])
		}
		if decodeErr != nil || tx.ID == "" || len(tx.Frames) == 0 || len(tx.Frames) > 64 || len(tx.Delays) != len(tx.Frames) || totalPayload > 1<<20 || totalDelay > 5000 {
			writeAll(conn, ErrorFrame(EBadFrame, "invalid delivery"))
			return false
		}
		s.mu.Lock()
		deliveryCount := len(s.delivered)
		prior, exists := s.delivered[tx.ID]
		s.mu.Unlock()
		if exists {
			writeAll(conn, deliveryAck(tx.ID, prior, true))
			return true
		}
		if len(tx.ID) > 256 || deliveryCount >= maxDeliveries {
			writeAll(conn, ErrorFrame(EBadFrame, "delivery capacity"))
			return false
		}
		s.mu.Lock()
		if prior, exists = s.delivered[tx.ID]; exists {
			s.mu.Unlock()
			writeAll(conn, deliveryAck(tx.ID, prior, true))
			return true
		}
		s.delivered[tx.ID] = deliveryState{InProgress: true, Generation: s.enrollment.Generation}
		gen := s.enrollment.Generation
		s.mu.Unlock()
		bytesWritten := 0
		for i, frame := range tx.Frames {
			if len(frame) > 65536 || tx.Delays[i] > 5000 {
				writeAll(conn, ErrorFrame(EOversize, "delivery frame too large"))
				return false
			}
			if tx.Delays[i] > 0 {
				time.Sleep(time.Duration(tx.Delays[i]) * time.Millisecond)
			}
			n, err := writeAllFile(s.master, frame)
			bytesWritten += n
			if err != nil {
				s.mu.Lock()
				s.delivered[tx.ID] = deliveryState{Uncertain: true, BytesWritten: bytesWritten, Generation: gen}
				s.mu.Unlock()
				return false
			}
		}
		s.mu.Lock()
		s.delivered[tx.ID] = deliveryState{Written: true, BytesWritten: bytesWritten, Generation: gen}
		done := s.delivered[tx.ID]
		s.mu.Unlock()
		writeAll(conn, deliveryAck(tx.ID, done))
		return true

	case TPing:
		writeAll(conn, Frame(TPong, nil))
		return true

	case TWipe:
		// Overwrite in place so the sentinel cannot survive in the
		// original backing array, then drop the reference.
		s.mu.Lock()
		for i := range s.secret {
			s.secret[i] = 0
		}
		s.secret = nil
		s.wiped = true
		s.mu.Unlock()
		writeAll(conn, Frame(TWipeAck, nil))
		return true
	}

	writeAll(conn, ErrorFrame(EBadFrame, "unexpected frame"))
	return false
}

func observerCount(clients map[uint64]*client) int {
	count := 0
	for _, c := range clients {
		if !c.controller && c.authed {
			count++
		}
	}
	return count
}

func containsAction(actions []string, wanted string) bool {
	for _, action := range actions {
		if action == wanted {
			return true
		}
	}
	return false
}
func writeAllFile(f *os.File, b []byte) (int, error) {
	total := 0
	for len(b) > 0 {
		n, err := f.Write(b)
		total += n
		b = b[n:]
		if err != nil {
			return total, err
		}
		if n == 0 {
			return total, io.ErrShortWrite
		}
	}
	return total, nil
}

func deliveryAck(id string, s deliveryState, duplicate ...bool) []byte {
	outcome := "uncertain"
	if len(duplicate) > 0 && duplicate[0] {
		outcome = "duplicate"
	} else if s.Written {
		outcome = "written"
	} else if !s.Uncertain && !s.InProgress {
		outcome = "duplicate"
	}
	b, _ := json.Marshal(struct {
		ID           string `json:"id"`
		Generation   uint32 `json:"generation"`
		Outcome      string `json:"outcome"`
		BytesWritten int    `json:"bytesWritten"`
	}{id, s.Generation, outcome, s.BytesWritten})
	return Frame(TDeliverAck, b)
}
