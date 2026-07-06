# 🍿 팝짤 (PopJjal)

비디오 링크만 붙여넣으면 브라우저 안에서 바로 움짤(GIF)을 만드는 웹서비스입니다.
서버 없이 ffmpeg.wasm으로 변환하므로 인프라 비용이 거의 들지 않습니다.

## 실행 방법 (3줄이면 끝!)

```bash
npm install
npm run dev
# 브라우저에서 http://localhost:5173 접속
```

## 배포 (Vercel)

```bash
npm run build   # dist/ 폴더 생성
```

1. GitHub에 이 폴더를 push
2. vercel.com → "Add New Project" → 저장소 선택
3. Framework Preset: **Vite** 자동 감지 → Deploy 클릭

별도 헤더 설정 없이 바로 배포됩니다 (싱글스레드 ffmpeg 코어 사용).

## 테스트용 CORS 허용 비디오 링크

개발 중 바로 붙여넣어 볼 수 있는 링크:

- https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
- https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4

## 구조

```
popjjal/
├── index.html          # 진입점 (Pretendard 폰트 로드)
├── src/
│   ├── App.jsx         # 메인 대시보드 (모든 핵심 로직)
│   ├── main.jsx        # React 마운트
│   └── index.css       # Tailwind
├── tailwind.config.js
├── postcss.config.js
└── vite.config.js      # 멀티스레드 전환용 헤더 주석 포함
```

## 확장 로드맵

- [ ] 유튜브 링크 지원: 서버리스 함수(`/api/extract`)에서 스트림 URL 추출
- [ ] CORS 프록시: `/api/proxy?url=` + 화이트리스트 + 50MB 제한
- [ ] 자막 굽기: 폰트(.ttf)를 ffmpeg FS에 올리고 drawtext 필터 활성화
- [ ] 애드센스 실제 연동: `AdBanner` 컴포넌트 내부 교체
