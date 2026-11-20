# 01 — Stashes 섹션 3단 아코디언, Changes 원클릭 Stash 및 Pop/Apply 복원

**Spec:** [spec.md](../spec.md)

**What to build:** 공유 Stash 스키마(`GitStashEntry`, `GitStashScope`, `GitStashCreateOptions`)와 IPC/Preload 계약(`git:stash-list`, `git:stash-create`, `git:stash-apply`, `git:stash-pop`) 및 실제 Git 서비스 로직(첫 커밋 전 `isUnborn` 방어, `Staged Changes`를 유지한 `Changes` 전용 Stash와 `MM` 동시 변경 `--keep-index` 폴백, 미추적 `?` 포함, 충돌 시 Stash 보존 `pop`/`apply`, 미커밋 변경 차단 오류 안내 보강)을 구현합니다. 이와 함께 **Git 패널**의 **Changes 섹션**과 **Graph 섹션** 사이에 항상 표시되는 **Stashes 섹션**(0건 기본 접힘, Stash 생성 시 자동 펼침, 컴팩트 최대 높이 내부 스크롤, 기존 단일 **섹션 리사이저** 유지)을 배치하고, `Changes` 하위 그룹 헤더 원클릭 Stash 및 Stash 행의 `Pop`/`Apply` 복원, 미저장(`●`) **문서 버퍼** 확인 및 작업 후 **메인 창**·**보조 창** 버퍼·**폴더 트리**·열린 `unstaged` **Diff 탭** 동기화까지 엔드투엔드로 완결합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 공유 `WikiGitApi` 계약(`stashList`, `stashCreate`, `stashApply`, `stashPop`), 해당 IPC 채널(활성 워크스페이스 일치 검증 포함), Preload `window.wikiApi.git` 브리지 메서드가 구현되고 경계 단위 테스트가 통과합니다.
- [ ] Git 서비스가 `stashRef`(`^stash@\{\d+\}$`) 형식 및 저장소 경로 경계(`.git` 세그먼트 및 심볼릭 링크 탈출 차단)를 검증하며, 격리된 임시 실제 Git 저장소 통합 테스트에서 다음을 모두 검증합니다: (a) `scope: 'unstaged'`가 분리된 `Staged Changes`를 보존한 채 `Changes`와 미추적(`?`) 새 문서만 보관(동일 파일 `MM` 공존 시 `--keep-index` 폴백), (b) `scope: 'all'`·`scope: 'paths'`·`includeUntracked: false`·빈 대상/첫 커밋 전(`isUnborn`) 오류 처리, (c) `stashApply`·`stashPop`의 워킹 트리(`Changes`) 복원 및 충돌 시 해당 Stash 보존과 오류 반환, (d) 미커밋 로컬 변경 차단 오류의 Stash 안내 문구 포함.
- [ ] **Git 패널** 분할 상태 순수 함수 단위 테스트가 `isStashesCollapsed` 기본값(`true`)·토글 및 **Changes 섹션**·**Graph 섹션** 접힘 조합에 따른 **섹션 리사이저**(`20%~80%`, 기본 `50%`)·높이 배분 규칙(양쪽 중 하나라도 펼쳐진 경우 컴팩트 영역, 모두 접힌 경우 남은 공간 채움)을 검증합니다.
- [ ] **Git 패널**에 **Changes 섹션** → **Stashes 섹션** → **Graph 섹션** 3단 아코디언이 항상 렌더링되며, **Stashes 섹션** 헤더에는 접기/펼치기 토글과 보관 개수 배지가 표시되고 `0`건일 때 기본 접힘·Stash 생성 성공 시 자동 펼침(워크스페이스 전환 시 초기화)으로 동작합니다.
- [ ] `Changes` 하위 그룹 헤더의 `전체 롤백` 왼쪽에 원클릭 Stash 아이콘(`aria-label="Changes만 Stash"`, `Changes` 0건 또는 작업 중 비활성화)이 배치되어 클릭 시 `Staged Changes`는 그대로 둔 채 `Changes`(미추적 `?` 포함)만 즉시 보관하며, 보관 후 **Stashes 섹션** 각 행에는 메시지·`stash@{n}`·포맷된 시각 및 `Pop`·`Apply` 액션 버튼이 표시됩니다.
- [ ] `stashCreate` 전에는 보관 대상 경로에 한정해(비대상 미저장 문서는 무간섭), `stashApply`/`stashPop` 전에는 워크스페이스 전체에 대해 미저장(`●`) **문서 버퍼** 확인(`'저장 후 진행'` / `'저장 없이 진행'` / `'취소'`)이 동작하며, 완료 후 **메인 창**·**보조 창**의 열린 **문서 버퍼**(사라진 미추적 문서 탭 자동 닫기 및 `'저장 없이 진행'` 시 자동 저장 재덮어쓰기 차단 포함)·**폴더 트리**·**액티비티 바** 배지·영향받은 `unstaged` **Diff 탭**이 즉시 동기화됩니다.
- [ ] `<App />` 멀티 윈도우 통합 테스트가 "1개 문서 Staged 유지 → `Changes` 원클릭 Stash → 동기화 완료 → `Pop`·`Apply` 복원(충돌 시 보존 포함) 및 **보조 창** 버퍼·Diff 탭 동기화" 흐름을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
