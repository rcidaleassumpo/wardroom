// Wire framing and bounded production parser.
// This exact code is what --fuzz-parse drives, per gate G1.

package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
)

const (
	MaxFrame = 1 << 20
	Version  = uint16(1)

	THello          = 0x01
	THelloAck       = 0x02
	TOutput         = 0x03
	TInput          = 0x04
	TResize         = 0x05
	TExit           = 0x06
	TError          = 0x07
	TPing           = 0x08
	TPong           = 0x09
	TWipe           = 0x0A
	TWipeAck        = 0x0B
	TDeliverMessage = 0x0C
	TDeliverAck     = 0x0D
	TSignal         = 0x0E
	TTerminate      = 0x0F
	TTerminateAck   = 0x10

	TEnroll             = 0x20
	TFdProbe            = 0x21
	TFdProbeUnsupported = 0x22
	TReady              = 0x23

	EBadVersion    = uint16(1)
	EBadFrame      = uint16(2)
	EAuthFailed    = uint16(3)
	ENotController = uint16(4)
	EOversize      = uint16(5)
	ELagged        = uint16(6)
	EControllerBsy = uint16(7)
	EExited        = uint16(8)
)

type ParseKind int

const (
	KindFrame ParseKind = iota
	KindIncomplete
	KindFatal
)

type Parsed struct {
	Kind     ParseKind
	Type     byte
	Payload  []byte
	Consumed int
	Code     uint16
}

// ParseFrame reads one frame from the front of buf.
//
// The oversize check runs on the 4-byte header ALONE, before any
// allocation, so a hostile length prefix can never make the host reserve a
// gigabyte (conformance vector oversize_header).
func ParseFrame(buf []byte) Parsed {
	if len(buf) < 4 {
		return Parsed{Kind: KindIncomplete}
	}
	length := int(binary.BigEndian.Uint32(buf[:4]))
	if length > MaxFrame {
		return Parsed{Kind: KindFatal, Code: EOversize}
	}
	if length < 1 {
		// length covers (type + payload), so zero has no type byte.
		return Parsed{Kind: KindFatal, Code: EBadFrame}
	}
	if len(buf) < 4+length {
		return Parsed{Kind: KindIncomplete}
	}
	ftype := buf[4]
	payload := append([]byte(nil), buf[5:4+length]...)
	if code, bad := validate(ftype, payload); bad {
		return Parsed{Kind: KindFatal, Code: code}
	}
	return Parsed{Kind: KindFrame, Type: ftype, Payload: payload, Consumed: 4 + length}
}

func validate(ftype byte, payload []byte) (uint16, bool) {
	switch ftype {
	case THello:
		var h helloEnvelope
		if len(payload) == 0 || decodeStrict(payload, &h) != nil || h.Version != Version || h.Issuer == "" || h.Audience == "" || h.SessionID == "" || h.RuntimeID == "" || h.HomeAuthorityID == "" || h.Generation == 0 || h.Expiry <= 0 || h.Nonce == "" || h.ID == "" || len(h.Actions) == 0 || len(h.Actions) > 8 {
			return EBadFrame, true
		}
		seen := map[string]bool{}
		for _, a := range h.Actions {
			if seen[a] || !validAction(a) {
				return EBadFrame, true
			}
			seen[a] = true
		}
	case TResize:
		if len(payload) != 4 {
			return EBadFrame, true
		}
		cols := binary.BigEndian.Uint16(payload[0:2])
		rows := binary.BigEndian.Uint16(payload[2:4])
		if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
			return EBadFrame, true
		}
	case TInput, TDeliverMessage:
	case TSignal:
		if len(payload) != 1 {
			return EBadFrame, true
		}
	case TTerminate:
		if len(payload) != 0 {
			return EBadFrame, true
		}
	case TPing, TWipe:
		if len(payload) != 0 {
			return EBadFrame, true
		}
	case THelloAck, TOutput, TExit, TError, TPong, TWipeAck, TDeliverAck, TTerminateAck,
		TEnroll, TFdProbe, TFdProbeUnsupported, TReady:
	default:
		return EBadFrame, true
	}
	return 0, false
}

func Frame(ftype byte, payload []byte) []byte {
	out := make([]byte, 4, 5+len(payload))
	binary.BigEndian.PutUint32(out, uint32(len(payload)+1))
	out = append(out, ftype)
	return append(out, payload...)
}

func ErrorFrame(code uint16, msg string) []byte {
	p := make([]byte, 2, 2+len(msg))
	binary.BigEndian.PutUint16(p, code)
	return Frame(TError, append(p, msg...))
}

type Hello struct {
	Mode     byte
	Cursor   uint64
	Secret   []byte
	Envelope helloEnvelope
}

type helloEnvelope struct {
	Version         uint16   `json:"version"`
	Issuer          string   `json:"issuer"`
	Audience        string   `json:"audience"`
	SessionID       string   `json:"sessionId"`
	RuntimeID       string   `json:"runtimeId"`
	HomeAuthorityID string   `json:"homeAuthorityId"`
	Generation      uint32   `json:"generation"`
	Actions         []string `json:"actions"`
	Expiry          int64    `json:"expiry"`
	Nonce           string   `json:"nonce"`
	ID              string   `json:"id"`
	Cursor          uint64   `json:"cursor"`
	Secret          []byte   `json:"secret"`
}

// ParseHello assumes validate already accepted the payload.
func ParseHello(payload []byte) Hello {
	var h helloEnvelope
	_ = json.Unmarshal(payload, &h)
	mode := byte(0)
	for _, action := range h.Actions {
		if action == "controller" {
			mode = 1
		}
	}
	return Hello{Mode: mode, Cursor: h.Cursor, Secret: h.Secret, Envelope: h}
}

func validAction(a string) bool {
	switch a {
	case "observe", "controller", "input", "resize", "signal", "terminate", "deliverMessage":
		return true
	}
	return false
}

// FuzzParse reads length-prefixed frames from stdin through the production
// parser above and exits 0 if every frame was accepted or cleanly
// rejected. A crash, hang, or OOM here is the gate-G1 finding.
func FuzzParse() int {
	buf, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 0
	}
	off := 0
	for {
		p := ParseFrame(buf[off:])
		switch p.Kind {
		case KindFrame:
			off += p.Consumed
			if off >= len(buf) {
				return 0
			}
		default:
			// Both fatal and incomplete are clean handling: the host
			// would reply and close.
			return 0
		}
	}
}
