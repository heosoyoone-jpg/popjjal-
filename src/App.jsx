/**
 * 🍿 팝짤 (PopJjal) — 내 폰 속 영상·사진이 움짤로 팝!
 * ---------------------------------------------------------
 * Stack   : Vite + React + Tailwind CSS + @ffmpeg/ffmpeg (WASM)
 * 컨셉    : 링크 대신 "내 기기의 영상/사진"을 움짤로 변환
 *  - 영상 모드: 구간(시작/길이) 선택 → GIF
 *  - 사진 모드: 사진 2~10장 → 슬라이드쇼 GIF
 * 모든 변환은 브라우저 안에서만 일어남 (서버 업로드 없음)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

/* ---------------------------------------------------------
 * 상수 & 프리셋
 * ------------------------------------------------------- */
const CORE_VERSION = "0.12.6";
// 싱글스레드 코어 (SharedArrayBuffer 불필요) — 0.12 API는 ESM 빌드 필요!
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

// 용량 최적화 프리셋 — maxSizeMB 초과 시 fps/scale을 낮춰 자동 재시도
const PRESETS = {
  default: { label: "기본 화질", emoji: "🍿", fps: 15, width: 480, maxSizeMB: null },
  insta:   { label: "인스타/스레드용", emoji: "📱", fps: 12, width: 400, maxSizeMB: 15 },
  blog:    { label: "블로그용 (10MB)", emoji: "✍️", fps: 10, width: 360, maxSizeMB: 10 },
};

// 자막 폰트 (전부 SIL OFL 오픈소스 — 상업적 사용 무료)
const FONTS = {
  blackhan: { label: "검은고딕", sample: "임팩트!", family: "'Black Han Sans', sans-serif" },
  dohyeon:  { label: "도현",     sample: "또박또박", family: "'Do Hyeon', sans-serif" },
  gaegu:    { label: "개구",     sample: "귀염뽀짝", family: "'Gaegu', cursive" },
};

const TEXT_COLORS = [
  "#FFFFFF", "#FFD166", "#FF85A1", "#FF3B30",
  "#34C759", "#5AC8FA", "#AF52DE", "#111111",
];

const TEXT_POSITIONS = {
  top:    { label: "⬆️ 상단" },
  middle: { label: "↔️ 중앙" },
  bottom: { label: "⬇️ 하단" },
};

const MAX_PHOTOS = 10;

function outlineFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299*((n>>16)&255) + 0.587*((n>>8)&255) + 0.114*(n&255);
  return lum < 128 ? "#FFFFFF" : "#000000";
}

/* ---------------------------------------------------------
 * 광고 배너 플레이스홀더 (구글 애드센스 자리)
 * ------------------------------------------------------- */
function AdBanner({ label = "AD", height = "h-24" }) {
  return (
    <div
      className={`w-full ${height} rounded-2xl border-4 border-dashed border-[#FFD166]
                  bg-[#FFF8E7] flex flex-col items-center justify-center gap-1
                  text-[#C9A24B] select-none`}
      aria-label="광고 영역"
    >
      <span className="text-2xl">🍿</span>
      <span className="text-xs font-bold tracking-widest">{label} · 광고가 표시될 자리예요</span>
    </div>
  );
}

