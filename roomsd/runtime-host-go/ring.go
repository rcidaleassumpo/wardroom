// SPDX-License-Identifier: Apache-2.0
// In-memory output ring with byte-offset cursors (PROTOCOL.md §Ring).
// No file writes on the hot path: the audited agentd behaviour of
// rewriting a whole scrollback file per PTY chunk is the anti-pattern
// under test (equivalence rule E3).

package main

type Ring struct {
	buf   []byte
	cap   int
	total uint64 // bytes ever produced; also the head cursor
}

type Replay struct {
	Bytes   []byte
	From    uint64
	Gap     bool
	Invalid bool // cursor past the head
}

func NewRing(capacity int) *Ring {
	return &Ring{buf: make([]byte, 0, min(capacity, 1<<20)), cap: capacity}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (r *Ring) Total() uint64 { return r.total }

func (r *Ring) Base() uint64 { return r.total - uint64(len(r.buf)) }

func (r *Ring) Append(data []byte) {
	r.total += uint64(len(data))
	if len(data) >= r.cap {
		r.buf = append(r.buf[:0], data[len(data)-r.cap:]...)
		return
	}
	r.buf = append(r.buf, data...)
	if len(r.buf) > r.cap {
		excess := len(r.buf) - r.cap
		r.buf = append(r.buf[:0], r.buf[excess:]...)
	}
}

// ReplayFrom fixes the evaluation order the protocol requires: validate
// cursor > total FIRST, then apply the retained-floor behaviour. A cursor
// past the head never reaches the gap logic.
func (r *Ring) ReplayFrom(cursor uint64) Replay {
	if cursor > r.total {
		return Replay{Invalid: true}
	}
	base := r.Base()
	if cursor >= base {
		off := int(cursor - base)
		out := append([]byte(nil), r.buf[off:]...)
		return Replay{Bytes: out, From: cursor, Gap: false}
	}
	out := append([]byte(nil), r.buf...)
	return Replay{Bytes: out, From: base, Gap: true}
}
