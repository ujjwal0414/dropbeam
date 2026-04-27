import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Peer from "peerjs";

const PEER_CONFIG = {
  host: "0.peerjs.com",
  secure: true,
  port: 443,
  path: "/",
  debug: 1,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],
  },
};

const CHUNK_SIZE = 256 * 1024;
const HIGH_WATER_MARK = 2 * 1024 * 1024;
const HISTORY_LIMIT = 50;

const BTN_PRIMARY =
  "rounded-full bg-emerald-500 px-4 py-2 font-medium text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 hover:bg-emerald-600";
const BTN_SECONDARY =
  "rounded-full border border-slate-200 bg-white px-4 py-2 font-medium text-slate-700 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

const safeGet = (key, fallback = "") => {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const safeSet = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
};

const genRoomCode = () => {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900000;
  return String(n + 100000);
};

const genId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtBytes = (bytes = 0) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const fmtSpeed = (bps = 0) => {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
};

const fmtEta = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
};

const fileIcon = (mime = "") => {
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.includes("pdf")) return "📄";
  if (mime.includes("zip") || mime.includes("rar") || mime.includes("7z")) return "🗜️";
  if (mime.includes("text/")) return "📝";
  return "📦";
};

const fileExtFromMime = (mime = "") => {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg") return "jpg";
  return mime.includes("image/") ? "png" : "bin";
};

const loadHistory = () => {
  try {
    return JSON.parse(safeGet("dropbeam_history", "[]"));
  } catch {
    return [];
  }
};

const trimHistory = (list) => list.slice(0, HISTORY_LIMIT);

const waitForDrain = async (dc) => {
  if (!dc || dc.bufferedAmount <= HIGH_WATER_MARK) return;
  await new Promise((resolve) => {
    const done = () => resolve();
    dc.bufferedAmountLowThreshold = Math.floor(HIGH_WATER_MARK / 2);
    dc.addEventListener("bufferedamountlow", done, { once: true });
    setTimeout(done, 120);
  });
};

