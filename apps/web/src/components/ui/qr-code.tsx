/** QR codes, drawn in the browser (`qrcode`), so the encoded link never leaves the page. */
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button } from './button.tsx';
import { Dialog, DialogContent, DialogTrigger } from './dialog.tsx';

/** `value` as a QR code image; dark modules on white in both themes, as scanners expect. */
export function QrCode({ value, label, size = 224 }: { value: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(value, { margin: 2, width: size * 2 }).then((url) => live && setSrc(url));
    return () => {
      live = false;
    };
  }, [value, size]);
  return src ? (
    <img src={src} alt={label} width={size} height={size} className="rounded-lg" />
  ) : (
    <div role="img" aria-label={label} style={{ width: size, height: size }} className="rounded-lg bg-surface-2" />
  );
}

/** A small "QR" button that opens `value` as a QR code in a dialog, to scan with a phone. */
export function QrButton({ value, title }: { value: string; title: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" aria-label={`QR code: ${title}`}>
          QR
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description="Scan with your phone’s camera.">
        <div className="grid justify-items-center gap-3">
          <div className="rounded-xl bg-white p-2">
            <QrCode value={value} label={`QR code for ${title}`} />
          </div>
          <p className="w-full truncate text-center font-mono text-xs text-ink-3">{value}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
