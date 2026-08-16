// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProviderEnvironmentDeclaresTrueColorTerminal(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, declaration := range []string{"TERM=xterm-256color", "COLORTERM=truecolor"} {
		if !strings.Contains(text, `"`+declaration+`"`) {
			t.Fatalf("provider environment lacks %s", declaration)
		}
	}
}

func TestHelloRenewsCapabilityOnSameConnection(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	state := &shared{
		ring:       NewRing(1024),
		clients:    make(map[uint64]*client),
		secret:     secret,
		enrollment: enrollment{SessionID: "session", RuntimeID: "runtime", HomeAuthorityID: "home", Generation: 1},
		seenHello:  make(map[string]struct{}),
		delivered:  make(map[string]deliveryState),
	}
	host, peer := net.Pipe()
	defer host.Close()
	defer peer.Close()

	oldExpiry := time.Now().Unix() + 1
	assertHandleFrame(t, state, host, peer, 1, THello, helloPayload(t, secret, oldExpiry, "initial"), THelloAck)
	newExpiry := time.Now().Unix() + 30
	assertHandleFrame(t, state, host, peer, 1, THello, helloPayload(t, secret, newExpiry, "renewal"), THelloAck)

	state.mu.Lock()
	gotExpiry := state.clients[1].expiresAt
	state.mu.Unlock()
	if gotExpiry != newExpiry {
		t.Fatalf("renewed expiry = %d, want %d", gotExpiry, newExpiry)
	}

	time.Sleep(time.Until(time.Unix(oldExpiry+1, 0)))
	assertHandleFrame(t, state, host, peer, 1, TPing, nil, TPong)
}

func TestSessionProofEnvironmentUsesUnpaddedURLSafeEncoding(t *testing.T) {
	if got, want := sessionProofEnvironment([]byte{0xfb, 0xff, 0xef, 0x00}), "-__vAA"; got != want {
		t.Fatalf("session proof = %q, want %q", got, want)
	}
}

func helloPayload(t *testing.T, secret []byte, expiry int64, id string) []byte {
	t.Helper()
	payload, err := json.Marshal(helloEnvelope{
		Version: 1, Issuer: "roomsd", Audience: "runtime", SessionID: "session", RuntimeID: "runtime",
		HomeAuthorityID: "home", Generation: 1, Actions: []string{"observe", "controller", "input"},
		Expiry: expiry, Nonce: id + "-nonce", ID: id, Cursor: 0, Secret: secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func assertHandleFrame(t *testing.T, state *shared, host, peer net.Conn, id uint64, inputType byte, payload []byte, outputType byte) {
	t.Helper()
	result := make(chan bool, 1)
	go func() { result <- state.handle(host, id, inputType, payload) }()
	header := make([]byte, 4)
	if _, err := io.ReadFull(peer, header); err != nil {
		t.Fatal(err)
	}
	length := binary.BigEndian.Uint32(header)
	frame := make([]byte, length)
	if _, err := io.ReadFull(peer, frame); err != nil {
		t.Fatal(err)
	}
	if frame[0] != outputType {
		t.Fatalf("frame type = %d, want %d", frame[0], outputType)
	}
	if !<-result {
		t.Fatalf("handler closed after frame type %d", inputType)
	}
}
