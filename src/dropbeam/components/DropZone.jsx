import { useRef, useState } from 'react';

export function DropZone({ onSendFiles }) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraActive, setCameraActive] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) onSendFiles(Array.from(e.dataTransfer.files));
  };

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraActive(true);
    } catch (e) { alert("Camera access denied"); }
  };

  const takePhoto = () => {
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext("2d").drawImage(v, 0, 0);
    canvas.toBlob(blob => {
      onSendFiles([new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" })]);
      closeCamera();
    }, "image/jpeg", 0.95);
  };

  const closeCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    setCameraActive(false);
  };

  return (
    <div className="w-full flex flex-col gap-4">
      {cameraActive && (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center p-4">
          <video ref={videoRef} autoPlay playsInline className="rounded-xl w-full max-w-lg border border-gray-700" />
          <div className="flex gap-4 mt-6">
            <button onClick={takePhoto} className="bg-indigo-600 text-white px-6 py-3 rounded-lg font-bold">📸 Capture</button>
            <button onClick={closeCamera} className="bg-gray-800 text-white px-6 py-3 rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      <div 
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer flex flex-col items-center justify-center
          ${dragging ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
        onClick={() => fileRef.current?.click()}
      >
        <span className="text-4xl mb-4">📂</span>
        <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Drop files here to share</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">Any format · Any size · Secure P2P</p>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => onSendFiles(Array.from(e.target.files))} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <button onClick={openCamera} className="py-4 border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition font-medium flex items-center justify-center gap-2 text-gray-800 dark:text-gray-200">
          <span>📷</span> Open Camera
        </button>
        <button onClick={() => fileRef.current?.click()} className="py-4 border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition font-medium flex items-center justify-center gap-2 text-gray-800 dark:text-gray-200">
          <span>🗂</span> Browse Files
        </button>
      </div>
    </div>
  );
}