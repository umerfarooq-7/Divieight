import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const MAX_BYTES = 10 * 1024 * 1024;

/** Takes a selfie with the camera, or accepts an uploaded photo. Returns it as a File. */
export function SelfieCapture({ disabled, onCaptured }: { disabled?: boolean; onCaptured: (file: File) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  async function startCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      streamRef.current = stream;
      setCameraOn(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      });
    } catch {
      setError("We couldn't open your camera. You can upload a selfie instead.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  function snap() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        stopCamera();
        onCaptured(new File([blob], `selfie-camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9,
    );
  }

  function pick(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Please choose an image file.");
    if (file.size > MAX_BYTES) return setError("The photo must be 10MB or smaller.");
    setError(null);
    onCaptured(file);
  }

  return (
    <div className="rounded-lg border-2 border-dashed border-border p-6 text-center">
      {cameraOn ? (
        <div className="flex flex-col items-center gap-3">
          <video ref={videoRef} playsInline muted className="max-h-72 w-full max-w-sm rounded-md border border-border bg-black object-cover" />
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={snap} disabled={disabled}>
              Take selfie
            </Button>
            <Button variant="outline" onClick={stopCamera}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-center gap-3">
          <Button onClick={() => void startCamera()} disabled={disabled}>
            Use my camera
          </Button>
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={disabled}>
            Upload a selfie
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Face the camera in good light, without a hat or sunglasses.</p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
