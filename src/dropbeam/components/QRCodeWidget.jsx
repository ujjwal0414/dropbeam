import { QRCodeSVG } from "qrcode.react";

export function QRCodeWidget({ code }) {
  return (
    <div className="flex flex-col items-center bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
      <span className="text-sm text-gray-500 dark:text-gray-400 mb-2 font-semibold tracking-wider uppercase">Pairing Code</span>
      <div className="bg-white p-2 rounded-lg">
        <QRCodeSVG value={code} size={160} level="H" includeMargin={true} />
      </div>
      <h2 className="mt-4 font-mono text-3xl font-bold tracking-widest text-indigo-600 dark:text-indigo-400">
        {code}
      </h2> 
    </div>
  );
}