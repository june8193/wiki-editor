# 01 — 드래그 기반 좌우·상하 화면 분할 확장 및 앱 헤더 분할 버튼 제거

**Spec:** [spec.md](../spec.md)

**What to build:** 앱 헤더에서 화면 분할 버튼(`단일`, `좌우 분할`, `상하 분할`)을 제거하고, 문서 탭을 편집 공간의 우측 또는 하단 드롭 영역으로 드래그하여 좌우 분할(`horizontal`)과 상하 분할(`vertical`)을 모두 수행할 수 있게 하며, 이미 분할된 상태에서도 반대 방향 드롭 영역으로 탭을 드래그해 분할 방향을 전환할 수 있게 합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 앱 헤더에서 `단일`, `좌우 분할`, `상하 분할` 버튼 그룹(`화면 분할` 그룹)이 제거됩니다.
- [x] `단일(single)` 화면에서 탭이 2개 이상 열려 있을 때 탭을 드래그하면, 편집 공간에 우측 드롭 영역(좌우 분할)과 하단 드롭 영역(상하 분할)이 모두 표시됩니다.
- [x] 우측 드롭 영역에 탭을 드롭하면 `좌우 분할(horizontal)`로 전환되며 해당 탭이 보조 편집기 영역으로 이동하고, 하단 드롭 영역에 탭을 드롭하면 `상하 분할(vertical)`로 전환되며 해당 탭이 보조 편집기 영역으로 이동합니다.
- [x] 이미 분할된 상태(`horizontal` 또는 `vertical`)에서 탭을 드래그하면 현재 분할의 반대 방향 드롭 영역(좌우 분할 중이면 하단, 상하 분할 중이면 우측)이 표시되며, 해당 드롭 영역에 탭을 드롭하면 분할 방향이 반대 방향(`horizontal` ↔ `vertical`)으로 전환됩니다.
- [x] 한쪽 편집기 영역의 모든 탭을 닫거나 다른 영역으로 이동시켜 영역이 비게 되면 기존과 동일하게 자동으로 `단일(single)` 화면으로 복귀하며, 활성 탭 포커스 보존 불변식이 유지됩니다.
- [x] `PaneTabStore` 단위 테스트와 `<App />` 통합 테스트가 우측/하단 드래그 분할 및 분할 방향 전환을 검증하며 모두 통과합니다.

## Comments

- Commits: `efd6db0`, `84519db`, `798f025`, `866d0ef`
- Verification: `npm run typecheck` passed, `npm test` passed (`29 passed (29)`, `179 passed (179)`), parallel `/code-review` converged to 0 Standards and 0 Spec findings after 4 iterations.
