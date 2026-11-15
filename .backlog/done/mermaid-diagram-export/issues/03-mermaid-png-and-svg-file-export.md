# 03 — Mermaid 다이어그램 PNG · SVG 파일 저장 및 문서명 기반 기본 파일명 제안

**Spec:** [spec.md](../spec.md)

**What to build:** Electron 네이티브 `다른 이름으로 저장` 대화상자 기반 파일 쓰기 IPC(`saveFile`)와 활성 문서 제목 기반 기본 파일명 생성기(`<문서명>-diagram.png` / `.svg`)를 구축하고, Mermaid 액션 바에 `PNG 저장`·`SVG 저장` 아이콘 버튼을 연결해 4종 액션 구성을 완결하며 도메인 용어집을 갱신합니다.

**Blocked by:** 02-mermaid-png-clipboard-copy

**Status:** resolved

- [x] 기본 파일명 생성 모듈이 활성 문서 제목에서 Windows 금지 문자(`[<>:"/\\|?*\x00-\x1f]`), 선행·후행 공백 및 마침표를 정제해 `<문서명>-diagram.png` / `<문서명>-diagram.svg`를 반환하고, 문서 제목이 없거나 정제 후 비어 있으면 `mermaid-diagram.png` / `mermaid-diagram.svg`로 폴백함을 단위 테스트로 검증합니다.
- [x] `saveFile` IPC 채널(파일 데이터 본문 미기록, 포맷·바이트/문자열 길이·취소 여부만 감사 로그 기록), Preload `window.wikiApi.diagram.saveFile` 브리지, Main 네이티브 저장 대화상자(포맷별 확장자 필터 적용, 취소 시 파일 쓰기 없이 `{ canceled: true }` 반환, 확정 시 PNG 바이너리 또는 UTF-8 SVG 문자열 저장 후 `{ canceled: false, filePath }` 반환) 단위 테스트가 통과합니다.
- [x] **문서 편집기**가 활성 **문서 버퍼**에서 도출한 문서 제목이 `Preview`, `Split` 우측 미리보기, `위지윅` 컨텍스트를 통해 모든 **Mermaid 다이어그램 블록**에 전달됩니다.
- [x] Mermaid 액션 바에 `이미지 복사`, `코드 복사`, `PNG 저장`, `SVG 저장` 4개 아이콘 버튼이 순서대로 배치되며, `PNG 저장`은 활성 테마 배경과 `16px` 여백이 적용된 `2x` PNG 바이트를, `SVG 저장`은 활성 테마 배경과 `16px` 여백이 포함된 단독 XML SVG 문자열을 저장 요청으로 전달합니다.
- [x] 파일 저장 확정(`canceled: false`) 시 해당 버튼이 `1500ms` 동안 체크(`✓`) 및 `저장됨` 완료 피드백을 표시하고, 사용자가 저장 대화상자를 취소(`canceled: true`)하면 체크 전환이나 오류 없이 즉시 대기 상태로 복귀합니다.
- [x] 초기 로딩 중, 디바운스 재렌더링 대기 중, 문법 오류 상태(직전 정상 SVG 유지 상태 및 폴백 오류 박스 상태 모두 포함)에서는 `PNG 저장`·`SVG 저장` 버튼이 `이미지 복사`와 함께 비활성화되며, 저장 실패 시 다이어그램 소스를 유출하지 않는 오류 로그와 함께 블록 내부 인라인 오류 알림(`role="alert"`)이 표시됩니다.
- [x] 도메인 용어집의 **Mermaid 다이어그램 블록** 정의에 PNG·SVG 파일 내보내기 및 클립보드(이미지·원문 코드) 복사 기능이 반영됩니다.
- [x] `<App />` 통합 테스트가 `Preview`, `Split`, `위지윅` 모드에서의 `PNG 저장`·`SVG 저장`(활성 문서명 반영 기본 파일명, 저장 완료 피드백, 대화상자 취소 시 무변화, 문법 오류 비활성화)을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- Commits: `90215b1`, `f746da5`
- Verification: `npm run typecheck`, `npm test` (`50 passed (50)`, `347 passed (347)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings after 2 iterations.
