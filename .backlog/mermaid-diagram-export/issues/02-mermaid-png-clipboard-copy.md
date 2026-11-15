# 02 — Mermaid 다이어그램 테마 배경 · 2x 고해상도 PNG 클립보드 복사

**Spec:** [spec.md](../spec.md)

**What to build:** 렌더링된 Mermaid SVG에 현재 앱 테마 표면 배경색(`light`: `#ffffff`, `dark`: `#161b22`)과 `16px` 외곽 여백을 입혀 단독 XML SVG로 정규화하고 `2x` 고해상도 PNG 바이트로 래스터화(초대형 다이어그램 최대 해상도 안전 클램프 포함)하는 변환 모듈 및 Main 이미지 클립보드 핸들러(`copyImage`)를 구축하여, Mermaid 액션 바의 `이미지 복사` 버튼 E2E 흐름과 문법 오류·미렌더링 비활성화 보호 규칙을 완성합니다.

**Blocked by:** 01-mermaid-action-bar-and-code-copy

**Status:** ready-for-agent

- [ ] 단독 SVG 정규화 모듈이 `viewBox`(또는 숫자형 `width`/`height`)를 기준으로 사방 `16px` 여백이 확장된 `viewBox`와 명시적 픽셀 `width`/`height`를 부여하고, 반응형 `max-width` 인라인 스타일 정리, 활성 테마 표면 배경색(`<rect>`, 라이트 `#ffffff` / 다크 `#161b22`) 최하단 삽입, `<foreignObject>` XML 네임스페이스 보존 직렬화를 수행함을 단위 테스트로 검증합니다.
- [ ] PNG 래스터화 모듈이 정규화된 SVG를 외부 네트워크 요청 없는 `data:image/svg+xml;charset=utf-8,...` URI로 디코딩해 오프스크린 `<canvas>` 오염 없이 기본 `2x` 배율 PNG 바이트(`Uint8Array`)를 생성하고, 최대 한계(한 변 `8192px` 또는 총 면적 `67,108,864px`) 초과 시 종횡비를 유지하며 배율을 자동 축소함을 주입형 래스터 어댑터 단위 테스트로 검증합니다.
- [ ] `copyImage` IPC 채널(PNG 바이너리 본문 미기록, 바이트 길이만 감사 로그 기록), Preload `window.wikiApi.diagram.copyImage` 브리지, Main `nativeImage` 변환·빈 버퍼/빈 이미지 검증·클립보드 기록 핸들러 단위 테스트가 통과합니다.
- [ ] Mermaid 액션 바 맨 앞에 `이미지 복사` 아이콘 버튼이 배치되어 클릭 시 활성 테마 배경이 채워진 `2x` PNG 바이트가 클립보드 브리지로 전달되고 `1500ms` 동안 체크(`✓`) 완료 피드백을 표시합니다(실행 중 중복 클릭 방지 포함).
- [ ] 초기 로딩 중, 디바운스 재렌더링 대기 중(현재 코드와 일치하는 최신 SVG 미확정), 또는 문법 오류가 발생한 상태(직전 정상 SVG가 화면에 유지 표시되는 상태 및 폴백 오류 박스 상태 모두 포함)에서는 `이미지 복사` 버튼이 비활성화되고 `코드 복사`만 활성 상태를 유지합니다.
- [ ] 래스터화 또는 클립보드 기록 실패 시 다이어그램 소스를 유출하지 않는 오류 로그를 남기고 해당 블록 내부에 간결한 인라인 오류 알림(`role="alert"`)을 표시합니다.
- [ ] `<App />` 통합 테스트가 `Preview`, `Split`, `위지윅` 모드에서의 `이미지 복사`, 라이트/다크 테마 반영, 문법 오류 발생 시 `이미지 복사` 비활성화 및 정상 문법 복구 시 재활성화를 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