function PopButton({ children, onClick, disabled, variant = "pink", className = "" }) {
  const base =
    "rounded-2xl px-5 py-3 font-extrabold transition-transform active:scale-95 " +
    "shadow-[0_4px_0_rgba(0,0,0,0.12)] disabled:opacity-40 disabled:cursor-not-allowed";
  const colors =
    variant === "pink"
      ? "bg-[#FF85A1] text-white hover:bg-[#ff6f91]"
      : variant === "yellow"
      ? "bg-[#FFD166] text-[#5A4632] hover:bg-[#ffc94d]"
      : "bg-white text-[#5A4632] border-2 border-[#FFD166]";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${colors} ${className}`}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------
 * 메인 앱
 * ------------------------------------------------------- */
export default function App() {
  /* ----- ffmpeg ----- */
  const ffmpegRef = useRef(new FFmpeg());
  const [ffmpegReady, setFfmpegReady] = useState(false);

  /* ----- 소스: 영상 or 사진 ----- */
  const [mode, setMode] = useState(null); // null | 'video' | 'photos'
  const [videoSrc, setVideoSrc] = useState(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [photos, setPhotos] = useState([]); // [{url, name}]
  const [secPerPhoto, setSecPerPhoto] = useState(1.0);
  const [loadError, setLoadError] = useState("");
  const videoRef = useRef(null);

  /* ----- 영상 타임라인 ----- */
  const [startTime, setStartTime] = useState(0);
  const [clipLength, setClipLength] = useState(3);

  /* ----- 자막 ----- */
  const [overlayText, setOverlayText] = useState("");
  const [fontKey, setFontKey] = useState("blackhan");
  const [textColor, setTextColor] = useState("#FFFFFF");
  const [textPos, setTextPos] = useState("bottom");
  const previewCanvasRef = useRef(null);

  /* ----- 변환 ----- */
  const [preset, setPreset] = useState("default");
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [gifUrl, setGifUrl] = useState(null);
  const [gifSizeMB, setGifSizeMB] = useState(null);

  /* -------------------------------------------------------
   * 1) ffmpeg.wasm 로드 (최초 1회)
   * ----------------------------------------------------- */
  useEffect(() => {
    (async () => {
      const ffmpeg = ffmpegRef.current;
      ffmpeg.on("progress", ({ progress: p }) => {
        setProgress(Math.min(100, Math.round(p * 100)));
      });
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
        });
        setFfmpegReady(true);
      } catch (e) {
        console.error("ffmpeg load failed:", e);
        setLoadError(
          "변환 엔진 로딩에 실패했어요. 인터넷 연결을 확인한 뒤 페이지를 새로고침(F5)해 주세요."
        );
      }
    })();
  }, []);

  /* -------------------------------------------------------
   * 2) 소스 선택
   * ----------------------------------------------------- */
  function loadVideoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    resetResult();
    setPhotos([]);
    setMode("video");
    setVideoSrc(URL.createObjectURL(file));
    e.target.value = "";
  }

  function loadPhotoFiles(e) {
    const files = Array.from(e.target.files || []).slice(0, MAX_PHOTOS);
    if (files.length === 0) return;
    if (files.length < 2) {
      setLoadError("사진은 2장 이상 선택해 주세요! (여러 장을 이어붙여 움짤을 만들어요)");
      e.target.value = "";
      return;
    }
    resetResult();
    setVideoSrc(null);
    setMode("photos");
    setPhotos(files.map((f) => ({ url: URL.createObjectURL(f), name: f.name })));
    e.target.value = "";
  }

  function resetResult() {
    setLoadError("");
    setGifUrl(null);
    setGifSizeMB(null);
  }

  function removePhoto(idx) {
    setPhotos((p) => {
      const next = p.filter((_, i) => i !== idx);
      if (next.length < 2) setMode(null);
      return next;
    });
  }

  function onVideoLoaded(e) {
    const d = e.target.duration || 0;
    setVideoDuration(d);
    setStartTime(0);
    setClipLength(Math.min(3, Math.floor(d) || 3));
  }

  useEffect(() => {
    if (mode === "video" && videoRef.current && Number.isFinite(startTime)) {
      videoRef.current.currentTime = startTime;
    }
  }, [startTime, mode]);

  /* -------------------------------------------------------
   * 3) 자막 그리기 (미리보기·변환 공용)
   * ----------------------------------------------------- */
  function drawOverlayText(ctx, w, h) {
    if (!overlayText.trim()) return;
    const fontSize = Math.max(18, Math.floor(w / 12));
    ctx.font = `${fontSize}px ${FONTS[fontKey].family}`;
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.lineWidth = fontSize / 6;
    ctx.strokeStyle = outlineFor(textColor);
    ctx.fillStyle = textColor;
    const y =
      textPos === "top"    ? fontSize * 1.2 :
      textPos === "middle" ? h / 2 + fontSize * 0.35 :
                             h - fontSize * 0.8;
    ctx.strokeText(overlayText.trim(), w / 2, y);
    ctx.fillText(overlayText.trim(), w / 2, y);
  }

  /* -------------------------------------------------------
   * 4) 실시간 미리보기
   *    영상: 비디오 프레임 + 자막 / 사진: 슬라이드쇼 + 자막
   * ----------------------------------------------------- */
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !mode) return;
    let raf, cancelled = false;

    if (mode === "video") {
      const draw = () => {
        if (cancelled) return;
        const video = videoRef.current;
        const ctx = canvas.getContext("2d");
        if (video && video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          drawOverlayText(ctx, canvas.width, canvas.height);
        }
        raf = requestAnimationFrame(draw);
      };
      draw();
    }

    if (mode === "photos" && photos.length > 0) {
      const imgs = photos.map((p) => {
        const im = new Image();
        im.src = p.url;
        return im;
      });
      const draw = (now) => {
        if (cancelled) return;
        const ctx = canvas.getContext("2d");
        const idx = Math.floor(now / 1000 / secPerPhoto) % imgs.length;
        const im = imgs[idx];
        if (im.complete && im.naturalWidth) {
          canvas.width = 480;
          canvas.height = 360;
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const s = Math.min(canvas.width / im.naturalWidth, canvas.height / im.naturalHeight);
          const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
          ctx.drawImage(im, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
          drawOverlayText(ctx, canvas.width, canvas.height);
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    }

    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [mode, videoSrc, photos, secPerPhoto, overlayText, fontKey, textColor, textPos]);

  /* -------------------------------------------------------
   * 5) 사진 → 균일한 PNG 프레임으로 재인코딩
   *    (HEIC 등 브라우저가 읽은 이미지를 캔버스로 통일 →
   *     크기·포맷 문제 원천 차단, 자막도 이 단계에서 굽기)
   * ----------------------------------------------------- */
  async function renderPhotoFrame(url, w, h) {
    const im = new Image();
    im.src = url;
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; });
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const s = Math.min(w / im.naturalWidth, h / im.naturalHeight);
    const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
    ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
    try { await document.fonts.load(`${Math.floor(w/12)}px ${FONTS[fontKey].family}`); } catch {}
    drawOverlayText(ctx, w, h);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* 자막을 투명 PNG로 (영상 모드 overlay용) */
  async function renderTextPNG(width, height) {
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    const ctx = c.getContext("2d");
    try { await document.fonts.load(`${Math.floor(width/12)}px ${FONTS[fontKey].family}`); } catch {}
    drawOverlayText(ctx, width, height);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* -------------------------------------------------------
   * 6) GIF 변환
   * ----------------------------------------------------- */
  async function convertToGif() {
    if (!ffmpegReady || !mode) return;
    setConverting(true);
    setProgress(0);
    setGifUrl(null);

    const ffmpeg = ffmpegRef.current;
    const cfg = PRESETS[preset];

    try {
      const attempts = [
        { fps: cfg.fps, width: cfg.width },
        { fps: Math.max(8, cfg.fps - 3), width: Math.round(cfg.width * 0.8) },
        { fps: 8, width: Math.round(cfg.width * 0.6) },
      ];

      let outData = null;

      if (mode === "video") {
        await ffmpeg.writeFile("input.mp4", await fetchFile(videoSrc));
        const vw = videoRef.current?.videoWidth || 16;
        const vh = videoRef.current?.videoHeight || 9;
        const hasText = overlayText.trim().length > 0;

        for (const a of attempts) {
          const outH = Math.round((a.width * vh) / vw);
          let args;
          if (hasText) {
            await ffmpeg.writeFile("text.png", await renderTextPNG(a.width, outH));
            args = [
              "-y", "-ss", String(startTime), "-t", String(clipLength),
              "-i", "input.mp4", "-i", "text.png",
              "-filter_complex",
              `[0:v]fps=${a.fps},scale=${a.width}:${outH}:flags=lanczos[v];` +
              `[v][1:v]overlay=0:0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
              "-loop", "0", "output.gif",
            ];
          } else {
            args = [
              "-y", "-ss", String(startTime), "-t", String(clipLength),
              "-i", "input.mp4",
              "-vf",
              `fps=${a.fps},scale=${a.width}:${outH}:flags=lanczos,` +
              `split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
              "-loop", "0", "output.gif",
            ];
          }
          const rc = await ffmpeg.exec(args);
          if (rc !== 0) throw new Error(`ffmpeg exited with ${rc}`);
          outData = await ffmpeg.readFile("output.gif");
          if (!outData || outData.byteLength === 0) throw new Error("empty output");
          const sizeMB = outData.byteLength / (1024 * 1024);
          setGifSizeMB(sizeMB.toFixed(2));
          if (!cfg.maxSizeMB || sizeMB <= cfg.maxSizeMB) break;
        }
      }

      if (mode === "photos") {
        for (const a of attempts) {
          const outW = a.width;
          const outH = Math.round(outW * 0.75); // 4:3 캔버스 (레터박스)
          // 사진들을 균일 PNG 프레임으로 (자막 포함)
          let list = "";
          for (let i = 0; i < photos.length; i++) {
            const frame = await renderPhotoFrame(photos[i].url, outW, outH);
            await ffmpeg.writeFile(`p${i}.png`, frame);
            list += `file 'p${i}.png'\nduration ${secPerPhoto}\n`;
          }
          // concat demuxer는 마지막 파일을 한 번 더 명시해야 duration이 적용됨
          list += `file 'p${photos.length - 1}.png'\n`;
          await ffmpeg.writeFile("list.txt", new TextEncoder().encode(list));

          const rc = await ffmpeg.exec([
            "-y", "-f", "concat", "-safe", "0", "-i", "list.txt",
            "-vf", `fps=10,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
            "-loop", "0", "output.gif",
          ]);
          if (rc !== 0) throw new Error(`ffmpeg exited with ${rc}`);
          outData = await ffmpeg.readFile("output.gif");
          if (!outData || outData.byteLength === 0) throw new Error("empty output");
          const sizeMB = outData.byteLength / (1024 * 1024);
          setGifSizeMB(sizeMB.toFixed(2));
          if (!cfg.maxSizeMB || sizeMB <= cfg.maxSizeMB) break;
        }
      }

      const blob = new Blob([outData.buffer], { type: "image/gif" });
      setGifUrl(URL.createObjectURL(blob));
    } catch (e) {
      console.error("convert failed:", e);
      setLoadError("변환 중 문제가 발생했어요. 구간을 짧게 잡거나 사진 수를 줄여 다시 시도해 보세요!");
    } finally {
      setConverting(false);
    }
  }

  const endTime = useMemo(
    () => Math.min(videoDuration, startTime + clipLength).toFixed(1),
    [videoDuration, startTime, clipLength]
  );

  const sourceLoaded = mode === "video" ? !!videoSrc : mode === "photos" ? photos.length >= 2 : false;

  /* -------------------------------------------------------
   * 렌더링
   * ----------------------------------------------------- */
  return (
    <div className="min-h-screen bg-[#FFF3F6] text-[#4A3B44] font-sans">
      <div className="mx-auto max-w-3xl px-4 py-8 flex flex-col gap-6">

        {/* ── 헤더 ─────────────────────────────── */}
        <header className="text-center">
          <h1 className="text-5xl font-black tracking-tight">
            <span className="inline-block animate-bounce">🍿</span>{" "}
            <span className="text-[#FF85A1]">팝</span>
            <span className="text-[#E5A800]">짤</span>
          </h1>
          <p className="mt-2 font-semibold text-[#8A7580]">
            내 폰 속 영상·사진이 움짤로 팝! 🎬✨
          </p>
          <p className="mt-1 text-xs font-semibold text-[#C4AEB8]">
            서버 업로드 없음 · 모든 변환은 내 기기 안에서만 🔒
          </p>
        </header>

        {/* ── 상단 광고 ────────────────────────── */}
        <AdBanner label="TOP AD" />

        {/* ── 1. 소스 선택 카드 ─────────────────── */}
        <section className="rounded-2xl bg-white p-5 shadow-[0_6px_0_#FFD9E2]">
          <label className="mb-3 block font-extrabold text-[#FF85A1]">
            🎬 무엇으로 움짤을 만들까요?
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label
              className={`cursor-pointer rounded-2xl border-4 p-5 text-center transition-all
                ${mode === "video"
                  ? "border-[#FF85A1] bg-[#FFECF1] scale-[1.02]"
                  : "border-[#FFD166] bg-[#FFFDF7] hover:border-[#FF85A1]"}`}
            >
              <div className="text-4xl">🎥</div>
              <div className="mt-2 font-extrabold">영상으로 만들기</div>
              <div className="mt-1 text-xs font-semibold text-[#8A7580]">
                원하는 구간을 잘라서
              </div>
              <input type="file" accept="video/*" onChange={loadVideoFile} className="hidden" />
            </label>
            <label
              className={`cursor-pointer rounded-2xl border-4 p-5 text-center transition-all
                ${mode === "photos"
                  ? "border-[#FF85A1] bg-[#FFECF1] scale-[1.02]"
                  : "border-[#FFD166] bg-[#FFFDF7] hover:border-[#FF85A1]"}`}
            >
              <div className="text-4xl">📸</div>
              <div className="mt-2 font-extrabold">사진으로 만들기</div>
              <div className="mt-1 text-xs font-semibold text-[#8A7580]">
                2~10장을 이어붙여서
              </div>
              <input type="file" accept="image/*" multiple onChange={loadPhotoFiles} className="hidden" />
            </label>
          </div>
          {loadError && (
            <p className="mt-3 rounded-2xl bg-[#FFECF1] px-4 py-3 text-sm font-semibold text-[#E5537A]">
              {loadError}
            </p>
          )}
          {!ffmpegReady && !loadError && (
            <p className="mt-3 text-xs font-semibold text-[#B79A45]">
              🍿 변환 엔진(ffmpeg.wasm)을 굽는 중… 잠시만요!
            </p>
          )}
        </section>

        {/* ── 2. 편집 영역 ─────────────────────── */}
        {sourceLoaded && (
          <section className="rounded-2xl bg-white p-5 shadow-[0_6px_0_#FFEBC2] flex flex-col gap-5">

            {/* 영상 모드: 플레이어 + 타임라인 */}
            {mode === "video" && (
              <>
                <video
                  ref={videoRef}
                  src={videoSrc}
                  onLoadedMetadata={onVideoLoaded}
                  controls muted playsInline
                  className="w-full rounded-2xl bg-black"
                />
                <div className="flex flex-col gap-4">
                  <div>
                    <div className="mb-1 flex justify-between font-bold text-sm">
                      <span>⏱ 시작 시간</span>
                      <span className="text-[#FF85A1]">{startTime.toFixed(1)}초</span>
                    </div>
                    <input
                      type="range" min={0}
                      max={Math.max(0, videoDuration - 0.5)} step={0.1}
                      value={startTime}
                      onChange={(e) => setStartTime(parseFloat(e.target.value))}
                      className="w-full accent-[#FF85A1]"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between font-bold text-sm">
                      <span>🎞 길이 (Duration)</span>
                      <span className="text-[#E5A800]">{clipLength.toFixed(1)}초</span>
                    </div>
                    <input
                      type="range" min={0.5}
                      max={Math.min(10, Math.max(0.5, videoDuration - startTime))} step={0.1}
                      value={clipLength}
                      onChange={(e) => setClipLength(parseFloat(e.target.value))}
                      className="w-full accent-[#FFD166]"
                    />
                  </div>
                  <p className="rounded-2xl bg-[#FFF8E7] px-4 py-2 text-center text-sm font-bold text-[#B79A45]">
                    선택 구간: {startTime.toFixed(1)}초 → {endTime}초
                  </p>
                </div>
              </>
            )}

            {/* 사진 모드: 썸네일 그리드 + 장당 시간 */}
            {mode === "photos" && (
              <>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-extrabold text-[#FF85A1]">
                      📸 선택한 사진 ({photos.length}/{MAX_PHOTOS})
                    </span>
                    <label className="cursor-pointer rounded-2xl border-2 border-[#FFD166] bg-[#FFF8E7]
                                       px-3 py-1.5 text-xs font-bold text-[#B79A45] hover:border-[#FF85A1]">
                      + 다시 선택
                      <input type="file" accept="image/*" multiple onChange={loadPhotoFiles} className="hidden" />
                    </label>
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {photos.map((p, i) => (
                      <div key={p.url} className="relative">
                        <img
                          src={p.url} alt={`사진 ${i + 1}`}
                          className="aspect-square w-full rounded-xl object-cover border-2 border-[#FFD9E2]"
                        />
                        <button
                          onClick={() => removePhoto(i)}
                          aria-label="사진 제거"
                          className="absolute -right-1.5 -top-1.5 h-6 w-6 rounded-full bg-[#FF85A1]
                                     text-white text-xs font-black shadow"
                        >
                          ✕
                        </button>
                        <span className="absolute bottom-1 left-1 rounded-lg bg-black/50 px-1.5
                                          text-[10px] font-bold text-white">
                          {i + 1}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs font-semibold text-[#B79A45]">
                    * 선택한 순서대로 이어붙여요
                  </p>
                </div>
                <div>
                  <div className="mb-1 flex justify-between font-bold text-sm">
                    <span>⏱ 사진 한 장당 시간</span>
                    <span className="text-[#FF85A1]">{secPerPhoto.toFixed(1)}초</span>
                  </div>
                  <input
                    type="range" min={0.3} max={3} step={0.1}
                    value={secPerPhoto}
                    onChange={(e) => setSecPerPhoto(parseFloat(e.target.value))}
                    className="w-full accent-[#FF85A1]"
                  />
                  <p className="mt-2 rounded-2xl bg-[#FFF8E7] px-4 py-2 text-center text-sm font-bold text-[#B79A45]">
                    총 길이: 약 {(photos.length * secPerPhoto).toFixed(1)}초
                  </p>
                </div>
              </>
            )}

            {/* 자막 (공통) */}
            <div>
              <label className="mb-2 block font-extrabold text-[#E5A800]">
                💬 텍스트 얹기 <span className="text-xs font-semibold text-[#B79A45]">(움짤 위 자막)</span>
              </label>
              <input
                type="text"
                value={overlayText}
                onChange={(e) => setOverlayText(e.target.value)}
                maxLength={30}
                placeholder="예) 퇴근하고 싶다…"
                className="w-full rounded-2xl border-2 border-[#FFD166] bg-[#FFFDF7] px-4 py-3
                           font-medium outline-none focus:border-[#FF85A1]"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(FONTS).map(([key, f]) => (
                  <button
                    key={key}
                    onClick={() => setFontKey(key)}
                    style={{ fontFamily: f.family }}
                    className={`rounded-2xl px-4 py-2 text-base transition-all
                      ${fontKey === key
                        ? "bg-[#FFD166] text-[#5A4632] shadow-[0_4px_0_rgba(0,0,0,0.12)] scale-105"
                        : "bg-[#FFF8E7] text-[#8A7580] border-2 border-[#FFD166]"}`}
                  >
                    {f.label} <span className="opacity-70">{f.sample}</span>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-[#8A7580]">색상</span>
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setTextColor(c)}
                    style={{ backgroundColor: c }}
                    aria-label={`자막 색상 ${c}`}
                    className={`h-8 w-8 rounded-full border-2 transition-transform
                      ${textColor === c
                        ? "border-[#FF85A1] scale-125 shadow-[0_2px_0_rgba(0,0,0,0.15)]"
                        : "border-white"}`}
                  />
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs font-bold text-[#8A7580]">위치</span>
                {Object.entries(TEXT_POSITIONS).map(([key, p]) => (
                  <button
                    key={key}
                    onClick={() => setTextPos(key)}
                    className={`rounded-2xl px-4 py-2 text-sm font-bold transition-all
                      ${textPos === key
                        ? "bg-[#FF85A1] text-white shadow-[0_4px_0_rgba(0,0,0,0.12)] scale-105"
                        : "bg-[#FFF8E7] text-[#8A7580] border-2 border-[#FFD166]"}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 실시간 미리보기 (공통) */}
            <div>
              <p className="mb-2 font-extrabold text-[#FF85A1]">👀 실시간 미리보기</p>
              <canvas
                ref={previewCanvasRef}
                className="w-full rounded-2xl border-4 border-[#FFD9E2] bg-black"
              />
              <p className="mt-1 text-xs font-semibold text-[#B79A45]">
                {mode === "video"
                  ? "* 비디오를 재생하면 선택 구간과 자막이 이렇게 보여요!"
                  : "* 사진이 이 순서와 속도로 넘어가요!"}
              </p>
            </div>

            {/* 프리셋 (공통) */}
            <div>
              <p className="mb-2 font-extrabold text-[#4A3B44]">📦 용량 프리셋</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(PRESETS).map(([key, p]) => (
                  <button
                    key={key}
                    onClick={() => setPreset(key)}
                    className={`rounded-2xl px-4 py-2 font-bold text-sm transition-all
                      ${preset === key
                        ? "bg-[#FF85A1] text-white shadow-[0_4px_0_rgba(0,0,0,0.12)] scale-105"
                        : "bg-[#FFF8E7] text-[#8A7580] border-2 border-[#FFD166]"}`}
                  >
                    {p.emoji} {p.label}
                  </button>
                ))}
              </div>
            </div>

            <PopButton
              onClick={convertToGif}
              disabled={!ffmpegReady || converting}
              variant="yellow"
              className="text-lg"
            >
              {converting ? "굽는 중… 🍿🔥" : "움짤로 팝! 하기 🎉"}
            </PopButton>
          </section>
        )}

        {/* ── 3. 변환 진행 + 광고 ─────────────── */}
        {converting && (
          <section className="flex flex-col gap-3">
            <div className="rounded-2xl bg-white p-5 shadow-[0_6px_0_#FFD9E2]">
              <div className="mb-2 flex justify-between font-extrabold">
                <span>팝콘 굽는 중…</span>
                <span className="text-[#FF85A1]">{progress}%</span>
              </div>
              <div className="h-5 w-full overflow-hidden rounded-2xl bg-[#FFECF1]">
                <div
                  className="h-full rounded-2xl bg-gradient-to-r from-[#FF85A1] to-[#FFD166] transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <AdBanner label="CONVERT AD" height="h-32" />
          </section>
        )}

        {/* ── 4. 결과 ─────────────────────────── */}
        {gifUrl && (
          <section className="rounded-2xl bg-white p-5 shadow-[0_6px_0_#FFEBC2] text-center">
            <h2 className="mb-3 text-xl font-black text-[#E5A800]">🎉 완성! 팝짤 나왔어요</h2>
            <img src={gifUrl} alt="완성된 움짤" className="mx-auto rounded-2xl" />
            {gifSizeMB && (
              <p className="mt-2 text-sm font-bold text-[#8A7580]">파일 크기: {gifSizeMB} MB</p>
            )}
            <a href={gifUrl} download="popjjal.gif">
              <PopButton className="mt-4 w-full">GIF 저장하기 ⬇️</PopButton>
            </a>
          </section>
        )}

        {/* ── 하단 광고 & 푸터 ─────────────────── */}
        <AdBanner label="BOTTOM AD" />
        <footer className="pb-6 text-center text-xs font-semibold text-[#C4AEB8]">
          © 2026 팝짤(PopJjal) · 모든 변환은 여러분의 브라우저 안에서만 일어나요 🔒
        </footer>
      </div>
    </div>
  );
}
