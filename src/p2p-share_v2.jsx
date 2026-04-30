import { useState, useEffect, useRef, useCallback } from "react";
import Peer from "peerjs";

// ── Constants ────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFER = 1024 * 1024;

// ── Helpers ──────────────────────────────────────────────────────────────────
const genCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

const fmtSize = (b) => {
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
  if (mime.includes("pdf")) return "📄";
  if (mime.includes("zip") || mime.includes("rar")) return "🗜";
  if (mime.includes("text")) return "📝";
  return "📦";
};


export function DropBeamv2() {
  const [myCode, setMyCode] = useState("");
  const [peerReady, setPeerReady] = useState(false);
  const [connCode, setConnCode] = useState("");
  const [conn, setConn] = useState(null);
  const [connected, setConnected] = useState(false);
  const [peerName, setPeerName] = useState("");

  const [myName, setMyName] = useState(() => localStorage.getItem("db_name") || "");
  const [editingName, setEditingName] = useState(!localStorage.getItem("db_name"));

  const [transfers, setTransfers] = useState([]);

  const [dragging, setDragging] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("send");
  const [copied, setCopied] = useState(false);
  const [statusMsg, setStatusMsg] = useState("Initializing…");

  const [history, setHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("db_history") || "[]");
    } catch {
      return [];
    }
  });

  const peerRef = useRef(null);
  const incomingRef = useRef({});
  const cancelRef = useRef(new Set());
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  const addHistory = (entry) => {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 60);
      localStorage.setItem("db_history", JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    const code = genCode();
    setMyCode(code);

    (() => {
      const peer = new Peer(code, {
        host: "0.peerjs.com",
        port: 443,
        path: "/",
        secure: true,
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:global.stun.twilio.com:3478" },
            {
              urls:process.env.VITE_TURN_MAIL,
              username:process.env.VITE_TURN_PASS,
              credential:process.env.VITE_TURN_USERNAME
            }
          ],
        },
      });

      peer.on("open", () => {
        setPeerReady(true);
        setStatusMsg("Ready");
      });
      peer.on("connection", (c) => setupConn(c));
      peer.on("error", (e) => {setStatusMsg(`Error: ${e.type}`);console.log(e);
      });
      peerRef.current = peer;
    })();

    return () => peerRef.current?.destroy();

  }, []);

  useEffect(() => {
    const onPaste = (e) => {
      if (!connected) return;
      const files = Array.from(e.clipboardData?.items || [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter(Boolean);
      if (files.length) sendFiles(files);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [connected]);

  const setupConn = useCallback(
    (c) => {
      c.on("open", () => {
        setConn(c);
        setConnected(true);
        setStatusMsg("Connected");
        c.send({ type: "hello", name: localStorage.getItem("db_name") || myCode });
      });

      c.on("data", (data) => {
        if (data.type === "hello") {
          setPeerName(data.name);
          return;
        }

        if (data.type === "meta") {
          const id = `${data.name}_${Date.now()}`;
          incomingRef.current[data.name] = {
            id,
            name: data.name,
            size: data.size,
            mime: data.mime,
            chunks: [],
            received: 0,
            startTime: Date.now(),
          };

          setTransfers((p) => [
            {
              id,
              name: data.name,
              size: data.size,
              mime: data.mime,
              progress: 0,
              done: false,
              error: null,
              direction: "in",
              speed: 0,
              eta: null,
              blobUrl: null,
            },
            ...p,
          ]);
          return;
        }

        if (data.type === "chunk") {
          const e = incomingRef.current[data.name];
          if (!e) return;
          e.chunks.push(data.chunk);
          e.received += data.chunk.byteLength;

          const progress = Math.round((e.received / e.size) * 100);
          const elapsed = (Date.now() - e.startTime) / 1000 || 1;
          const speed = e.received / elapsed;
          const eta = Math.ceil((e.size - e.received) / speed);

          setTransfers((p) => p.map((t) => (t.id === e.id ? { ...t, progress, speed, eta } : t)));
          return;
        }

        if (data.type === "done") {
          const e = incomingRef.current[data.name];
          if (!e) return;

          const blob = new Blob(e.chunks, { type: e.mime });
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = e.name;
          a.click();

          setTransfers((p) =>
            p.map((t) =>
              t.id === e.id ? { ...t, progress: 100, done: true, speed: 0, eta: null, blobUrl } : t,
            ),
          );
          addHistory({ name: e.name, size: e.size, mime: e.mime, direction: "in", time: Date.now() });
          delete incomingRef.current[data.name];
        }
      });

      c.on("close", () => {
        setConnected(false);
        setConn(null);
        setPeerName("");
        setStatusMsg("Disconnected");
      });

      c.on("error", (e) => setStatusMsg(`Error: ${e}`));
    },
    [myCode],
  );

  const connectToPeer = () => {
    if (!peerRef.current || !connCode.trim() || connected) return;
    setStatusMsg("Connecting…");
    const c = peerRef.current.connect(connCode.trim().toUpperCase(), { reliable: true });
    setupConn(c);
  };

  const sendFiles = useCallback(
    async (filesToSend) => {
      if (!conn || !connected) return;

      for (const file of filesToSend) {
        const id = `${file.name}_${Date.now()}`;

        setTransfers((p) => [
          {
            id,
            name: file.name,
            size: file.size,
            mime: file.type,
            progress: 0,
            done: false,
            error: null,
            direction: "out",
            speed: 0,
            eta: null,
            blobUrl: null,
          },
          ...p,
        ]);

        conn.send({ type: "meta", name: file.name, size: file.size, mime: file.type });
        const buffer = await file.arrayBuffer();
        const startTime = Date.now();
        let offset = 0;
        let cancelled = false;

        while (offset < buffer.byteLength) {
          if (cancelRef.current.has(id)) {
            cancelled = true;
            break;
          }

          while (conn.dataChannel?.bufferedAmount > MAX_BUFFER) {
            await new Promise((r) => setTimeout(r, 30));
          }

          const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
          conn.send({ type: "chunk", name: file.name, chunk: buffer.slice(offset, end) });
          offset = end;

          const progress = Math.round((offset / buffer.byteLength) * 100);
          const elapsed = (Date.now() - startTime) / 1000 || 1;
          const speed = offset / elapsed;
          const eta = Math.ceil((buffer.byteLength - offset) / speed);
          setTransfers((p) => p.map((t) => (t.id === id ? { ...t, progress, speed, eta } : t)));
        }

        if (cancelled) {
          setTransfers((p) => p.map((t) => (t.id === id ? { ...t, error: "Cancelled" } : t)));
        } else {
          conn.send({ type: "done", name: file.name });
          setTransfers((p) => p.map((t) => (t.id === id ? { ...t, progress: 100, done: true, speed: 0, eta: null } : t)));
          addHistory({ name: file.name, size: file.size, mime: file.type, direction: "out", time: Date.now() });
        }
      }
    },
    [conn, connected],
  );

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 4096 }, height: { ideal: 2160 } },
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOpen(true);
    } catch {
      setStatusMsg("Camera denied");
    }
  };

  const capturePhoto = () => {
    const v = videoRef.current;
    if (!v) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      sendFiles([new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" })]);
      closeCamera();
    }, "image/jpeg", 1.0);
  };

  const closeCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOpen(false);
  };

  const copyCode = () => {
    navigator.clipboard?.writeText(myCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveName = () => {
    localStorage.setItem("db_name", myName);
    setEditingName(false);
    if (conn && connected) conn.send({ type: "hello", name: myName });
  };

  const activeXfers = transfers.filter((t) => !t.done && !t.error);
  const doneXfers = transfers.filter((t) => t.done || t.error);

  return (
    <div className="min-h-dvh w-full bg-[#0d0d14] font-sans text-[#e8e8f0]">
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[#0d0d14]/95 px-[4vw] py-[1.4dvh] backdrop-blur-sm">
          <span className="flex min-w-0 items-center gap-2 text-base font-bold tracking-[-0.02em] sm:text-lg">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${peerReady ? "bg-[#39e8a0]" : "animate-pulse bg-[#e8a039]"}`}
            />
            <span className="truncate">DropBeam</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[0.72rem] text-white/30 sm:text-xs">
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${connected ? "animate-pulse bg-[#39e8a0]" : "bg-white/25"}`} />
            <span className="truncate">{connected ? (peerName ? `↔ ${peerName}` : "Connected") : statusMsg}</span>
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          <aside className="grid shrink-0 gap-4 border-b border-white/10 px-[4vw] py-[2.2dvh] sm:grid-cols-2 lg:flex lg:w-[24vw] lg:flex-col lg:border-b-0 lg:border-r lg:border-white/10 lg:px-[2vw] lg:py-[2.5dvh]">
            <section className="w-full rounded-2xl border border-white/10 bg-[#131320] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.01)]">
              <div className="mb-2 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-white/25">Your code</div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[clamp(1.15rem,4vw,1.75rem)] font-medium tracking-[0.45em] text-[#39e8a0]">
                  {myCode || "------"}
                </span>
                <button
                  className="whitespace-nowrap rounded-xl border border-white/15 bg-transparent px-3 py-2 text-[0.78rem] text-white/45 transition hover:border-white/20 hover:text-white/90"
                  onClick={copyCode}
                >
                  {copied ? "✓" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-[0.78rem] leading-relaxed text-white/30">Share this with another device to receive files.</p>
            </section>

            <section className="w-full rounded-2xl border border-white/10 bg-[#131320] p-4">
              <div className="mb-2 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-white/25">Device name</div>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-xl border border-white/15 bg-[#1a1a2a] px-3 py-2.5 font-mono text-[0.9rem] text-[#e8e8f0] outline-none transition focus:border-[#1ab57c] placeholder:text-white/25"
                    placeholder="e.g. Priya's Phone"
                    value={myName}
                    maxLength={24}
                    onChange={(e) => setMyName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveName()}
                  />
                  <button
                    className="whitespace-nowrap rounded-xl border border-white/15 bg-transparent px-3 py-2 text-[0.8rem] text-white/45 transition hover:border-white/20 hover:text-white/90"
                    onClick={saveName}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[0.92rem] font-medium">{myName || myCode}</span>
                  <button
                    className="whitespace-nowrap rounded-xl border border-white/15 bg-transparent px-3 py-2 text-[0.78rem] text-white/45 transition hover:border-white/20 hover:text-white/90"
                    onClick={() => setEditingName(true)}
                  >
                    Edit
                  </button>
                </div>
              )}
            </section>

            <section className="w-full rounded-2xl border border-white/10 bg-[#131320] p-4">
              <div className="mb-2 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-white/25">Connect to peer</div>
              {connected ? (
                <div className="flex items-center gap-2 rounded-xl border border-[#1ab57c] bg-[#1a1a2a] px-3 py-2.5">
                  <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#39e8a0] animate-pulse" />
                  <span className="min-w-0 flex-1 truncate text-[0.9rem]">{peerName || connCode || "Peer"}</span>
                  <button
                    className="whitespace-nowrap rounded-xl border border-white/15 bg-transparent px-3 py-2 text-[0.78rem] text-white/45 transition hover:border-white/20 hover:text-white/90"
                    onClick={() => {
                      conn?.close();
                      setConnected(false);
                      setConn(null);
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-xl border border-white/15 bg-[#1a1a2a] px-3 py-2.5 font-mono text-[0.95rem] uppercase tracking-[0.28em] text-[#e8e8f0] outline-none transition focus:border-[#1ab57c] placeholder:normal-case placeholder:tracking-normal placeholder:text-white/25"
                      placeholder="Enter code"
                      maxLength={6}
                      value={connCode}
                      onChange={(e) => setConnCode(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === "Enter" && connectToPeer()}
                    />
                    <button
                      className="whitespace-nowrap rounded-xl bg-[#39e8a0] px-4 py-2.5 text-[0.82rem] font-semibold text-black transition hover:bg-[#4ffdb8] disabled:cursor-not-allowed disabled:bg-[#1a1a2a] disabled:text-white/25"
                      onClick={connectToPeer}
                      disabled={!peerReady || !connCode.trim()}
                    >
                      Link →
                    </button>
                  </div>
                  <p className="mt-2 text-[0.78rem] leading-relaxed text-white/30">Same Wi‑Fi is fastest. Cross-network also works.</p>
                </>
              )}
            </section>
          </aside>

          <main className="min-h-0 flex-1 overflow-y-auto px-[4vw] py-[2.2dvh] lg:px-[2.2vw] lg:py-[2.5dvh]">
            {connected ? (
              <div className="flex flex-col gap-5">
                <div className="flex border-b border-white/10">
                  {[
                    ["send", "Send"],
                    ["history", "History"],
                  ].map(([tab, label]) => (
                    <button
                      key={tab}
                      className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-[0.9rem] transition ${activeTab === tab ? "border-[#39e8a0] text-[#39e8a0]" : "border-transparent text-white/45"}`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {label}
                      {tab === "send" && activeXfers.length > 0 && (
                        <span className="rounded-full bg-[#39e8a0] px-2 py-0.5 text-[0.72rem] font-bold text-black">
                          {activeXfers.length}
                        </span>
                      )}
                      {tab === "history" && history.length > 0 && (
                        <span className="text-[0.72rem] text-white/25">{history.length}</span>
                      )}
                    </button>
                  ))}
                </div>

                {activeTab === "send" && (
                  <>
                    <div
                      className={`flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-[5vw] py-[8dvh] text-center transition sm:px-[4vw] ${dragging ? "border-[#1ab57c] bg-[#39e8a0]/5" : "border-white/15 hover:border-[#1ab57c] hover:bg-[#39e8a0]/5"}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragging(false);
                        sendFiles(Array.from(e.dataTransfer.files));
                      }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          sendFiles(Array.from(e.target.files || []));
                          e.target.value = "";
                        }}
                      />
                      <span className="text-[clamp(2.2rem,5vw,3.2rem)]">{dragging ? "📬" : "📂"}</span>
                      <span className="text-[1rem] font-semibold sm:text-[1.05rem]">Drop files here</span>
                      <span className="max-w-[42rem] text-[0.82rem] leading-relaxed text-white/45 sm:text-[0.9rem]">
                        Any format · Any size · Zero compression
                        <br />
                        <span className="text-white/35">or Ctrl+V to paste from clipboard</span>
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <button
                        className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#1a1a2a] p-4 text-[0.85rem] text-white/50 transition hover:border-white/15 hover:text-[#e8e8f0]"
                        onClick={openCamera}
                      >
                        <span className="text-[1.5rem]">📷</span>
                        <span>Camera</span>
                      </button>
                      <button
                        className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#1a1a2a] p-4 text-[0.85rem] text-white/50 transition hover:border-white/15 hover:text-[#e8e8f0]"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <span className="text-[1.5rem]">🗂</span>
                        <span>Browse</span>
                      </button>
                    </div>

                    {activeXfers.length > 0 && (
                      <div className="flex flex-col gap-3">
                        <div className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-white/25">Transferring</div>
                        {activeXfers.map((t) => (
                          <XCard key={t.id} t={t} onCancel={() => cancelRef.current.add(t.id)} />
                        ))}
                      </div>
                    )}

                    {doneXfers.length > 0 && (
                      <div className="flex flex-col gap-3">
                        <div className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-white/25">Completed</div>
                        {doneXfers.map((t) => (
                          <XCard key={t.id} t={t} />
                        ))}
                      </div>
                    )}

                    {transfers.length === 0 && (
                      <div className="flex flex-col items-center gap-3 px-[4vw] py-[8dvh] text-center text-white/25">
                        <div className="text-[2rem]">🚀</div>
                        <div>No transfers yet — beam something!</div>
                      </div>
                    )}
                  </>
                )}

                {activeTab === "history" && (
                  <HistoryTab
                    history={history}
                    onClear={() => {
                      setHistory([]);
                      localStorage.removeItem("db_history");
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-white/15 px-[5vw] py-[10dvh] text-center text-white/25">
                <div className="text-[3rem]">📡</div>
                <strong className="text-[1rem] text-[#e8e8f0]">Waiting for connection</strong>
                <p className="max-w-[20rem] text-[0.85rem] leading-relaxed text-white/45">
                  Enter a peer's code in the sidebar, or share yours so they can connect.
                </p>
                {peerReady && <div className="mt-2 font-mono text-[clamp(1.2rem,4vw,2rem)] tracking-[0.45em] text-[#39e8a0]">{myCode}</div>}
              </div>
            )}
          </main>
        </div>
      </div>

      {cameraOpen && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-black/95 p-[5vw]">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="max-h-[62dvh] max-w-full rounded-2xl border border-white/10"
          />
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              className="rounded-2xl bg-[#39e8a0] px-7 py-3 text-[0.95rem] font-semibold text-black transition hover:bg-[#4ffdb8]"
              onClick={capturePhoto}
            >
              📸 Capture & Send
            </button>
            <button
              className="rounded-2xl border border-white/15 bg-transparent px-6 py-3 text-[0.95rem] text-white/90 transition hover:border-white/20 hover:text-white"
              onClick={closeCamera}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function XCard({ t, onCancel }) {
  const done = t.done;
  const err = !!t.error;
  const live = !done && !err;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#131320] px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[1.2rem]">{fileIcon(t.mime)}</span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.86rem] font-medium" title={t.name}>
          {t.name}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[0.72rem] font-semibold ${t.direction === "out" ? "bg-[#39e8a0]/10 text-[#39e8a0]" : "bg-[#63a0e8]/10 text-[#63a0e8]"}`}
        >
          {t.direction === "out" ? "↑ Send" : "↓ Recv"}
        </span>
        <span className="whitespace-nowrap font-mono text-[0.72rem] text-white/25">{fmtSize(t.size)}</span>
        {live && onCancel && (
          <button
            className="rounded px-1.5 py-0.5 text-[0.8rem] text-white/25 transition hover:text-[#e86060]"
            onClick={onCancel}
            title="Cancel"
          >
            ✕
          </button>
        )}
      </div>

      <div className="h-1 overflow-hidden rounded-sm bg-[#1a1a2a]">
        <div
          className={`h-full rounded-sm transition-all duration-300 ${err ? "bg-[#e86060]" : done ? "bg-[#1ab57c]" : "bg-[#39e8a0]"}`}
          style={{ width: `${err ? 100 : t.progress}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[0.72rem] text-white/45">
          {live && t.speed > 0 && fmtSpeed(t.speed)}
          {live && t.eta > 0 && ` · ${t.eta}s`}
          {err && <span className="text-[#e86060]">{t.error}</span>}
        </span>
        <div className="flex items-center gap-2">
          {done && t.blobUrl && (
            <a
              href={t.blobUrl}
              download={t.name}
              className="rounded-lg border border-[#1ab57c] px-2.5 py-1 text-[0.72rem] text-[#39e8a0] no-underline"
            >
              ↓ Again
            </a>
          )}
          <span className={`font-mono text-[0.78rem] font-medium ${err ? "text-[#e86060]" : done ? "text-[#39e8a0]" : "text-white/45"}`}>
            {err ? "Cancelled" : done ? "✓ Done" : `${t.progress}%`}
          </span>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ history, onClear }) {
  if (!history.length)
    return (
      <div className="flex min-h-[40dvh] flex-col items-center justify-center gap-3 px-[4vw] py-[8dvh] text-center text-white/25">
        <div className="text-[2rem]">📋</div>
        <div>No history yet.</div>
      </div>
    );

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex-1 font-mono text-[0.68rem] uppercase tracking-[0.16em] text-white/25">Transfer history</div>
        <button
          className="whitespace-nowrap rounded-xl border border-white/15 bg-transparent px-3 py-2 text-[0.78rem] text-white/45 transition hover:border-white/20 hover:text-white/90"
          onClick={onClear}
        >
          Clear all
        </button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#131320]">
        {history.map((h, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-white/10 px-4 py-3 last:border-b-0">
            <span className="text-[1.1rem]">{fileIcon(h.mime)}</span>
            <div className="min-w-0 flex-1">
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.86rem] font-medium">{h.name}</div>
              <div className="font-mono text-[0.72rem] text-white/25">
                {fmtSize(h.size)} · {h.direction === "out" ? "Sent" : "Received"}
              </div>
            </div>
            <span className="whitespace-nowrap font-mono text-[0.72rem] text-white/25">
              {new Date(h.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}