import { useState, useEffect } from 'react';
import { usePeer } from '../hooks/usePeer';
import { genCode, fmtSize, fmtSpeed } from '../utils/formatters';
import { QRCodeWidget } from '../components/QRCodeWidget.jsx';
import { DropZone } from '../components/DropZone.jsx';

export  function Wrapper() {
  const [myCode] = useState(genCode);
  const [targetCode, setTargetCode] = useState("");
  const [darkMode, setDarkMode] = useState(true);
  const { connected, peerName, transfers, connectTo, disconnect, sendFiles, cancelTransfer } = usePeer(myCode);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors font-sans selection:bg-indigo-500 selection:text-white">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-indigo-500 animate-pulse" />
          <h1 className="font-bold text-xl tracking-tight">DropBeam</h1>
        </div>
        <button onClick={() => setDarkMode(!darkMode)} className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition">
          {darkMode ? '☀️' : '🌙'}
        </button>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-8 flex flex-col md:flex-row gap-8">
        
        {/* Sidebar (Connection) */}
        <aside className="w-full md:w-80 flex flex-col gap-6 shrink-0">
          {!connected ? (
            <>
              <QRCodeWidget code={myCode} />
              <div className="bg-white dark:bg-gray-800 p-5 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3 block">Connect to Peer</label>
                <div className="flex gap-2">
                  <input 
                    value={targetCode} onChange={(e) => setTargetCode(e.target.value.toUpperCase())}
                    placeholder="ENTER CODE" maxLength={6}
                    className="flex-1 bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 font-mono font-bold focus:ring-2 focus:ring-indigo-500 outline-none" 
                  />
                  <button onClick={() => connectTo(targetCode)} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold transition">
                    Link
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-indigo-600 text-white p-6 rounded-xl shadow-lg border border-indigo-500">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-200 block mb-2">Connected To</span>
              <div className="text-2xl font-bold mb-4">{peerName}</div>
              <button onClick={disconnect} className="w-full bg-indigo-800 hover:bg-indigo-900 text-white py-2 rounded-lg font-semibold transition text-sm">
                Disconnect
              </button>
            </div>
          )}
        </aside>

        {/* Main Content (Transfers) */}
        <section className="flex-1 flex flex-col gap-6">
          {!connected ? (
            <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-2xl p-12 text-center text-gray-500">
              <span className="text-5xl mb-4 opacity-50">📡</span>
              <h2 className="text-xl font-bold text-gray-700 dark:text-gray-300 mb-2">Waiting for connection</h2>
              <p className="max-w-xs text-sm">Share your code/QR with a peer, or enter their code in the sidebar to begin.</p>
            </div>
          ) : (
            <>
              <DropZone onSendFiles={sendFiles} />
              
              {transfers.length > 0 && (
                <div className="flex flex-col gap-3 mt-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Transfer Activity</h3>
                  {transfers.map(t => (
                    <div key={t.id} className="bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col gap-3 shadow-sm">
                      <div className="flex justify-between items-start">
                        <div className="flex flex-col overflow-hidden mr-4">
                          <span className="font-semibold text-gray-800 dark:text-gray-100 truncate">{t.name}</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-1">
                            {fmtSize(t.size)} · {t.dir === 'in' ? '↓ Receiving' : '↑ Sending'}
                          </span>
                        </div>
                        {!t.done && !t.error && (
                          <button onClick={() => cancelTransfer(t.id)} className="text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 p-2 rounded-lg text-xs font-bold transition">
                            Cancel
                          </button>
                        )}
                      </div>
                      
                      <div className="w-full bg-gray-100 dark:bg-gray-900 h-2 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all duration-300 ${t.error ? 'bg-red-500' : t.done ? 'bg-green-500' : 'bg-indigo-500'}`} 
                          style={{ width: `${t.error ? 100 : t.progress}%` }} 
                        />
                      </div>
                      
                      <div className="flex justify-between text-xs font-mono text-gray-500 dark:text-gray-400">
                        <span>{t.error ? 'Cancelled' : t.done ? 'Complete' : t.speed ? fmtSpeed(t.speed) : 'Starting...'}</span>
                        <span className={t.done ? 'text-green-500 font-bold' : ''}>{t.progress}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}