export  function DropBeamP2P() {
  const [theme, setTheme] = useState(() => {
    const stored = safeGet("dropbeam_theme", "");
    if (stored) return stored;
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  });
  const [roomCode, setRoomCode] = useState("");
  const [peerReady, setPeerReady] = useState(false);
  const [status, setStatus] = useState("Initializing…");
  const [connectCode, setConnectCode] = useState("");
  const [connected, setConnected] = useState(false);
  const [peerLabel, setPeerLabel] = useState("");
  const [deviceName, setDeviceName] = useState(() => safeGet("dropbeam_name", ""));
  const [editingName, setEditingName] = useState(() => !safeGet("dropbeam_name", ""));
  const [transfers, setTransfers] = useState([]);
  const [history, setHistory] = useState(loadHistory);
  const [tab, setTab] = useState("send");
  const [dragging, setDragging] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");

  const peerRef = useRef(null);
  const connRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const outgoingCancelRef = useRef(new Set());
  const incomingRef = useRef({ currentId: null, files: {} });
  const blobUrlsRef = useRef(new Set());
  const toastTimerRef = useRef(null);

  const activeTransfers = useMemo(() => transfers.filter((t) => t.status === "sending" || t.status === "receiving"), [transfers]);
  const completedTransfers = useMemo(() => transfers.filter((t) => t.status === "done" || t.status === "error"), [transfers]);

  const pushToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 2400);
  }, []);

  const addHistory = useCallback((entry) => {
    setHistory((prev) => {
      const next = trimHistory([entry, ...prev]);
      safeSet("dropbeam_history", JSON.stringify(next));
      return next;
    });
  }, []);

  const updateTransfer = useCallback((id, patch) => {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const addTransfer = useCallback((item) => {
    setTransfers((prev) => [item, ...prev]);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    safeSet("dropbeam_theme", theme);
  }, [theme]);

  useEffect(() => {
    if (deviceName.trim()) safeSet("dropbeam_name", deviceName.trim());
  }, [deviceName]);

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks?.().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    setCameraOpen(false);
    setCameraBusy(false);
  }, []);

  const resetConnection = useCallback((msg = "Disconnected") => {
    setConnected(false);
    setPeerLabel("");
    setStatus(msg);
    connRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
    try {
      connRef.current?.close();
    } catch {
      // ignore
    }
    resetConnection("Disconnected");
  }, [resetConnection]);

  const sendFiles = useCallback(
    async (fileList) => {
      const connection = connRef.current;
      if (!connection?.open || !connected) {
        pushToast("Connect first");
        return;
      }

      for (const file of Array.from(fileList || [])) {
        if (!file) continue;
        const id = genId();
        addTransfer({
          id,
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          direction: "out",
          status: "sending",
          progress: 0,
          speed: 0,
          eta: null,
          url: null,
          error: null,
        });

        try {
          connection.send({ kind: "meta", id, name: file.name, size: file.size, mime: file.type || "application/octet-stream" });
          let offset = 0;
          const startedAt = performance.now();

          while (offset < file.size) {
            if (outgoingCancelRef.current.has(id)) {
              connection.send({ kind: "cancel", id });
              throw new Error("Cancelled");
            }
            await waitForDrain(connection.dataChannel);
            const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            connection.send(chunk);
            offset += chunk.byteLength;
            const progress = Math.min(99, Math.round((offset / file.size) * 100));
            const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.001);
            const speed = offset / elapsed;
            const eta = (file.size - offset) / Math.max(speed, 1);
            updateTransfer(id, { progress, speed, eta });
          }

          connection.send({ kind: "done", id });
          updateTransfer(id, { status: "done", progress: 100, speed: 0, eta: null });
          addHistory({ id, name: file.name, size: file.size, mime: file.type || "application/octet-stream", direction: "out", time: Date.now() });
          pushToast(`Sent ${file.name}`);
        } catch (err) {
          updateTransfer(id, { status: "error", error: err?.message || "Transfer failed" });
        } finally {
          outgoingCancelRef.current.delete(id);
        }
      }
    },
    [addHistory, addTransfer, connected, pushToast, updateTransfer]
  );

  const wireConnection = useCallback(
    (connection) => {
      if (!connection) return;
      connection.on("open", () => {
        if (connRef.current && connRef.current !== connection) {
          try {
            connRef.current.close();
          } catch {
            // ignore
          }
        }
        connRef.current = connection;
        setConnected(true);
        setStatus("Connected");
        connection.send({ kind: "hello", name: deviceName.trim() || roomCode, roomCode });
      });

      connection.on("data", (data) => {
        const isPacket = data && typeof data === "object" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) && !(data instanceof Blob);
        if (isPacket) {
          if (data.kind === "hello") {
            setPeerLabel(data.name || "Peer");
            return;
          }
          if (data.kind === "meta") {
            incomingRef.current.currentId = data.id;
            incomingRef.current.files[data.id] = {
              id: data.id,
              name: data.name,
              size: data.size,
              mime: data.mime,
              received: 0,
              parts: [],
              startedAt: Date.now(),
            };
            addTransfer({
              id: data.id,
              name: data.name,
              size: data.size,
              mime: data.mime,
              direction: "in",
              status: "receiving",
              progress: 0,
              speed: 0,
              eta: null,
              url: null,
              error: null,
            });
            return;
          }
          if (data.kind === "cancel") {
            updateTransfer(data.id, { status: "error", error: "Cancelled by peer" });
            delete incomingRef.current.files[data.id];
            if (incomingRef.current.currentId === data.id) incomingRef.current.currentId = null;
            return;
          }
          if (data.kind === "done") {
            const id = data.id || incomingRef.current.currentId;
            const record = incomingRef.current.files[id];
            if (!record) return;
            const blob = new Blob(record.parts, { type: record.mime || "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            blobUrlsRef.current.add(url);
            const a = document.createElement("a");
            a.href = url;
            a.download = record.name;
            a.rel = "noopener";
            a.click();
            updateTransfer(id, { status: "done", progress: 100, speed: 0, eta: null, url });
            addHistory({ id, name: record.name, size: record.size, mime: record.mime, direction: "in", time: Date.now() });
            delete incomingRef.current.files[id];
            incomingRef.current.currentId = null;
            pushToast(`Received ${record.name}`);
            return;
          }
        }

        const currentId = incomingRef.current.currentId;
        const record = currentId ? incomingRef.current.files[currentId] : null;
        if (!record) return;
        const chunk = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
        if (!chunk) return;

        record.parts.push(chunk);
        record.received += chunk.byteLength;
        const progress = Math.min(99, Math.round((record.received / record.size) * 100));
        const elapsed = Math.max((Date.now() - record.startedAt) / 1000, 0.001);
        const speed = record.received / elapsed;
        const eta = (record.size - record.received) / Math.max(speed, 1);
        updateTransfer(record.id, { progress, speed, eta });
      });

      connection.on("close", () => resetConnection("Disconnected"));
      connection.on("error", (err) => setStatus(`Connection error: ${err?.type || err?.message || "unknown"}`));
    },
    [addHistory, addTransfer, deviceName, pushToast, resetConnection, roomCode, updateTransfer]
  );

  const startPeer = useCallback(
    (id) => {
      try {
        peerRef.current?.destroy();
      } catch {
        // ignore
      }

      const peer = new Peer(id, PEER_CONFIG);
      peerRef.current = peer;

      peer.on("open", (peerId) => {
        setRoomCode(peerId);
        setPeerReady(true);
        setStatus("Ready");
      });

      peer.on("connection", (connection) => {
        if (connRef.current?.open) {
          try {
            connection.close();
          } catch {
            // ignore
          }
          return;
        }
        wireConnection(connection);
      });

      peer.on("error", (err) => {
        if (err?.type === "unavailable-id") {
          setStatus("Room code collision; regenerating…");
          window.setTimeout(() => startPeer(genRoomCode()), 150);
          return;
        }
        setStatus(`Peer error: ${err?.type || err?.message || "unknown"}`);
      });
    },
    [wireConnection]
  );

  useEffect(() => {
    startPeer(genRoomCode());
    return () => {
      try {
        peerRef.current?.destroy();
      } catch {
        // ignore
      }
      stopCamera();
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrlsRef.current.clear();
      clearTimeout(toastTimerRef.current);
    };
  }, [startPeer, stopCamera]);

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
  }, [connected, sendFiles]);

  const connectToPeer = useCallback(() => {
    const id = connectCode.trim();
    if (!peerRef.current || !id || connected) return;
    setStatus("Connecting…");
    const connection = peerRef.current.connect(id, { reliable: true, serialization: "binary" });
    wireConnection(connection);
  }, [connectCode, connected, wireConnection]);

  const openCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera is not supported in this browser");
      return;
    }
    try {
      setCameraOpen(true);
      setCameraBusy(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play?.();
      }
      setCameraBusy(false);
    } catch {
      setCameraBusy(false);
      setCameraOpen(false);
      setStatus("Camera permission denied");
    }
  }, []);

  const capturePhoto = useCallback(async () => {
    const stream = cameraStreamRef.current;
    const video = videoRef.current;
    const track = stream?.getVideoTracks?.()?.[0];
    if (!track) return;

    try {
      setCameraBusy(true);
      let blob = null;
      if (window.ImageCapture) {
        const capture = new window.ImageCapture(track);
        blob = await capture.takePhoto();
      } else if (video) {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1920;
        canvas.height = video.videoHeight || 1080;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
        blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      }
      if (!blob) throw new Error("Capture failed");
      const file = new File([blob], `camera_${Date.now()}.${fileExtFromMime(blob.type)}`, { type: blob.type || "image/png" });
      await sendFiles([file]);
      stopCamera();
    } catch (err) {
      setStatus(err?.message || "Camera capture failed");
    } finally {
      setCameraBusy(false);
    }
  }, [sendFiles, stopCamera]);

  const copyRoomCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
      pushToast("Room code copied");
    } catch {
      pushToast("Copy failed");
    }
  }, [pushToast, roomCode]);

  const shareRoomCode = useCallback(async () => {
    const text = `Join my DropBeam room: ${roomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "DropBeam room code", text });
        return;
      } catch {
        // fall back to copy
      }
    }
    copyRoomCode();
  }, [copyRoomCode, roomCode]);

  const saveName = useCallback(() => {
    const next = deviceName.trim().slice(0, 32);
    setDeviceName(next);
    setEditingName(false);
    safeSet("dropbeam_name", next);
    if (connRef.current?.open) connRef.current.send({ kind: "hello", name: next || roomCode, roomCode });
  }, [deviceName, roomCode]);

  const cancelTransfer = useCallback((id) => {
    outgoingCancelRef.current.add(id);
    updateTransfer(id, { status: "error", error: "Cancelled" });
  }, [updateTransfer]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    safeSet("dropbeam_history", "[]");
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="sticky top-0 z-20 mb-4 rounded-3xl border border-slate-200/70 bg-white/80 px-4 py-3 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-950/75">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-500/10 text-lg font-semibold text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300">
                ⇄
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight">DropBeam</h1>
                <p className="text-xs text-slate-500 dark:text-slate-400">Direct browser-to-browser file sharing over WebRTC</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge dotClass={peerReady ? "bg-emerald-500" : "bg-amber-500"}>
                {peerReady ? "Peer ready" : "Starting up"}
              </Badge>
              <Badge dotClass={connected ? "bg-emerald-500" : "bg-slate-400"}>
                {connected ? `Connected to ${peerLabel || "peer"}` : status}
              </Badge>
              <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} className={BTN_SECONDARY}>
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </button>
            </div>
          </div>
        </header>

        <main className="grid flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="flex flex-col gap-4">
            <Card title="Your room code">
              <div className="flex items-center justify-between gap-3">
                <div className="font-mono text-3xl tracking-[0.35em] text-emerald-600 dark:text-emerald-300">{roomCode || "------"}</div>
                <div className="flex gap-2">
                  <button onClick={copyRoomCode} className={`${BTN_SECONDARY} text-xs sm:text-sm`}>{copied ? "Copied" : "Copy"}</button>
                  <button onClick={shareRoomCode} className={`${BTN_SECONDARY} text-xs sm:text-sm`}>Share</button>
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Share this code with exactly one nearby device. No public broadcast list.</p>
            </Card>

            <Card title="Device name">
              {editingName ? (
                <div className="flex gap-2">
                  <input
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveName()}
                    placeholder="e.g. Ujjwal’s Phone"
                    maxLength={32}
                    className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none transition focus:border-emerald-500 focus:bg-white dark:border-slate-800 dark:bg-slate-900 dark:focus:bg-slate-950"
                  />
                  <button onClick={saveName} className={`${BTN_PRIMARY} text-sm`}>Save</button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{deviceName || "This device"}</span>
                  <button onClick={() => setEditingName(true)} className={`${BTN_SECONDARY} text-xs sm:text-sm`}>Edit</button>
                </div>
              )}
            </Card>

            <Card title="Connect to peer">
              {connected ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 dark:bg-emerald-400/10">
                    <span className="min-w-0 truncate text-sm">{peerLabel || connectCode || "Peer"}</span>
                    <button onClick={disconnect} className={`${BTN_SECONDARY} text-xs sm:text-sm`}>Disconnect</button>
                  </div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">A single encrypted WebRTC channel is active. New incoming requests are rejected until you disconnect.</p>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input
                      value={connectCode}
                      onChange={(e) => setConnectCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      onKeyDown={(e) => e.key === "Enter" && connectToPeer()}
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="6-digit code"
                      className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono tracking-[0.35em] outline-none transition focus:border-emerald-500 focus:bg-white dark:border-slate-800 dark:bg-slate-900 dark:focus:bg-slate-950"
                    />
                    <button onClick={connectToPeer} disabled={!peerReady || connectCode.length !== 6} className={BTN_PRIMARY}>Link</button>
                  </div>
                  <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Same Wi‑Fi is fastest, but the direct encrypted channel also works across networks.</p>
                </>
              )}
            </Card>

            <Card title="Mode">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-slate-600 dark:text-slate-300">Appearance</span>
                <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} className={BTN_SECONDARY}>
                  {theme === "dark" ? "Dark" : "Light"}
                </button>
              </div>
            </Card>
          </aside>

          <section className="flex min-w-0 flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
            {!connected ? (
              <EmptyState roomCode={roomCode} />
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-slate-200 pb-3 dark:border-slate-800">
                  <TabButton active={tab === "send"} onClick={() => setTab("send")} label="Send" count={activeTransfers.length} />
                  <TabButton active={tab === "history"} onClick={() => setTab("history")} label="History" count={history.length} />
                </div>

                {tab === "send" ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-4">
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragging(false);
                        sendFiles(e.dataTransfer.files);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                      className={`cursor-pointer rounded-3xl border-2 border-dashed p-6 text-center transition ${dragging ? "border-emerald-500 bg-emerald-500/5" : "border-slate-200 bg-slate-50 hover:border-emerald-400 dark:border-slate-800 dark:bg-slate-900/60"}`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          sendFiles(e.target.files || []);
                          e.target.value = "";
                        }}
                      />
                      <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-white text-2xl shadow-sm dark:bg-slate-900">{dragging ? "📬" : "📂"}</div>
                      <h2 className="text-base font-semibold">Drop files here</h2>
                      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Files are transferred as raw chunks — no recompression, no upload, no server-side storage.</p>
                      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">You can also paste files directly or browse from your device.</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <ActionCard icon="📷" label="Open Camera" onClick={openCamera} />
                      <ActionCard icon="🗂️" label="Browse" onClick={() => fileInputRef.current?.click()} />
                      <ActionCard icon="📋" label="Paste" onClick={() => pushToast("Use Ctrl/Cmd+V")} />
                    </div>

                    {activeTransfers.length > 0 && (
                      <SectionBlock title="Active transfers">
                        {activeTransfers.map((t) => (
                          <TransferRow key={t.id} item={t} onCancel={t.status === "sending" ? () => cancelTransfer(t.id) : undefined} />
                        ))}
                      </SectionBlock>
                    )}

                    {completedTransfers.length > 0 && (
                      <SectionBlock title="Completed / failed">
                        {completedTransfers.map((t) => (
                          <TransferRow key={t.id} item={t} compact />
                        ))}
                      </SectionBlock>
                    )}

                    {transfers.length === 0 && (
                      <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center dark:border-slate-800 dark:bg-slate-900/40">
                        <div>
                          <div className="text-4xl">🚀</div>
                          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">No transfers yet. Send something to start.</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <HistoryPanel history={history} onClear={clearHistory} />
                )}
              </>
            )}
          </section>
        </main>
      </div>

      {cameraOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl overflow-hidden rounded-3xl border border-slate-800 bg-slate-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">Open Camera</h3>
                <p className="text-xs text-slate-400">Capture a photo and send it directly.</p>
              </div>
              <button onClick={stopCamera} className={`${BTN_SECONDARY} text-xs sm:text-sm`}>Close</button>
            </div>
            <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_220px]">
              <div className="overflow-hidden rounded-2xl border border-slate-800 bg-black">
                <video ref={videoRef} autoPlay playsInline muted className="aspect-video w-full object-cover" />
              </div>
              <div className="flex flex-col justify-between gap-3">
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
                  {cameraBusy ? "Preparing camera…" : "Uses native still capture when available. Fallback saves a lossless PNG snapshot."}
                </div>
                <button onClick={capturePhoto} disabled={cameraBusy} className={`${BTN_PRIMARY} w-full py-3 text-sm`}>
                  {cameraBusy ? "Working…" : "Capture & Send"}
                </button>
                <button onClick={stopCamera} className={`${BTN_SECONDARY} w-full py-3 text-sm`}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm shadow-lg dark:border-slate-800 dark:bg-slate-900">{toast}</div>}
    </div>
  );
}

function Badge({ dotClass, children }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-100 px-3 py-1.5 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
      <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
      {children}
    </span>
  );
}

function Card({ title, children }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">{title}</div>
      {children}
    </section>
  );
}

function SectionBlock({ title, children }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function TabButton({ active, onClick, label, count }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
        active ? "bg-emerald-500 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {label}
      {!!count && <span className={`rounded-full px-2 py-0.5 text-xs ${active ? "bg-white/20" : "bg-white/70 dark:bg-slate-700"}`}>{count}</span>}
    </button>
  );
}

function ActionCard({ icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-700 transition hover:border-emerald-400 hover:bg-emerald-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span className="text-base">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function EmptyState({ roomCode }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center dark:border-slate-800 dark:bg-slate-900/40">
      <div className="max-w-md">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-white text-2xl shadow-sm dark:bg-slate-900">📡</div>
        <h2 className="mt-4 text-xl font-semibold">Waiting for a peer</h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Enter the 6-digit code from the other device. Once connected, files move directly browser-to-browser through an encrypted WebRTC channel.
        </p>
        {roomCode && <div className="mt-6 font-mono text-3xl tracking-[0.35em] text-emerald-500">{roomCode}</div>}
      </div>
    </div>
  );
}

function TransferRow({ item, onCancel }) {
  const live = item.status === "sending" || item.status === "receiving";
  const err = item.status === "error";
  const done = item.status === "done";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-xl">{fileIcon(item.mime)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</div>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.direction === "out" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-sky-500/10 text-sky-600 dark:text-sky-300"}`}>
              {item.direction === "out" ? "Send" : "Recv"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{fmtBytes(item.size)}</span>
            {live && item.speed > 0 && <span>{fmtSpeed(item.speed)}</span>}
            {live && item.eta != null && <span>ETA {fmtEta(item.eta)}</span>}
            {err && <span className="text-rose-500">{item.error}</span>}
          </div>
        </div>
        {onCancel && (
          <button onClick={onCancel} className="rounded-full px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-rose-500 dark:hover:bg-slate-900">
            Cancel
          </button>
        )}
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-full transition-all ${err ? "bg-rose-500" : done ? "bg-emerald-500" : "bg-emerald-400"}`} style={{ width: `${err ? 100 : item.progress || 0}%` }} />
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{done ? "Completed" : err ? "Failed" : `${item.progress || 0}%`}</span>
        {done && item.url && (
          <a href={item.url} download={item.name} className="text-emerald-600 hover:underline dark:text-emerald-300">
            Download again
          </a>
        )}
      </div>
    </div>
  );
}

function HistoryPanel({ history, onClear }) {
  if (!history.length) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center dark:border-slate-800 dark:bg-slate-900/40">
        <div className="text-sm text-slate-500 dark:text-slate-400">No history yet.</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Transfer history</div>
        <button onClick={onClear} className={BTN_SECONDARY + " text-xs"}>Clear all</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-3xl border border-slate-200 dark:border-slate-800">
        {history.map((h) => (
          <div key={h.id} className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 last:border-b-0 dark:border-slate-800">
            <div className="text-lg">{fileIcon(h.mime)}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{h.name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {fmtBytes(h.size)} · {h.direction === "out" ? "Sent" : "Received"}
              </div>
            </div>
            <div className="text-xs text-slate-400">{new Date(h.time).toLocaleTimeString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
