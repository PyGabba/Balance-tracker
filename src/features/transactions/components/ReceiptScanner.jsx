import { useState, useRef } from "react";
import { IconCamera, IconScan } from "@tabler/icons-react";
import { Camera, CameraResultType } from "@capacitor/camera";
import { toast } from "../../../components/Toast.jsx";
import { t } from "../../../lib/i18n.js";
import { color, alpha, accentGradient, displayFont } from "../../../components/ui/styles.js";

// ─── Receipt Scanner ───
// The OCR pipeline (preprocessing, Tesseract, text parsing) lives in
// ../receiptOcr.js; this component only handles capture, progress and errors.
export function ReceiptScanner({ onScanComplete, lang = "it" }) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileInputRef = useRef(null);

  async function processImage(imageData) {
    setPreviewUrl(imageData);
    setScanning(true);
    setProgress(0);
    try {
      // Loaded on first scan: keeps the OCR pipeline out of the main bundle.
      const { scanReceipt } = await import("../receiptOcr.js");
      const parsed = await scanReceipt(imageData, { onProgress: p => setProgress(Math.round(p * 100)) });
      onScanComplete(parsed);
      toast(t(lang, parsed.importo == null ? "receipt.noTotal" : "receipt.done"), parsed.importo == null ? "info" : "success");
    } catch (e) {
      console.error("Scan error:", e);
      toast(t(lang, "receipt.error"), "error");
    } finally {
      setScanning(false);
      setPreviewUrl(null);
    }
  }

  async function captureAndScan() {
    let imageData;
    try {
      const permission = await Camera.requestPermissions();
      if (permission.camera) {
        const photo = await Camera.getPhoto({
          // Receipt print is small: keep detail (OCR preprocessing downsizes
          // to a 2400px long edge anyway) and let the camera fix rotation.
          quality: 92,
          width: 2400,
          correctOrientation: true,
          allowEditing: false,
          resultType: CameraResultType.Base64,
        });
        if (photo.base64String) imageData = `data:image/${photo.format || "jpeg"};base64,${photo.base64String}`;
      }
    } catch {
      // Camera not available (web) or cancelled: fall through to file input
    }
    if (!imageData) {
      fileInputRef.current?.click();
      return;
    }
    await processImage(imageData);
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => processImage(ev.target.result);
    reader.onerror = () => toast(t(lang, "receipt.error"), "error");
    reader.readAsDataURL(file);
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        style={{ display: "none" }}
      />
      {!scanning && (
        <button onClick={captureAndScan} style={{
          width: "100%", padding: "14px", border: `2px dashed ${alpha(color.accent, 0.33)}`,
          borderRadius: 14, cursor: "pointer", background: color.surface,
          color: color.accent, fontSize: 14, fontWeight: 700, fontFamily: displayFont,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}>
          <IconCamera size={18} />
          {t(lang, "receipt.scan")}
        </button>
      )}
      {scanning && (
        <div style={{ padding: 20, background: color.surface, borderRadius: 14, textAlign: "center" }}>
          {previewUrl && (
            <img src={previewUrl} alt="" style={{ maxHeight: 120, maxWidth: "100%", borderRadius: 8, opacity: 0.6, marginBottom: 10 }} />
          )}
          <div style={{ display: "flex", justifyContent: "center", color: color.accent, marginBottom: 10 }}><IconScan size={24} /></div>
          <div style={{ fontSize: 14, color: color.accent, marginBottom: 8, fontFamily: displayFont }}>{t(lang, "receipt.analyzing")}</div>
          <div style={{ height: 4, background: color.border, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress}%`, background: accentGradient, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
          <div style={{ fontSize: 11, color: color.textMuted, marginTop: 6, fontFamily: displayFont }}>{progress}%</div>
        </div>
      )}
    </div>
  );
}
