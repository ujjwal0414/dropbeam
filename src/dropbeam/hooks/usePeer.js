import { useState, useEffect, useRef, useCallback } from 'react';
import Peer from 'peerjs';

const CHUNK_SIZE = 64 * 1024; // 64KB
const MAX_BUFFER = 1024 * 1024; // 1MB

export function usePeer(myCode) {
  const [peerReady, setPeerReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [peerName, setPeerName] = useState("");
  const [transfers, setTransfers] = useState([]);
  
  const peerRef = useRef(null);
  const connRef = useRef(null);
  const incomingRef = useRef({});
  const cancelRef = useRef(new Set());

  // Strict Lifecycle Management
  useEffect(() => {
    if (!myCode) return;
    const peer = new Peer(myCode, { secure: true });
    
    peer.on('open', () => setPeerReady(true));
    peer.on('connection', setupConn);
    peerRef.current = peer;

    const handleUnload = () => peer.destroy();
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      peer.destroy();
    };
  }, [myCode]);

  const setupConn = useCallback((conn) => {
    conn.on('open', () => {
      connRef.current = conn;
      setConnected(true);
      conn.send({ type: 'hello', name: 'Peer' });
    });

    conn.on('data', (data) => {
      if (data.type === 'hello') setPeerName(data.name || 'Anonymous');
      else if (data.type === 'meta') {
        const id = `${data.name}_${Date.now()}`;
        incomingRef.current[data.name] = { ...data, id, chunks: [], received: 0, start: Date.now() };
        setTransfers(p => [{ id, name: data.name, size: data.size, type: data.mime, progress: 0, dir: 'in', done: false }, ...p]);
      } 
      else if (data.type === 'chunk') {
        const meta = incomingRef.current[data.name];
        if (!meta) return;
        meta.chunks.push(data.chunk);
        meta.received += data.chunk.byteLength;
        
        const progress = Math.round((meta.received / meta.size) * 100);
        const speed = meta.received / ((Date.now() - meta.start) / 1000 || 1);
        setTransfers(p => p.map(t => t.id === meta.id ? { ...t, progress, speed } : t));
      } 
      else if (data.type === 'done') {
        const meta = incomingRef.current[data.name];
        const blobUrl = URL.createObjectURL(new Blob(meta.chunks, { type: meta.mime }));
        const a = document.createElement("a");
        a.href = blobUrl; a.download = meta.name; a.click();
        
        setTransfers(p => p.map(t => t.id === meta.id ? { ...t, progress: 100, done: true, blobUrl } : t));
        delete incomingRef.current[data.name];
      }
    });

    conn.on('close', disconnect);
    conn.on('error', disconnect);
  }, []);

  const connectTo = (code) => {
    if (!peerRef.current || connected) return;
    const conn = peerRef.current.connect(code, { reliable: true });
    setupConn(conn);
  };

  const disconnect = () => {
    connRef.current?.close();
    connRef.current = null;
    setConnected(false);
    setPeerName("");
  };

  const sendFiles = async (files) => {
    const conn = connRef.current;
    if (!conn) return;

    for (const file of files) {
      const id = `${file.name}_${Date.now()}`;
      setTransfers(p => [{ id, name: file.name, size: file.size, type: file.type, progress: 0, dir: 'out', done: false }, ...p]);
      
      conn.send({ type: 'meta', name: file.name, size: file.size, mime: file.type });
      
      const buffer = await file.arrayBuffer();
      const start = Date.now();
      let offset = 0;
      let cancelled = false;

      while (offset < buffer.byteLength) {
        if (cancelRef.current.has(id)) { cancelled = true; break; }
        // Backpressure implementation
        while (conn.dataChannel?.bufferedAmount > MAX_BUFFER) await new Promise(r => setTimeout(r, 20));
        
        const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
        conn.send({ type: 'chunk', name: file.name, chunk });
        offset += chunk.byteLength;
        
        const progress = Math.round((offset / buffer.byteLength) * 100);
        const speed = offset / ((Date.now() - start) / 1000 || 1);
        setTransfers(p => p.map(t => t.id === id ? { ...t, progress, speed } : t));
      }

      if (cancelled) setTransfers(p => p.map(t => t.id === id ? { ...t, error: true } : t));
      else {
        conn.send({ type: 'done', name: file.name });
        setTransfers(p => p.map(t => t.id === id ? { ...t, progress: 100, done: true } : t));
      }
    }
  };

  const cancelTransfer = (id) => cancelRef.current.add(id);

  return { peerReady, connected, peerName, transfers, connectTo, disconnect, sendFiles, cancelTransfer };
}