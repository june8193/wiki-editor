# 03 — 탭 창 밖 드래그 분리 및 취소(Esc)·단일 탭 예외 처리

**Spec:** [spec.md](../spec.md)

**What to build:** **탭 바**에서 문서 탭을 드래그해 열려 있는 모든 앱 창 바깥 빈 화면에 놓으면 커서 위치에 새 **보조 창**으로 탭을 분리하고, 앱 창 내부 비드롭 영역 드롭·`Esc` 취소·**보조 창** 단일 탭 드롭 시에는 새 창을 열지 않도록 드래그 세션과 좌표 판정 흐름을 완성합니다.

**Blocked by:** 02-auxiliary-window-shell-and-context-detach

**Status:** resolved

- [x] **탭 바**에서 탭을 드래그해 모든 열린 앱 창(**메인 창** 및 **보조 창**)의 외곽 `bounds` 바깥 빈 화면에 놓으면, 드롭 커서 위치(대상 디스플레이 `workArea` 내 클램핑)에 새 **보조 창**이 열리며 해당 탭(**에디터 모드**·커서·스크롤·미저장 **문서 버퍼** 상태 포함)이 이동합니다.
- [x] **메인 창**에 탭이 1개만 열려 있을 때도 창 밖 빈 화면 드롭으로 분리되며 **메인 창**은 빈 **편집 공간** 상태로 남습니다.
- [x] **보조 창**에 열린 탭이 전체 1개뿐일 때는 창 밖 빈 화면에 드롭해도 새 창이 생성되지 않고 기존 탭과 창이 그대로 유지됩니다.
- [x] 앱 창 내부의 비드롭 영역(예: 본문, 사이드바 위)에서 마우스를 놓거나 드래그 도중 `Esc` 키로 취소한 경우에는 새 **보조 창**이 생성되지 않고 원본 탭이 그대로 유지됩니다.
- [x] 멀티윈도우 `<App />` 통합 테스트 심과 메인 프로세스 다중 창 IPC 테스트 심(`bounds` 판정 및 `before-input-event` 기반 `Esc` 취소 포함)이 위 동작을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `37997b3`, `8b2abb2`, `d296b85`, `1c66eca`
- Verification: `npm run typecheck`, `npm test` (`44 passed (44)`, `293 passed (293)`), `npm run build` passed; parallel `/code-review` converged to 0 Spec findings and 0 Standards hard violations in 4 iterations.
