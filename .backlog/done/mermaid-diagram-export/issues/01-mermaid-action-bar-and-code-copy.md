# 01 — Mermaid 액션 바 도입 및 원본 코드 클립보드 복사

**Spec:** [spec.md](../spec.md)

**What to build:** 다이어그램 전용 IPC 브리지(`copyText`)를 연결하고, `Preview`·`Split` **에디터 모드**에서는 **Mermaid 다이어그램 블록** 우측 상단 호버·포커스 플로팅 바로, `위지윅` **에디터 모드**에서는 기존 블록 상단 헤더(`코드 편집` 옆)에 통합되는 공용 Mermaid 액션 바를 도입하여 원문 `코드 복사` E2E 흐름(1.5초 체크 피드백, 빈 코드 비활성화, 문법 오류 중에도 복사 허용, 실패 시 인라인 오류 알림 및 로그 정제)을 완성합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 공유 IPC 채널·타입 계약, IPC 감사 로그 메타데이터 정제(다이어그램 원문 텍스트를 남기지 않고 길이만 기록), Preload `window.wikiApi.diagram.copyText` 브리지, Main 클립보드 텍스트 기록 핸들러가 구현되고 단위 테스트로 검증됩니다.
- [x] `Preview` 및 `Split` **에디터 모드**의 우측 미리보기에서 **Mermaid 다이어그램 블록** 우측 상단에 마우스 호버, 키보드 포커스(`:focus-within`), 작업 실행 중 또는 완료 체크 표시 중에 노출되며 키보드 Tab으로 접근 가능한 플로팅 액션 바가 렌더링됩니다.
- [x] `위지윅` **에디터 모드**의 **Mermaid 다이어그램 블록**에서는 내부 플로팅 바를 따로 띄우지 않고 기존 상단 헤더(`코드 편집` 버튼 옆)에 액션 버튼이 통합 렌더링되어 이중 툴바가 생기지 않습니다.
- [x] `코드 복사` 아이콘 버튼(툴팁 및 접근 가능한 이름 포함) 클릭 시 해당 블록의 Mermaid 원문 코드가 클립보드 브리지로 전달되고, `1500ms` 동안 체크(`✓`) 완료 상태 및 `복사됨` 안내로 전환되었다가 자동 복귀합니다(다중 블록 간 독립 상태 유지 및 연속 실행·언마운트 시 타이머 정리 포함).
- [x] 원문 코드가 공백뿐이면 `코드 복사` 버튼이 비활성화되며, 코드가 비어 있지 않으면 초기 렌더링 중이거나 문법 오류가 발생한 상태(직전 정상 SVG 유지 상태 및 폴백 오류 박스 상태 모두 포함)에서도 `코드 복사`가 정상 동작합니다.
- [x] 클립보드 복사 실패 시 다이어그램 원문 소스를 유출하지 않는 오류 로그를 남기고 해당 블록 내부에 간결한 인라인 오류 알림(`role="alert"`)을 표시합니다.
- [x] `<App />` 통합 테스트가 `Preview`, `Split`, `위지윅` 세 **에디터 모드**에서의 `코드 복사` 동작과 문법 오류 중 복사 허용을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- Commits: `e8c2130`, `c65b7e7`
- Verification: `npm run typecheck`, `npm test` (`49 passed (49)`, `329 passed (329)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings after 2 iterations.
