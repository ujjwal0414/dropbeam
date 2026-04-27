/**
 * DropBeam v2 — WebRTC P2P File Sharing
 * Extra features: display name, clipboard paste, transfer history,
 *   speed meter, ETA, cancel, re-download, file-type icons
 * Responsive: sidebar + main on desktop → stacked on mobile
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Constants ────────────────────────────────────────────────────────────────
const PEERJS_CDN  = "https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js";
const CHUNK_SIZE  = 64 * 1024;   // 64 KB
const MAX_BUFFER  = 1024 * 1024; // 1 MB back-pressure

// ── Helpers ──────────────────────────────────────────────────────────────────
const genCode  = () => Math.random().toString(36).substring(2, 8).toUpperCase();

const fmtSize  = (b) => {
  if (!b) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};

const fmtSpeed = (bps) => {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
};

const fileIcon = (mime = "") => {
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.includes("pdf"))      return "📄";
  if (mime.includes("zip") || mime.includes("rar")) return "🗜";
  if (mime.includes("text"))     return "📝";
  return "📦";
};

const loadPeerJS = () =>
  new Promise((res, rej) => {
    if (window.Peer) return res();
    const s = document.createElement("script");
    s.src = PEERJS_CDN;
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export  function DropBeamv2() {
  // ── Peer ──────────────────────────────────────────────────────────────────
  const [myCode,    setMyCode]    = useState("");
  const [peerReady, setPeerReady] = useState(false);
  const [connCode,  setConnCode]  = useState("");
  const [conn,      setConn]      = useState(null);
  const [connected, setConnected] = useState(false);
  const [peerName,  setPeerName]  = useState("");

  // ── Name ──────────────────────────────────────────────────────────────────
  const [myName,      setMyName]      = useState(() => localStorage.getItem("db_name") || "");
  const [editingName, setEditingName] = useState(!localStorage.getItem("db_name"));

  // ── Transfers ─────────────────────────────────────────────────────────────
  // { id, name, size, mime, progress, done, error, direction, speed, eta, blobUrl }
  const [transfers, setTransfers] = useState([]);

  // ── UI ────────────────────────────────────────────────────────────────────
  const [dragging,   setDragging]   = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activeTab,  setActiveTab]  = useState("send");
  const [copied,     setCopied]     = useState(false);
  const [statusMsg,  setStatusMsg]  = useState("Initializing…");

  // ── History ───────────────────────────────────────────────────────────────
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("db_history") || "[]"); } catch { return []; }
  });

  // ── Refs ──────────────────────────────────────────────────────────────────
  const peerRef      = useRef(null);
  const incomingRef  = useRef({});
  const cancelRef    = useRef(new Set());
  const videoRef     = useRef(null);
  const streamRef    = useRef(null);
  const fileInputRef = useRef(null);

  const addHistory = (entry) => {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 60);
      localStorage.setItem("db_history", JSON.stringify(next));
      return next;
    });
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const code = genCode();
    setMyCode(code);
    (async () => {
      await loadPeerJS();
      const peer = new window.Peer(code, {
        host: "0.peerjs.com", port: 443, path: "/", secure: true,
        config: { iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ]},
      });
      peer.on("open",       ()  => { setPeerReady(true); setStatusMsg("Ready"); });
      peer.on("connection", (c) => setupConn(c));
      peer.on("error",      (e) => setStatusMsg(`Error: ${e.type}`));
      peerRef.current = peer;
    })();
    return () => peerRef.current?.destroy();
  }, []); // eslint-disable-line

  // ── Clipboard paste ───────────────────────────────────────────────────────
  useEffect(() => {
    const onPaste = (e) => {
      if (!connected) return;
      const files = Array.from(e.clipboardData?.items || [])
        .filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
      if (files.length) sendFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [connected]); // eslint-disable-line

  // ── Connection setup ─────────────────────────────────────────────────────
  const setupConn = useCallback((c) => {
    c.on("open", () => {
      setConn(c); setConnected(true); setStatusMsg("Connected");
      c.send({ type: "hello", name: localStorage.getItem("db_name") || myCode });
    });
    c.on("data", (data) => {
      if (data.type === "hello") {
        setPeerName(data.name);
      } else if (data.type === "meta") {
        const id = `${data.name}_${Date.now()}`;
        incomingRef.current[data.name] = {
          id, name: data.name, size: data.size, mime: data.mime,
          chunks: [], received: 0, startTime: Date.now(),
        };
        setTransfers((p) => [{
          id, name: data.name, size: data.size, mime: data.mime,
          progress: 0, done: false, error: null, direction: "in",
          speed: 0, eta: null, blobUrl: null,
        }, ...p]);
      } else if (data.type === "chunk") {
        const e = incomingRef.current[data.name];
        if (!e) return;
        e.chunks.push(data.chunk);
        e.received += data.chunk.byteLength;
        const progress = Math.round((e.received / e.size) * 100);
        const elapsed  = (Date.now() - e.startTime) / 1000 || 1;
        const speed    = e.received / elapsed;
        const eta      = Math.ceil((e.size - e.received) / speed);
        setTransfers((p) => p.map((t) => t.id === e.id ? { ...t, progress, speed, eta } : t));
      } else if (data.type === "done") {
        const e = incomingRef.current[data.name];
        if (!e) return;
        const blob    = new Blob(e.chunks, { type: e.mime });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl; a.download = e.name; a.click();
        setTransfers((p) => p.map((t) => t.id === e.id
          ? { ...t, progress: 100, done: true, speed: 0, eta: null, blobUrl } : t));
        addHistory({ name: e.name, size: e.size, mime: e.mime, direction: "in", time: Date.now() });
        delete incomingRef.current[data.name];
      }
    });
    c.on("close", () => { setConnected(false); setConn(null); setPeerName(""); setStatusMsg("Disconnected"); });
    c.on("error", (e) => setStatusMsg(`Error: ${e}`));
  }, [myCode]); // eslint-disable-line

  const connectToPeer = () => {
    if (!peerRef.current || !connCode.trim() || connected) return;
    setStatusMsg("Connecting…");
    const c = peerRef.current.connect(connCode.trim().toUpperCase(), { reliable: true });
    setupConn(c);
  };

  // ── Send files ────────────────────────────────────────────────────────────
  const sendFiles = useCallback(async (filesToSend) => {
    if (!conn || !connected) return;
    for (const file of filesToSend) {
      const id = `${file.name}_${Date.now()}`;
      setTransfers((p) => [{
        id, name: file.name, size: file.size, mime: file.type,
        progress: 0, done: false, error: null, direction: "out",
        speed: 0, eta: null, blobUrl: null,
      }, ...p]);
      conn.send({ type: "meta", name: file.name, size: file.size, mime: file.type });
      const buffer    = await file.arrayBuffer();
      const startTime = Date.now();
      let offset      = 0;
      let cancelled   = false;

      while (offset < buffer.byteLength) {
        if (cancelRef.current.has(id)) { cancelled = true; break; }
        while (conn.dataChannel?.bufferedAmount > MAX_BUFFER)
          await new Promise((r) => setTimeout(r, 30));
        const end   = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
        conn.send({ type: "chunk", name: file.name, chunk: buffer.slice(offset, end) });
        offset = end;
        const progress = Math.round((offset / buffer.byteLength) * 100);
        const elapsed  = (Date.now() - startTime) / 1000 || 1;
        const speed    = offset / elapsed;
        const eta      = Math.ceil((buffer.byteLength - offset) / speed);
        setTransfers((p) => p.map((t) => t.id === id ? { ...t, progress, speed, eta } : t));
      }

      if (cancelled) {
        setTransfers((p) => p.map((t) => t.id === id ? { ...t, error: "Cancelled" } : t));
      } else {
        conn.send({ type: "done", name: file.name });
        setTransfers((p) => p.map((t) => t.id === id
          ? { ...t, progress: 100, done: true, speed: 0, eta: null } : t));
        addHistory({ name: file.name, size: file.size, mime: file.type, direction: "out", time: Date.now() });
      }
    }
  }, [conn, connected]);

  // ── Camera ────────────────────────────────────────────────────────────────
  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 4096 }, height: { ideal: 2160 } },
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOpen(true);
    } catch { setStatusMsg("Camera denied"); }
  };

  const capturePhoto = () => {
    const v = videoRef.current; if (!v) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    c.toBlob((blob) => {
      sendFiles([new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" })]);
      closeCamera();
    }, "image/jpeg", 1.0);
  };

  const closeCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null; setCameraOpen(false);
  };

  const copyCode = () => {
    navigator.clipboard?.writeText(myCode); setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveName = () => {
    localStorage.setItem("db_name", myName); setEditingName(false);
    if (conn && connected) conn.send({ type: "hello", name: myName });
  };

  const activeXfers = transfers.filter((t) => !t.done && !t.error);
  const doneXfers   = transfers.filter((t) =>  t.done ||  t.error);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <Styles />
      <div className="root">
        {/* Header */}
        <header className="hdr">
          <span className="logo">
            <span className={`led ${peerReady ? "green" : "amber pulse"}`} />
            DropBeam
          </span>
          <span className="status">
            <span className={`led sm ${connected ? "green pulse" : "dim"}`} />
            {connected ? (peerName ? `↔ ${peerName}` : "Connected") : statusMsg}
          </span>
        </header>

        <div className="body">
          {/* ── Sidebar ── */}
          <aside className="sidebar">
            {/* Code */}
            <section className="card">
              <div className="label">Your code</div>
              <div className="code-row">
                <span className="big-code">{myCode || "------"}</span>
                <button className="ghost-btn sm" onClick={copyCode}>
                  {copied ? "✓" : "Copy"}
                </button>
              </div>
              <p className="hint">Share with another device to receive files.</p>
            </section>

            {/* Name */}
            <section className="card">
              <div className="label">Device name</div>
              {editingName ? (
                <div className="row gap8">
                  <input className="text-in" placeholder="e.g. Priya's Phone"
                    value={myName} maxLength={24}
                    onChange={(e) => setMyName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveName()} />
                  <button className="ghost-btn" onClick={saveName}>Save</button>
                </div>
              ) : (
                <div className="row gap8">
                  <span style={{flex:1,fontSize:14,fontWeight:500}}>{myName || myCode}</span>
                  <button className="ghost-btn sm" onClick={() => setEditingName(true)}>Edit</button>
                </div>
              )}
            </section>

            {/* Connect */}
            <section className="card">
              <div className="label">Connect to peer</div>
              {connected ? (
                <div className="peer-badge">
                  <span className="led green pulse sm" />
                  <span style={{flex:1,fontSize:14}}>{peerName || connCode || "Peer"}</span>
                  <button className="ghost-btn sm"
                    onClick={() => { conn?.close(); setConnected(false); setConn(null); }}>
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <div className="row gap8">
                    <input className="code-in" placeholder="Enter code" maxLength={6}
                      value={connCode}
                      onChange={(e) => setConnCode(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === "Enter" && connectToPeer()} />
                    <button className="primary-btn"
                      onClick={connectToPeer}
                      disabled={!peerReady || !connCode.trim()}>
                      Link →
                    </button>
                  </div>
                  <p className="hint" style={{marginTop:8}}>
                    Same Wi-Fi = fastest. Cross-network works too.
                  </p>
                </>
              )}
            </section>
          </aside>

          {/* ── Main ── */}
          <main className="main">
            {connected ? (
              <>
                {/* Tabs */}
                <div className="tabs">
                  {["send", "history"].map((tab) => (
                    <button key={tab} className={`tab ${activeTab === tab ? "active" : ""}`}
                      onClick={() => setActiveTab(tab)}>
                      {tab === "send" ? "Send" : "History"}
                      {tab === "send" && activeXfers.length > 0 && (
                        <span className="badge">{activeXfers.length}</span>
                      )}
                      {tab === "history" && history.length > 0 && (
                        <span className="cnt">{history.length}</span>
                      )}
                    </button>
                  ))}
                </div>

                {activeTab === "send" && (
                  <>
                    {/* Drop zone */}
                    <div className={`drop-zone ${dragging ? "drag" : ""}`}
                      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault(); setDragging(false);
                        sendFiles(Array.from(e.dataTransfer.files));
                      }}
                      onClick={() => fileInputRef.current?.click()}>
                      <input ref={fileInputRef} type="file" multiple style={{display:"none"}}
                        onChange={(e) => {
                          sendFiles(Array.from(e.target.files || []));
                          e.target.value = "";
                        }} />
                      <span style={{fontSize:40}}>{dragging ? "📬" : "📂"}</span>
                      <span className="dz-main">Drop files here</span>
                      <span className="dz-sub">
                        Any format · Any size · Zero compression
                        <br /><span style={{opacity:.55}}>or Ctrl+V to paste from clipboard</span>
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="action-grid">
                      <button className="action-card" onClick={openCamera}>
                        <span style={{fontSize:22}}>📷</span>
                        <span>Camera</span>
                      </button>
                      <button className="action-card" onClick={() => fileInputRef.current?.click()}>
                        <span style={{fontSize:22}}>🗂</span>
                        <span>Browse</span>
                      </button>
                    </div>

                    {/* Active transfers */}
                    {activeXfers.length > 0 && (
                      <div className="xfer-section">
                        <div className="label">Transferring</div>
                        {activeXfers.map((t) => (
                          <XCard key={t.id} t={t}
                            onCancel={() => { cancelRef.current.add(t.id); }} />
                        ))}
                      </div>
                    )}

                    {/* Done */}
                    {doneXfers.length > 0 && (
                      <div className="xfer-section">
                        <div className="label">Completed</div>
                        {doneXfers.map((t) => <XCard key={t.id} t={t} />)}
                      </div>
                    )}

                    {transfers.length === 0 && (
                      <div className="empty">
                        <div style={{fontSize:32}}>🚀</div>
                        <div>No transfers yet — beam something!</div>
                      </div>
                    )}
                  </>
                )}

                {activeTab === "history" && (
                  <HistoryTab history={history} onClear={() => {
                    setHistory([]); localStorage.removeItem("db_history");
                  }} />
                )}
              </>
            ) : (
              <div className="waiting">
                <div style={{fontSize:48}}>📡</div>
                <strong style={{fontSize:16}}>Waiting for connection</strong>
                <p style={{color:"var(--muted)",fontSize:13,maxWidth:300,lineHeight:1.6}}>
                  Enter a peer's code in the sidebar, or share yours so they can connect.
                </p>
                {peerReady && (
                  <div style={{fontFamily:"var(--mono)",fontSize:22,color:"var(--green)",letterSpacing:"0.45em",marginTop:8}}>
                    {myCode}
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Camera overlay */}
      {cameraOpen && (
        <div className="cam-overlay">
          <video ref={videoRef} autoPlay playsInline muted
            style={{borderRadius:12,maxWidth:"100%",maxHeight:"62vh",border:"1px solid var(--line)"}} />
          <div className="row gap12">
            <button className="primary-btn lg" onClick={capturePhoto}>📸 Capture & Send</button>
            <button className="ghost-btn lg" onClick={closeCamera}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TRANSFER CARD
// ═══════════════════════════════════════════════════════════════════════════
function XCard({ t, onCancel }) {
  const done  = t.done;
  const err   = !!t.error;
  const live  = !done && !err;

  return (
    <div className="xcard">
      <div className="xcard-top">
        <span style={{fontSize:20,flexShrink:0}}>{fileIcon(t.mime)}</span>
        <span className="xcard-name" title={t.name}>{t.name}</span>
        <span className={`dir-badge ${t.direction}`}>
          {t.direction === "out" ? "↑ Send" : "↓ Recv"}
        </span>
        <span className="xmeta">{fmtSize(t.size)}</span>
        {live && onCancel && (
          <button className="x-cancel" onClick={onCancel} title="Cancel">✕</button>
        )}
      </div>

      <div className="prog-bar">
        <div className={`prog-fill ${err?"err":done?"done":""}`}
          style={{width:`${err?100:t.progress}%`}} />
      </div>

      <div className="xcard-bot">
        <span className="xspeed">
          {live && t.speed > 0 && fmtSpeed(t.speed)}
          {live && t.eta > 0  && ` · ${t.eta}s`}
          {err  && <span style={{color:"#e86060"}}>{t.error}</span>}
        </span>
        <div className="row gap8">
          {done && t.blobUrl && (
            <a href={t.blobUrl} download={t.name} className="dl-link">↓ Again</a>
          )}
          <span className={`xpct ${err?"err":done?"ok":""}`}>
            {err ? "Cancelled" : done ? "✓ Done" : `${t.progress}%`}
          </span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY TAB
// ═══════════════════════════════════════════════════════════════════════════
function HistoryTab({ history, onClear }) {
  if (!history.length)
    return <div className="empty"><div style={{fontSize:32}}>📋</div><div>No history yet.</div></div>;

  return (
    <div>
      <div className="row gap8" style={{marginBottom:12}}>
        <div className="label" style={{marginBottom:0,flex:1}}>Transfer history</div>
        <button className="ghost-btn sm" onClick={onClear}>Clear all</button>
      </div>
      <div className="card" style={{padding:"4px 0"}}>
        {history.map((h, i) => (
          <div className="hist-row" key={i}>
            <span style={{fontSize:18}}>{fileIcon(h.mime)}</span>
            <div style={{flex:1,minWidth:0}}>
              <div className="xcard-name" style={{fontSize:13}}>{h.name}</div>
              <div className="xmeta">{fmtSize(h.size)} · {h.direction === "out" ? "Sent" : "Received"}</div>
            </div>
            <span className="xmeta">{new Date(h.time).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════
function Styles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Outfit:wght@400;500;600;700&display=swap');
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      :root{
        --bg:#0d0d14;--bg2:#131320;--bg3:#1a1a2a;
        --line:rgba(255,255,255,0.07);--line2:rgba(255,255,255,0.13);
        --green:#39e8a0;--green2:#1ab57c;
        --text:#e8e8f0;--muted:rgba(232,232,240,.45);--dim:rgba(232,232,240,.22);
        --mono:'IBM Plex Mono',monospace;--sans:'Outfit',sans-serif;
        --r:12px;--r2:8px;
      }
      body{background:var(--bg);color:var(--text);font-family:var(--sans);}
      .root{display:flex;flex-direction:column;min-height:100svh;}

      /* Header */
      .hdr{display:flex;align-items:center;justify-content:space-between;
           padding:14px 20px;border-bottom:1px solid var(--line);
           background:var(--bg);position:sticky;top:0;z-index:10;}
      .logo{font-size:16px;font-weight:700;letter-spacing:-.02em;display:flex;align-items:center;gap:8px;}
      .status{font-family:var(--mono);font-size:11px;color:var(--dim);display:flex;align-items:center;gap:6px;}

      /* LED dot */
      .led{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim);flex-shrink:0;}
      .led.green{background:var(--green);}
      .led.amber{background:#e8a039;}
      .led.sm{width:6px;height:6px;}
      .led.dim{background:var(--dim);}
      .pulse{animation:blink 1.6s ease-in-out infinite;}
      @keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}

      /* Layout */
      .body{display:flex;flex:1;overflow:hidden;}
      .sidebar{width:272px;flex-shrink:0;border-right:1px solid var(--line);
               display:flex;flex-direction:column;gap:16px;padding:20px 16px;overflow-y:auto;}
      .main{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:18px;}
      @media(max-width:680px){
        .body{flex-direction:column;}
        .sidebar{width:100%;border-right:none;border-bottom:1px solid var(--line);
                 padding:16px;gap:14px;flex-direction:row;flex-wrap:wrap;}
        .sidebar > section{flex:1;min-width:220px;}
        .main{padding:14px;}
      }
      @media(max-width:420px){
        .sidebar{flex-direction:column;}
        .sidebar > section{min-width:unset;}
      }

      /* Cards */
      .card{background:var(--bg2);border:1px solid var(--line);border-radius:var(--r);padding:14px;}
      .label{font-family:var(--mono);font-size:10px;letter-spacing:.15em;color:var(--dim);
             text-transform:uppercase;margin-bottom:10px;}
      .hint{font-size:11px;color:var(--dim);margin-top:6px;line-height:1.5;}

      /* Code */
      .code-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
      .big-code{font-family:var(--mono);font-size:clamp(18px,4vw,28px);font-weight:500;
                letter-spacing:.45em;color:var(--green);}

      /* Inputs & buttons */
      .row{display:flex;align-items:center;}
      .gap8{gap:8px;} .gap12{gap:12px;}
      .text-in,.code-in{flex:1;background:var(--bg3);border:1px solid var(--line2);
                border-radius:var(--r2);padding:9px 12px;color:var(--text);
                font-family:var(--mono);font-size:14px;outline:none;min-width:0;
                transition:border .15s;}
      .code-in{letter-spacing:.3em;text-transform:uppercase;font-size:16px;}
      .text-in:focus,.code-in:focus{border-color:var(--green2);}
      .text-in::placeholder,.code-in::placeholder{color:var(--dim);letter-spacing:normal;text-transform:none;}
      .ghost-btn{background:transparent;border:1px solid var(--line2);border-radius:var(--r2);
                 color:var(--muted);font-family:var(--sans);font-size:13px;padding:8px 14px;
                 cursor:pointer;transition:all .15s;white-space:nowrap;}
      .ghost-btn:hover{color:var(--text);border-color:var(--line2);}
      .ghost-btn.sm{padding:5px 10px;font-size:12px;}
      .ghost-btn.lg{padding:12px 22px;font-size:15px;}
      .primary-btn{background:var(--green);color:#000;font-family:var(--sans);font-size:13px;
                   font-weight:600;border:none;border-radius:var(--r2);padding:9px 18px;
                   cursor:pointer;transition:all .15s;white-space:nowrap;}
      .primary-btn:hover{background:#4ffdb8;}
      .primary-btn:disabled{background:var(--bg3);color:var(--dim);cursor:not-allowed;}
      .primary-btn.lg{padding:12px 28px;font-size:15px;}

      /* Peer badge */
      .peer-badge{background:var(--bg3);border:1px solid var(--green2);border-radius:var(--r2);
                  padding:8px 12px;display:flex;align-items:center;gap:8px;}

      /* Tabs */
      .tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);}
      .tab{font-family:var(--sans);font-size:14px;padding:8px 16px;cursor:pointer;
           color:var(--muted);background:none;border:none;
           border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s;
           display:flex;align-items:center;gap:6px;}
      .tab.active{color:var(--green);border-bottom-color:var(--green);}
      .badge{background:var(--green);color:#000;border-radius:10px;
             padding:1px 6px;font-size:11px;font-weight:700;}
      .cnt{font-size:11px;color:var(--dim);}

      /* Drop zone */
      .drop-zone{border:2px dashed var(--line2);border-radius:var(--r);padding:38px 20px;
                 display:flex;flex-direction:column;align-items:center;gap:10px;
                 cursor:pointer;transition:all .2s;text-align:center;}
      .drop-zone:hover,.drop-zone.drag{border-color:var(--green2);background:rgba(57,232,160,.04);}
      .dz-main{font-size:15px;font-weight:600;}
      .dz-sub{font-size:13px;color:var(--muted);line-height:1.6;}

      /* Action grid */
      .action-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
      .action-card{background:var(--bg3);border:1px solid var(--line);border-radius:var(--r2);
                   padding:14px;display:flex;align-items:center;gap:10px;cursor:pointer;
                   transition:all .15s;font-family:var(--sans);font-size:13px;color:var(--muted);}
      .action-card:hover{border-color:var(--line2);color:var(--text);}
      @media(max-width:380px){.action-grid{grid-template-columns:1fr;}}

      /* Transfer card */
      .xfer-section{display:flex;flex-direction:column;gap:8px;}
      .xcard{background:var(--bg2);border:1px solid var(--line);border-radius:var(--r2);
             padding:12px 14px;display:flex;flex-direction:column;gap:8px;}
      .xcard-top{display:flex;align-items:center;gap:8px;}
      .xcard-name{font-size:13px;font-weight:500;flex:1;overflow:hidden;
                  text-overflow:ellipsis;white-space:nowrap;}
      .xmeta{font-family:var(--mono);font-size:11px;color:var(--dim);white-space:nowrap;}
      .dir-badge{font-size:11px;padding:2px 7px;border-radius:4px;font-weight:600;flex-shrink:0;}
      .dir-badge.out{background:rgba(57,232,160,.1);color:var(--green);}
      .dir-badge.in{background:rgba(99,160,232,.1);color:#63a0e8;}
      .prog-bar{height:3px;background:var(--bg3);border-radius:2px;overflow:hidden;}
      .prog-fill{height:100%;background:var(--green);border-radius:2px;transition:width .3s linear;}
      .prog-fill.done{background:var(--green2);}
      .prog-fill.err{background:#e86060;}
      .xcard-bot{display:flex;justify-content:space-between;align-items:center;}
      .xspeed{font-family:var(--mono);font-size:11px;color:var(--muted);}
      .xpct{font-family:var(--mono);font-size:12px;font-weight:500;color:var(--muted);}
      .xpct.ok{color:var(--green);} .xpct.err{color:#e86060;}
      .x-cancel{background:none;border:none;color:var(--dim);cursor:pointer;
                font-size:12px;padding:2px 6px;border-radius:4px;}
      .x-cancel:hover{color:#e86060;}
      .dl-link{font-size:11px;color:var(--green);border:1px solid var(--green2);
               border-radius:4px;padding:2px 8px;font-family:var(--sans);text-decoration:none;}

      /* History */
      .hist-row{display:flex;align-items:center;gap:10px;padding:10px 14px;
                border-bottom:1px solid var(--line);}
      .hist-row:last-child{border-bottom:none;}

      /* Empty / waiting */
      .empty,.waiting{text-align:center;padding:48px 20px;color:var(--dim);
                      font-size:14px;display:flex;flex-direction:column;
                      align-items:center;gap:12px;}
      .waiting{border:1px dashed var(--line2);border-radius:var(--r);}

      /* Camera overlay */
      .cam-overlay{position:fixed;inset:0;background:rgba(0,0,0,.93);z-index:100;
                   display:flex;flex-direction:column;align-items:center;
                   justify-content:center;gap:20px;padding:20px;}

      /* Scrollbar */
      ::-webkit-scrollbar{width:4px;height:4px;}
      ::-webkit-scrollbar-track{background:transparent;}
      ::-webkit-scrollbar-thumb{background:var(--line2);border-radius:2px;}
    `}</style>
  );
}
