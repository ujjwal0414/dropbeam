export const fmtSize = (b) => {
  if (!b) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};

export const fmtSpeed = (bps) => bps < 1024 ** 2 
  ? `${(bps / 1024).toFixed(0)} KB/s` 
  : `${(bps / 1024 ** 2).toFixed(1)} MB/s`;

export const genCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();