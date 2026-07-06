/**
 * 🍿 팝짤 (PopJjal) — 링크로 만드는 톡톡 튀는 움짤 메이커
 * ---------------------------------------------------------
 * Stack   : Vite + React + Tailwind CSS + @ffmpeg/ffmpeg (WASM)
 * Install : npm i @ffmpeg/ffmpeg @ffmpeg/util
 *
 * ⚠️ ffmpeg.wasm 멀티스레드 코어는 SharedArrayBuffer가 필요합니다.
 *    아래 코드는 "싱글스레드 코어(@ffmpeg/core)"를 사용해
 *    COOP/COEP 헤더 없이도 동작하도록 구성했습니다. (배포 주의사항 참고)
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

// 용량 최적화 프리셋 — 실제 압축 로직의 뼈대
// maxSizeMB는 변환 후 초과 시 fps/scale을 낮춰 재시도하는 기준값입니다.
const PRESETS = {
  default: { label: "기본 화질", emoji: "🍿", fps: 15, width: 480, maxSizeMB: null },
  insta:   { label: "인스타/스레드용", emoji: "📱", fps: 12, width: 400, maxSizeMB: 15 },
  blog:    { label: "블로그용 (10MB)", emoji: "✍️", fps: 10, width: 360, maxSizeMB: 10 },
};

// 자막 폰트 (전부 SIL OFL 오픈소스 — 상업적 사용 무료)
// 자막은 캔버스에서 투명 PNG로 렌더링 후 ffmpeg overlay로 영상에 합성됩니다.
const FONTS = {
  blackhan: { label: "검은고딕", sample: "임팩트!", family: "'Black Han Sans', sans-serif" },
  dohyeon:  { label: "도현",     sample: "또박또박", family: "'Do Hyeon', sans-serif" },
  gaegu:    { label: "개구",     sample: "귀염뽀짝", family: "'Gaegu', cursive" },
};

// 자막 색상 스와치
const TEXT_COLORS = [
  "#FFFFFF", "#FFD166", "#FF85A1", "#FF3B30",
  "#34C759", "#5AC8FA", "#AF52DE", "#111111",
];

// 자막 위치
const TEXT_POSITIONS = {
  top:    { label: "⬆️ 상단" },
  middle: { label: "↔️ 중앙" },
  bottom: { label: "⬇️ 하단" },
};

// 어두운 색 자막엔 흰 테두리, 밝은 색엔 검은 테두리
function outlineFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299*((n>>16)&255) + 0.587*((n>>8)&255) + 0.114*(n&255);
  return lum < 128 ? "#FFFFFF" : "#000000";
}

/* ---------------------------------------------------------
 * 광고 배너 플레이스홀더 (구글 애드센스 자리)
 * 실제 적용 시 이 컴포넌트 내부를 <ins class="adsbygoogle"> 로 교체
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

/* ---------------------------------------------------------
 * 말랑 버튼
 * ------------------------------------------------------- */
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
  /* ----- ffmpeg 인스턴스 ----- */
  const ffmpegRef = useRef(new FFmpeg());
  const [ffmpegReady, setFfmpegReady] = useState(false);

  /* ----- 비디오 로드 상태 ----- */
  const [url, setUrl] = useState("");
  const [videoSrc, setVideoSrc] = useState(null); // Blob URL
  const [videoDuration, setVideoDuration] = useState(0);
  const [loadError, setLoadError] = useState("");
  const videoRef = useRef(null);

  /* ----- 타임라인 ----- */
  const [startTime, setStartTime] = useState(0);
  const [clipLength, setClipLength] = useState(3); // seconds

  /* ----- 텍스트 오버레이 (Canvas 확장 기능) ----- */
  const [overlayText, setOverlayText] = useState("");
  const [fontKey, setFontKey] = useState("blackhan");
  const [textColor, setTextColor] = useState("#FFFFFF");
  const [textPos, setTextPos] = useState("bottom");
  const previewCanvasRef = useRef(null);

  /* ----- 변환 상태 ----- */
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
   * 2) 링크에서 비디오 로드
   *    - direct video URL(MP4/MOV/WebM)은 fetch → Blob 처리
   *    - 유튜브 링크는 브라우저에서 직접 추출 불가 → 안내 처리
   *      (확장 시: 서버리스 함수에서 스트림 URL 추출 후 프록시)
   * ----------------------------------------------------- */
  const isYouTube = (u) => /youtube\.com|youtu\.be/.test(u);

  async function loadVideo() {
    setLoadError("");
    setGifUrl(null);
    if (!url.trim()) return;

    if (isYouTube(url)) {
      setLoadError(
        "유튜브 링크는 브라우저에서 직접 읽을 수 없어요. 🥲 " +
          "MP4/MOV 등 직접 비디오 주소를 붙여넣어 주세요. " +
          "(유튜브 지원은 서버리스 추출 API 연동 후 열릴 예정!)"
      );
      return;
    }

    try {
      // ⚠️ 원본 서버가 CORS(Access-Control-Allow-Origin)를 허용해야 합니다.
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      setVideoSrc(URL.createObjectURL(blob));
    } catch (e) {
      setLoadError(
        "영상을 불러오지 못했어요. 원본 서버가 CORS를 막고 있을 수 있어요. " +
          "다른 링크를 시도하거나, 프록시 서버 설정을 확인해 주세요."
      );
    }
  }

  /* 내 컴퓨터의 영상 파일 직접 선택 (CORS와 무관 — 항상 동작) */
  function loadLocalFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoadError("");
    setGifUrl(null);
    setVideoSrc(URL.createObjectURL(file));
  }

  /* 비디오 메타데이터 로드 → 타임라인 초기화 */
  function onVideoLoaded(e) {
    const d = e.target.duration || 0;
    setVideoDuration(d);
    setStartTime(0);
    setClipLength(Math.min(3, Math.floor(d) || 3));
  }

  /* 슬라이더 움직일 때 비디오 위치도 함께 이동 → 즉각적인 구간 확인 */
  useEffect(() => {
    if (videoRef.current && Number.isFinite(startTime)) {
      videoRef.current.currentTime = startTime;
    }
  }, [startTime]);

  /* -------------------------------------------------------
   * 3) Canvas 미리보기 — 현재 프레임 + 텍스트 오버레이
   * ----------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    const canvas = previewCanvasRef.current;
    if (!video || !canvas) return;

    let raf;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (overlayText) {
          const fontSize = Math.max(24, Math.floor(canvas.width / 12));
          ctx.font = `${fontSize}px ${FONTS[fontKey].family}`;
          ctx.textAlign = "center";
          ctx.lineJoin = "round";
          ctx.lineWidth = fontSize / 6;
          ctx.strokeStyle = outlineFor(textColor);
          ctx.fillStyle = textColor;
          const y =
            textPos === "top"    ? fontSize * 1.2 :
            textPos === "middle" ? canvas.height / 2 + fontSize * 0.35 :
                                   canvas.height - fontSize * 0.8;
          ctx.strokeText(overlayText, canvas.width / 2, y);
          ctx.fillText(overlayText, canvas.width / 2, y);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [videoSrc, overlayText, fontKey, textColor, textPos]);

  /* -------------------------------------------------------
   * 4) GIF 변환 (팔레트 2-pass로 화질 확보)
   *    자막: 캔버스에서 투명 PNG로 그려 overlay 합성
   *    → 미리보기와 100% 동일한 자막이 GIF에 들어감
   *    프리셋의 maxSizeMB 초과 시 fps/width를 낮춰 자동 재시도
   * ----------------------------------------------------- */

  /* 자막을 투명 배경 PNG(Uint8Array)로 렌더링 */
  async function renderTextPNG(width, height) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    const fontSize = Math.max(18, Math.floor(width / 12));
    // 폰트가 완전히 로드된 뒤 그리기 (미리보기와 동일한 모양 보장)
    try { await document.fonts.load(`${fontSize}px ${FONTS[fontKey].family}`); } catch {}
    ctx.font = `${fontSize}px ${FONTS[fontKey].family}`;
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.lineWidth = fontSize / 6;
    ctx.strokeStyle = outlineFor(textColor);
    ctx.fillStyle = textColor;
    const y =
      textPos === "top"    ? fontSize * 1.2 :
      textPos === "middle" ? height / 2 + fontSize * 0.35 :
                             height - fontSize * 0.8;
    ctx.strokeText(overlayText.trim(), width / 2, y);
    ctx.fillText(overlayText.trim(), width / 2, y);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function convertToGif() {
    if (!ffmpegReady || !videoSrc) return;
    setConverting(true);
    setProgress(0);
    setGifUrl(null);

    const ffmpeg = ffmpegRef.current;
    const cfg = PRESETS[preset];
    const hasText = overlayText.trim().length > 0;

    // 원본 영상 비율 (자막 PNG 크기 계산용)
    const vw = videoRef.current?.videoWidth || 16;
    const vh = videoRef.current?.videoHeight || 9;

    try {
      await ffmpeg.writeFile("input.mp4", await fetchFile(videoSrc));

      // 크기 제한 프리셋: 실패 시 단계적으로 낮춰 재시도
      const attempts = [
        { fps: cfg.fps, width: cfg.width },
        { fps: Math.max(8, cfg.fps - 3), width: Math.round(cfg.width * 0.8) },
        { fps: 8, width: Math.round(cfg.width * 0.6) },
      ];

      let outData = null;
      for (const a of attempts) {
        const outH = Math.round((a.width * vh) / vw);
        let args;

        if (hasText) {
          // 자막 PNG를 출력 크기에 맞춰 생성 → overlay 합성
          await ffmpeg.writeFile("text.png", await renderTextPNG(a.width, outH));
          args = [
            "-y",
            "-ss", String(startTime),
            "-t", String(clipLength),
            "-i", "input.mp4",
            "-i", "text.png",
            "-filter_complex",
            `[0:v]fps=${a.fps},scale=${a.width}:${outH}:flags=lanczos[v];` +
            `[v][1:v]overlay=0:0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
            "-loop", "0",
            "output.gif",
          ];
        } else {
          args = [
            "-y",
            "-ss", String(startTime),
            "-t", String(clipLength),
            "-i", "input.mp4",
            "-vf",
            `fps=${a.fps},scale=${a.width}:${outH}:flags=lanczos,` +
            `split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
            "-loop", "0",
            "output.gif",
          ];
        }

        const rc = await ffmpeg.exec(args);
        if (rc !== 0) throw new Error(`ffmpeg exited with code ${rc}`);

        outData = await ffmpeg.readFile("output.gif");
        if (!outData || outData.byteLength === 0) throw new Error("empty output");

        const sizeMB = outData.byteLength / (1024 * 1024);
        setGifSizeMB(sizeMB.toFixed(2));
        if (!cfg.maxSizeMB || sizeMB <= cfg.maxSizeMB) break; // 목표 용량 만족
      }

      const blob = new Blob([outData.buffer], { type: "image/gif" });
      setGifUrl(URL.createObjectURL(blob));
    } catch (e) {
      console.error("convert failed:", e);
      setLoadError("변환 중 문제가 발생했어요. 구간을 짧게 잡고 다시 시도해 보세요!");
    } finally {
      setConverting(false);
    }
  }

  const endTime = useMemo(
    () => Math.min(videoDuration, startTime + clipLength).toFixed(1),
    [videoDuration, startTime, clipLength]
  );

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
            링크만 붙여넣으면, 움짤이 팝콘처럼 톡! 🎬✨
          </p>
        </header>

        {/* ── 상단 광고 ────────────────────────── */}
        <AdBanner label="TOP AD" />

        {/* ── 1. 링크 입력 카드 ─────────────────── */}
        <section className="rounded-2xl bg-white p-5 shadow-[0_6px_0_#FFD9E2]">
          <label className="mb-2 block font-extrabold text-[#FF85A1]">
            🎥 비디오 링크 붙여넣기
          </label>
          <div className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadVideo()}
              placeholder="https://example.com/video.mp4 (MP4 · MOV · WebM)"
              className="flex-1 rounded-2xl border-2 border-[#FFD166] bg-[#FFFDF7] px-4 py-3
                         font-medium outline-none focus:border-[#FF85A1] transition-colors"
            />
            <PopButton onClick={loadVideo} disabled={!url.trim()}>
              불러오기
            </PopButton>
          </div>
          {/* 또는 내 컴퓨터에서 선택 (CORS 걱정 없이 항상 동작) */}
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs font-bold text-[#B79A45]">또는</span>
            <label
              className="cursor-pointer rounded-2xl border-2 border-[#FFD166] bg-[#FFF8E7]
                         px-4 py-2 text-sm font-bold text-[#B79A45] hover:border-[#FF85A1]
                         hover:text-[#FF85A1] transition-colors"
            >
              📁 내 컴퓨터에서 영상 선택
              <input
                type="file"
                accept="video/*"
                onChange={loadLocalFile}
                className="hidden"
              />
            </label>
          </div>
          {loadError && (
            <p className="mt-3 rounded-2xl bg-[#FFECF1] px-4 py-3 text-sm font-semibold text-[#E5537A]">
              {loadError}
            </p>
          )}
          {!ffmpegReady && (
            <p className="mt-3 text-xs font-semibold text-[#B79A45]">
              🍿 변환 엔진(ffmpeg.wasm)을 굽는 중… 잠시만요!
            </p>
          )}
        </section>

        {/* ── 2. 편집 영역 (영상 로드 후 등장) ────── */}
        {videoSrc && (
          <section className="rounded-2xl bg-white p-5 shadow-[0_6px_0_#FFEBC2] flex flex-col gap-5">
            {/* 원본 비디오 (미리보기 소스) */}
            <video
              ref={videoRef}
              src={videoSrc}
              onLoadedMetadata={onVideoLoaded}
              controls
              muted
              playsInline
              crossOrigin="anonymous"
              className="w-full rounded-2xl bg-black"
            />

            {/* 타임라인 컨트롤러 */}
            <div className="flex flex-col gap-4">
              <div>
                <div className="mb-1 flex justify-between font-bold text-sm">
                  <span>⏱ 시작 시간</span>
                  <span className="text-[#FF85A1]">{startTime.toFixed(1)}초</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, videoDuration - 0.5)}
                  step={0.1}
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
                  type="range"
                  min={0.5}
                  max={Math.min(10, Math.max(0.5, videoDuration - startTime))}
                  step={0.1}
                  value={clipLength}
                  onChange={(e) => setClipLength(parseFloat(e.target.value))}
                  className="w-full accent-[#FFD166]"
                />
              </div>
              <p className="rounded-2xl bg-[#FFF8E7] px-4 py-2 text-center text-sm font-bold text-[#B79A45]">
                선택 구간: {startTime.toFixed(1)}초 → {endTime}초
              </p>
            </div>

            {/* 텍스트 오버레이 입력 (Canvas 확장 기능) */}
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

              {/* 폰트 선택 */}
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

              {/* 색상 선택 */}
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

              {/* 위치 선택 */}
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

            {/* Canvas 실시간 미리보기 */}
            <div>
              <p className="mb-2 font-extrabold text-[#FF85A1]">👀 실시간 미리보기</p>
              <canvas
                ref={previewCanvasRef}
                className="w-full rounded-2xl border-4 border-[#FFD9E2] bg-black"
              />
              <p className="mt-1 text-xs font-semibold text-[#B79A45]">
                * 비디오를 재생하면 선택 구간과 자막이 이렇게 보여요!
              </p>
            </div>

            {/* 용량 최적화 프리셋 */}
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

            {/* 변환 버튼 */}
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

        {/* ── 3. 변환 진행 상태 + 광고 ─────────────── */}
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
            {/* 변환 대기 시간 = 광고 골든타임 */}
            <AdBanner label="CONVERT AD" height="h-32" />
          </section>
        )}

        {/* ── 4. 결과 GIF ─────────────────────── */}
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
