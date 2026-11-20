# 02 — 개별 파일 원클릭 Stash, 메시지 입력 대화상자 및 Drop/Clear All 확인 다이얼로그

**Spec:** [spec.md](../spec.md)

**What to build:** `stashDrop`·`stashClear` IPC/Preload/GitService 계약을 추가하고, `Changes` 개별 파일 행 호버/포커스 액션에 원클릭 Stash 아이콘(`aria-label="${file.path} Stash"`)을 추가합니다(`Staged Changes` 파일 행에는 미노출). 또한 **Stashes 섹션** 헤더의 `+` 버튼 및 **Git 패널** `...` 더 보기 메뉴(`Stash Changes...`, `Stash All Changes...`)에서 선택적 메시지·보관 범위(`Changes만 보관 (Staged 유지)` / `전체 보관 (Staged 포함)`)·`미추적 파일(?) 포함` 옵션을 지정하는 Stash 입력 다이얼로그를 제공하고, Stash 행의 `Drop`과 **Stashes 섹션** 헤더·`...` 메뉴의 `Clear All`을 위험 강조(`danger`) **확인 다이얼로그**와 함께 엔드투엔드로 완결합니다.

**Blocked by:** 01-stashes-section-quick-stash-and-restore

**Status:** ready-for-agent

- [ ] 공유 `WikiGitApi`에 `stashDrop`·`stashClear` 메서드, IPC 채널(`git:stash-drop`, `git:stash-clear` — 활성 워크스페이스 일치 검증 포함), Preload 브리지 메서드가 추가되고 경계 단위 테스트 및 격리된 임시 실제 Git 저장소 통합 테스트(`drop` 시 `stashRef` 재정렬 반영, `clear` 후 빈 목록 반환, 잘못된 `stashRef` 차단)가 통과합니다.
- [ ] **Changes 섹션**의 `Changes` 각 파일 행 호버/포커스 액션 영역에 원클릭 Stash 아이콘(`aria-label="${file.path} Stash"`)이 추가되고(`Staged Changes` 파일 행에는 미노출, 비호버 시 파일명·디렉토리 경로 가림 없음), 클릭 시 **Diff 탭**을 열지 않은 채 해당 파일 1개만 Stash하며 대상 파일 한정 미저장(`●`) **문서 버퍼** 확인·**메인 창**/**보조 창** 버퍼 동기화·대상 `unstaged` **Diff 탭** 자동 닫기가 동작합니다.
- [ ] **Stashes 섹션** 헤더에 `+`(변경 사항 `0`건 또는 작업 중 비활성화)와 `Clear All`(Stash `0`건 또는 작업 중 비활성화) 액션 버튼이 추가되고, **Git 패널** `...` 더 보기 메뉴에 `Stash Changes...`, `Stash All Changes...`, `Clear All Stashes`(`danger: true`) 항목이 추가됩니다.
- [ ] **Stashes 섹션** 헤더 `+` 또는 `...` 메뉴의 `Stash Changes...` / `Stash All Changes...` 클릭 시 가벼운 Stash 입력 다이얼로그가 열리며, 선택적 메시지(빈 값 허용), 보관 범위(`Changes만 보관 (Staged 유지)` / `전체 보관 (Staged 포함)`), `미추적 파일(?) 포함`(기본 체크)을 지원하고 `Enter` 즉시 보관·`Esc` 취소로 동작하며 보관 성공 시 **Stashes 섹션**이 자동으로 펼쳐집니다(`scope: 'all'` 실행 시 전체 변경 대상 버퍼·`staged`/`unstaged` Diff 탭 동기화 포함).
- [ ] 각 Stash 행에 `Drop` 버튼이 추가되고, `Drop`과 `Clear All` 실행 시 기존 `ConfirmDialogTone = 'danger'` **확인 다이얼로그**(대상 참조·메시지 또는 총 개수 및 영구 삭제 불가 안내 명시)를 표시해 확인 시에만 삭제하고 취소 시 목록을 그대로 유지합니다.
- [ ] `<App />` 멀티 윈도우 통합 테스트가 개별 파일 원클릭 Stash, Stash 입력 다이얼로그(`Enter`/`Esc`/메시지/범위/미추적 옵션), `Drop` 및 `Clear All` 위험 확인·취소 시나리오를 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
