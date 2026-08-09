#!/usr/bin/env python3
"""Coordinator-run black-box fixture for the built Go host (not run by worker)."""
import base64, json, os, secrets, socket, struct, subprocess, tempfile, time, sys

MAX = 1 << 20
TIMEOUT = float(os.environ.get("ROOMS_FIXTURE_TIMEOUT", "3"))
def frame(t, p=b""): return struct.pack(">I", len(p)+1) + bytes([t]) + p
def readf(s):
    h=s.recv(4); assert len(h)==4; n=struct.unpack(">I",h)[0]; b=b''
    while len(b)<n: b += s.recv(n-len(b))
    return b[0], b[1:]
def read_until_type(s, wanted, deadline=None):
    deadline = TIMEOUT if deadline is None else deadline
    end=time.monotonic()+deadline
    while time.monotonic()<end:
        s.settimeout(max(0.05,end-time.monotonic())); t,p=readf(s)
        if t==wanted: return p
    raise AssertionError(f"missing frame type {wanted}")
def hello(secret, exp, actions, cursor=0, ident=None):
    return frame(1, json.dumps({"version":1,"issuer":"roomsd","audience":"rt-1","sessionId":"sess-1","runtimeId":"rt-1","homeAuthorityId":"home-1","generation":1,"actions":actions,"expiry":exp,"nonce":ident or secrets.token_hex(8),"id":ident or secrets.token_hex(8),"cursor":cursor,"secret":base64.b64encode(secret).decode()}).encode())

with tempfile.TemporaryDirectory(prefix="rooms-go-fixture-") as d:
    sockpath=os.path.join(d,"control.sock"); state=os.path.join(d,"state.json"); secret=secrets.token_bytes(32)
    sockets=[]; a,b=socket.socketpair(); sockets += [a,b]; a.settimeout(TIMEOUT); b.settimeout(TIMEOUT)
    e={"version":1,"sessionId":"sess-1","runtimeId":"rt-1","homeAuthorityId":"home-1","generation":1,"protocolVersion":1,"expiresAt":int(time.time())+30,"reconnectSecret":base64.b64encode(secret).rstrip(b'=').decode(),"statePath":state,"socketPath":sockpath,"ringBytes":65536}
    host=os.environ.get("ROOMS_GO_HOST",os.path.join(os.path.dirname(__file__),"dist","rooms-runtime-host-darwin-arm64"))
    saved3 = os.dup(3) if os.path.exists('/dev/fd/3') else None
    os.dup2(b.fileno(),3); os.set_inheritable(3,True)
    p=subprocess.Popen([host,"run","--shell","/bin/sh"], pass_fds=(3,), close_fds=True, stderr=subprocess.PIPE, text=True)
    if saved3 is not None: os.dup2(saved3,3); os.close(saved3)
    else: os.close(3)
    try:
        a.sendall(frame(0x20,json.dumps(e).encode())); t,payload=readf(a); assert t==0x23, (t,payload)
        c=socket.socket(socket.AF_UNIX); sockets.append(c); c.settimeout(TIMEOUT); c.connect(sockpath); c.sendall(hello(secret,int(time.time())+30,["observe","controller","input","deliverMessage","signal","terminate"],ident="h1")); assert readf(c)[0]==2
        c.sendall(frame(4,b"printf fixture\\n"));
        seen=False
        for _ in range(20):
            t,pty_payload=readf(c)
            if t==3 and b"fixture" in pty_payload: seen=True; break
        assert seen
        tx=json.dumps({"id":"m1","frames":[base64.b64encode(b"printf delivered\\n").decode()],"delaysMs":[0]}).encode(); c.sendall(frame(0x0c,tx)); ack=json.loads(read_until_type(c,0x0d)); assert ack["outcome"]=="written" and ack["id"]=="m1" and ack["bytesWritten"]>0
        delivered=False
        for _ in range(20):
            t,pty_payload=readf(c)
            if t==3 and b"delivered" in pty_payload: delivered=True; break
        assert delivered
        c.sendall(frame(0x0c,tx)); assert json.loads(read_until_type(c,0x0d))["outcome"]=="duplicate"
        r=socket.socket(socket.AF_UNIX); sockets.append(r); r.settimeout(TIMEOUT); r.connect(sockpath); r.sendall(hello(secret,int(time.time())+30,["observe"],cursor=0,ident="h2")); assert readf(r)[0]==2
        assert any(b"fixture" in readf(r)[1] or b"delivered" in readf(r)[1] for _ in range(20))
        expiry_socket=socket.socket(socket.AF_UNIX); sockets.append(expiry_socket); expiry_socket.settimeout(TIMEOUT); expiry_socket.connect(sockpath); expiry_socket.sendall(hello(secret,int(time.time())-1,["observe"],ident="expired")); assert readf(expiry_socket)[0]==7
        z=socket.socket(socket.AF_UNIX); sockets.append(z); z.settimeout(TIMEOUT); z.connect(sockpath); z.sendall(hello(secret,int(time.time())+30,["terminate","signal"],ident="h3")); assert readf(z)[0]==2; z.sendall(frame(0x0e,bytes([15]))); z.sendall(frame(0x0f,b"")); assert read_until_type(z,0x10); p.wait(timeout=15); assert p.returncode==0; assert not os.path.exists(sockpath)
    finally:
        primary_exc=sys.exc_info()[1]
        primary=primary_exc is not None
        for q in sockets:
            try: q.close()
            except OSError: pass
        a.close(); b.close()
        if p.poll() is None:
            try: os.killpg(p.pid, 9)
            except ProcessLookupError: pass
            try: p.wait(timeout=3)
            except subprocess.TimeoutExpired: pass
        if primary and primary_exc is not None and hasattr(primary_exc, "add_note") and p.stderr:
            report=p.stderr.read()
            if report: primary_exc.add_note("host stderr/race report:\n"+report)
        if not primary and p.returncode not in (0,None): raise AssertionError(p.stderr.read() if p.stderr else "host failed")
        if not primary: assert not os.path.exists(sockpath), sockpath
print("fixture complete")
