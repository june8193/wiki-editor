# 05 — 우측 사이드바 접기/펼치기와 너비 조절

**Spec:** [spec.md](../spec.md)

**What to build:** 우측 사이드바(문서 목차) 헤더의 접기 버튼으로 사이드바를 접고, 접힌 상태에서는 우측 끝의 얇은 세로 탭(목차 아이콘)을 눌러 다시 펼칩니다. 04번의 사이드바 리사이저를 왼쪽 경계에 재사용해 180~500px 범위에서 너비를 조절하고, 더블클릭으로 240px로 복원합니다.

**Blocked by:** 01-outline-to-right-sidebar, 04-left-sidebar-resize

**Status:** resolved

- [x] 문서 목차 패널 내부의 기존 접기 상태가 제거되고, 헤더의 접기 버튼(`문서 목차 접기`)이 우측 사이드바 전체를 접습니다.
- [x] 접힌 상태에서는 우측 끝에 얇은 세로 탭(`lucide-react` 목차 아이콘, `aria-label="문서 목차 펼치기"`)만 렌더링되고, 이를 누르면 직전 너비로 펼쳐집니다.
- [x] 우측 사이드바 왼쪽 경계의 리사이저(`우측 사이드바 너비 조절`)로 너비를 드래그·키보드로 조절할 수 있으며, `clamp(180, 500)`으로 제한되고 더블클릭하면 240px로 복원됩니다.
- [x] 우측 사이드바 상태(접힘·너비)는 세션 메모리에만 두고 `config.json`에 저장하지 않습니다.
- [x] `<App />` 통합 테스트가 접기/펼치기와 리사이저의 키보드 조절·더블클릭 복원을 검증합니다.
- [x] `CONTEXT.md`의 **우측 사이드바** 정의에 접기·너비 조절 동작을 반영합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commit: `33b368c`
- Verification: `npm run typecheck`, `npm test` (`38 passed (38)`, `231 passed (231)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings in 1 iteration.
