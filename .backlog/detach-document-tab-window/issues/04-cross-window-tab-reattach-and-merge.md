# 04 — 창 간 탭 드래그 재결합·병합 및 화면 분할 드롭

**Spec:** [spec.md](../spec.md)

**What to build:** **메인 창**과 **보조 창** 사이(및 **보조 창** 간)에서 탭을 드래그해 대상 창의 **탭 바**나 좌우·상하 분할 드롭 영역에 놓아 양방향으로 합치고 분할할 수 있게 하며, 드롭 성사 시 중복 새 창 생성을 차단하고 빈 **보조 창**을 자동으로 닫습니다.

**Blocked by:** 03-drag-out-to-auxiliary-window

**Status:** resolved

- [x] **보조 창**의 탭을 **메인 창**(또는 다른 **보조 창**)으로 드래그하거나, **메인 창**의 탭을 이미 열려 있는 **보조 창**으로 드래그해 대상 창의 **탭 바**(특정 탭 위치 삽입 및 끝 추가 지원; 대상 **편집기 영역**에 이미 동일 문서 탭이 있으면 해당 탭 활성화)에 놓으면 원본 창에서 탭이 제거되고 대상 창으로 합쳐집니다.
- [x] 다른 창에서 탭을 드래그해 대상 창 위로 진입(`dragenter`/`dragover`)하면 대상 창의 좌우·상하 분할 드롭 영역이 활성화되며(대상 창이 `단일(single)` 모드이고 탭이 1개만 있는 경우에도 외부 탭 유입 시 좌우·상하 분할 드롭 모두 허용), 드롭 시 대상 창이 해당 방향으로 분할되며 탭이 이동합니다.
- [x] 다른 앱 창에서 드롭이 수락된 경우 원본 창의 `dragend`가 추가로 새 **보조 창**을 생성하지 않습니다.
- [x] 창 간 탭 이동으로 원본 **보조 창**의 전체 열린 탭 수가 0개가 되면 해당 **보조 창**이 자동으로 닫힙니다.
- [x] 멀티윈도우 `<App />` 통합 테스트 심과 메인 프로세스 다중 창 IPC 테스트 심이 창 간 **탭 바** 병합, 분할 드롭, 중복 분리 방지, 빈 **보조 창** 자동 닫힘을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `e31fc12`, `cb5d6b6`, `6bace40`, `30d02c7`, `44fc445`
- Verification: `npm run typecheck`, `npm test` (`44 passed (44)`, `299 passed (299)`), `npm run build` passed; parallel `/code-review` converged to 0 Spec findings and 0 Standards hard violations in 5 iterations.
