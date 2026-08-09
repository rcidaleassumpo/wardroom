package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const enrollmentVersion = 1

type enrollment struct {
	Version         int      `json:"version"`
	SessionID       string   `json:"sessionId"`
	ChannelID       string   `json:"channelId,omitempty"`
	RuntimeID       string   `json:"runtimeId"`
	HomeAuthorityID string   `json:"homeAuthorityId"`
	Generation      uint32   `json:"generation"`
	ProtocolVersion uint16   `json:"protocolVersion"`
	ExpiresAt       int64    `json:"expiresAt"`
	ReconnectSecret string   `json:"reconnectSecret"`
	StatePath       string   `json:"statePath"`
	SocketPath      string   `json:"socketPath"`
	RingBytes       int      `json:"ringBytes"`
	Command         []string `json:"command,omitempty"`
	Cwd             string   `json:"cwd,omitempty"`
}

type enrollmentState struct {
	Version           int    `json:"version"`
	SessionID         string `json:"sessionId"`
	RuntimeID         string `json:"runtimeId"`
	HomeAuthorityID   string `json:"homeAuthorityId"`
	Generation        uint32 `json:"generation"`
	ProtocolVersion   uint16 `json:"protocolVersion"`
	ExpiresAt         int64  `json:"expiresAt"`
	SecretHash        string `json:"secretHash"`
	Correlation       string `json:"correlation"`
	ReconnectSecret   string `json:"reconnectSecret"`
	CapabilityRenewal bool   `json:"capabilityRenewal"`
}

func parseEnrollment(payload []byte) (enrollment, []byte, error) {
	if len(payload) == 0 || len(payload) > 8192 {
		return enrollment{}, nil, errors.New("invalid enrollment size")
	}
	var e enrollment
	if err := decodeStrict(payload, &e); err != nil || e.Version != enrollmentVersion || e.ProtocolVersion != Version || e.Generation == 0 || e.ExpiresAt <= time.Now().Unix() {
		return enrollment{}, nil, errors.New("invalid enrollment")
	}
	for _, v := range []string{e.SessionID, e.RuntimeID, e.HomeAuthorityID, e.StatePath, e.SocketPath} {
		if v == "" {
			return enrollment{}, nil, errors.New("incomplete enrollment")
		}
	}
	if len(e.Command) > 64 {
		return enrollment{}, nil, errors.New("command too long")
	}
	for _, arg := range e.Command {
		if arg == "" || strings.IndexByte(arg, 0) >= 0 {
			return enrollment{}, nil, errors.New("invalid command")
		}
	}
	if e.Cwd != "" && !filepath.IsAbs(e.Cwd) {
		return enrollment{}, nil, errors.New("cwd must be absolute")
	}
	if !filepath.IsAbs(e.StatePath) || !filepath.IsAbs(e.SocketPath) {
		return enrollment{}, nil, errors.New("enrollment paths must be absolute")
	}
	secret, err := base64.RawStdEncoding.DecodeString(e.ReconnectSecret)
	if err != nil || len(secret) < 32 || len(secret) > 256 {
		return enrollment{}, nil, errors.New("invalid reconnect secret")
	}
	return e, secret, nil
}

// bytesReader avoids exposing enrollment bytes through any logging path.
func bytesReader(b []byte) *byteReader { return &byteReader{b: b} }

type byteReader struct{ b []byte }

func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

func secretEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

func persistEnrollmentState(e enrollment, secret []byte) error {
	parent := filepath.Dir(e.StatePath)
	if info, err := os.Lstat(parent); err == nil {
		if info.IsDir() == false || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
			return errors.New("state parent mode")
		}
	} else if os.IsNotExist(err) {
		if err := os.MkdirAll(parent, 0700); err != nil {
			return err
		}
	} else {
		return err
	}
	if info, err := os.Lstat(e.StatePath); err == nil && (info.Mode()&os.ModeSymlink) != 0 {
		return errors.New("state file symlink")
	} else if err == nil && info.Mode().Perm() != 0600 {
		return errors.New("state file mode")
	}
	hash := sha256.Sum256(secret)
	s := enrollmentState{Version: e.Version, SessionID: e.SessionID, RuntimeID: e.RuntimeID, HomeAuthorityID: e.HomeAuthorityID, Generation: e.Generation, ProtocolVersion: e.ProtocolVersion, ExpiresAt: e.ExpiresAt, SecretHash: fmt.Sprintf("sha256:%x", hash[:]), Correlation: e.RuntimeID + ":" + fmt.Sprint(e.Generation), ReconnectSecret: e.ReconnectSecret, CapabilityRenewal: true}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp, err := os.OpenFile(e.StatePath+".new", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if err := tmp.Sync(); err != nil {
		_ = os.Remove(e.StatePath + ".new")
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(e.StatePath + ".new")
		return err
	}
	if err := os.Rename(e.StatePath+".new", e.StatePath); err != nil {
		return err
	}
	dir, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func decodeStrict(payload []byte, out any) error {
	d := json.NewDecoder(bytesReader(payload))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}
