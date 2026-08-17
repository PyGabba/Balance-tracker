import { useState, useRef } from "react";
import { Camera } from "@capacitor/camera";
import Tesseract from "tesseract.js";
import { parseReceiptText } from "../helpers.js";

// ─── Receipt Scanner ───
export function ReceiptScanner({ onScanComplete }) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileInputRef = useRef(null);

  async function processImage(imageData) {
    setPreviewUrl(imageData);
    setScanning(true);
    setProgress(10);

    const result = await Tesseract.recognize(imageData, "eng+ita", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setProgress(Math.round(m.progress * 80) + 10);
        }
      },
    });

    setProgress(90);
    const text = result.data.text;
    const parsed = parseReceiptText(text);

    setProgress(100);
    setTimeout(() => {
      setScanning(false);
      setPreviewUrl(null);
      onScanComplete(parsed);
    }, 500);
  }

  async function captureAndScan() {
    try {
      let imageData;

      try {
        const permission = await Camera.requestPermissions();
        if (permission.camera) {
          const photo = await Camera.getPhoto({
            quality: 80,
            allowEditing: false,
            resultType: "base64",
          });
          if (photo.base64String) {
            imageData = `data:image/jpeg;base64,${photo.base64String}`;
          }
        }
      } catch (e) {
        // Camera not available, fall through to file input
      }

      if (!imageData) {
        fileInputRef.current?.click();
        return;
      }

      await processImage(imageData);
    } catch (e) {
      console.error("Scan error:", e);
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      await processImage(ev.target.result);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
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
      {!scanning && !previewUrl && (
        <button onClick={captureAndScan} style={{
          width: "100%", padding: "14px", border: "2px dashed #6C5CE755",
          borderRadius: 14, cursor: "pointer", background: "#1a1a28",
          color: "#a78bfa", fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans',sans-serif",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}>
          <span style={{ fontSize: 18 }}>📷</span>
          Scansiona scontrino
        </button>
      )}
      {scanning && (
        <div style={{ padding: 20, background: "#1a1a28", borderRadius: 14, textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>🔍</div>
          <div style={{ fontSize: 14, color: "#a78bfa", marginBottom: 8, fontFamily: "'DM Sans',sans-serif" }}>Analisi scontrino...</div>
          <div style={{ height: 4, background: "#252538", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, #6C5CE7, #a78bfa)", borderRadius: 2, transition: "width 0.3s" }} />
          </div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 6, fontFamily: "'DM Sans',sans-serif" }}>{progress}%</div>
        </div>
      )}
      {previewUrl && !scanning && (
        <div style={{ marginBottom: 16 }}>
          <img src={previewUrl} alt="Receipt" style={{ width: "100%", borderRadius: 12, opacity: 0.7 }} />
        </div>
      )}
    </div>
  );
}
