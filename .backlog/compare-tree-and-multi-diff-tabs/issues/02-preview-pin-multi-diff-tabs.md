# 02 — VS Code식 Preview + Pin 다중 Diff 탭 구현

**Spec:** [spec.md](../spec.md)

**What to build:** **Compare 패널**, **Git 뷰** **Changes 섹션**, **Graph 섹션** 커밋 상세, **Stashes 섹션** 상세 등 모든 **Diff 탭** 소스에 대해 VS Code식 Preview(단일 클릭 재사용 + **탭 바** 이탤릭 표시) 및 Pin(더블클릭 · `Shift+클릭` · **탭 바** Preview 탭 더블클릭으로 고정하여 다중 탭 유지) 동작과 Compare Ref/모드 변경 시 전체 Compare Diff 탭 일괄 갱신을 엔드투엔드로 구현하고 검증합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `PaneTabStore`가 `DiffTabState`의 `isPreview` 상태와 `openDiffTab`의 `pinned` 옵션을 지원하며, 한 **편집기 영역** 내 Preview **Diff 탭**은 최대 1개만 유지됩니다.
- [ ] 단일 클릭(`pinned` 미지정) 시 동일 키 탭이 없으면 기존 Preview **Diff 탭**을 교체하고, 이미 열린 고정 탭을 단일 클릭하면 포커스만 이동하며 Preview로 강등되지 않습니다.
- [ ] `pinned: true`(파일 행 더블클릭 또는 `Shift+클릭`)로 열면 기존 Preview 탭이 Preview→고정으로 승격되거나, 새 고정 **Diff 탭**이 추가되어 여러 **Diff 탭**을 동시에 열어둘 수 있습니다.
- [ ] **탭 바**에서 Preview **Diff 탭**은 이탤릭체 스타일(`.is-preview`)로 구분 표시되며, Preview 탭을 더블클릭하면 고정(`isPreview: false`)으로 전환됩니다.
- [ ] 다른 **편집기 영역**으로 복제·이동, 창 간 탭 드롭, 분할 해제 병합 시에도 영역당 Preview 최대 1개 불변식이 유지됩니다.
- [ ] **Compare 패널**의 Base/Compare Ref 또는 3-dot/2-dot 모드 변경 시, 고정 여부와 무관하게 열려 있는 모든 `branch-compare` **Diff 탭**이 새 기준으로 일괄 갱신(범위 밖 파일은 닫기)되고 각 탭의 `isPreview` 상태가 보존됩니다.
- [ ] **Compare 패널** 파일 트리, **Git 뷰** **Changes 섹션**(리스트·트리), 커밋 상세 및 Stash 상세 파일 목록에서 클릭(Preview)과 더블클릭/`Shift+클릭`(Pinned) 제스처가 일관되게 동작합니다.
- [ ] `PaneTabStore` 단위 테스트 및 App 통합 테스트(Compare·Git)로 전체 시나리오를 검증하고 타입 체크·테스트 스위트가 통과합니다.
