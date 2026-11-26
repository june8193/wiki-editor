# 04 — 불변 Diff 세션 LRU 캐시 및 무깜빡임 파일 순회 전환

**Spec:** [spec.md](../spec.md)

**What to build:** **메인 창**과 **보조 창**에서 이미 불러온 불변 Diff(`branch-compare`, `commit`, `stash`)를 개수·바이트 상한이 있는 세션 LRU 캐시에 보존하고 스토어 스냅샷 갱신을 병합해, **Compare 패널** 파일 클릭이나 이전/다음(`↑`/`↓`) 순회로 재방문할 때 IPC 재호출과 `"Diff 불러오는 중..."` 깜빡임 없이 즉시 전환되게 합니다.

**Blocked by:** 01-fast-branch-compare-git-backend

**Status:** resolved

- [x] 단일 **Diff 탭**의 대상이 다른 파일로 교체되어도 로드 완료된(`loaded`) `branch-compare`·`commit`·`stash` Diff를 즉시 삭제하지 않고 항목 수 및 총 패치 바이트 예산 상한이 있는 세션 LRU 캐시에 보존한다(`error` 상태는 재시도 가능하도록 고정 캐싱하지 않으며, 현재 열린 탭 항목은 퇴거 대상에서 제외).
- [x] 캐시에 존재하는 파일로 다시 전환(**Compare 패널** 목록 클릭, `↑`/`↓` 파일 탐색, 커밋/Stash 파일 재선택 및 **보조 창** 포함)할 때 `git.diff` IPC를 다시 호출하지 않고 `'loading'` 중간 상태 없이 즉시 Diff 본문을 표시하며, 탭 전환 시 중복 동기 스냅샷 알림을 단일 알림으로 병합한다.
- [x] 가변 워킹 트리 Diff(`staged`, `unstaged`)는 기존과 동일하게 Git 상태 갱신 시 최신 패치로 새로고침되고 탭 닫힘 시 정리된다.
- [x] Stash `Pop`·`Drop`·`Clear All` 등으로 목록에서 제거된 `stashHash`의 캐시 항목을 즉시 정리하고, 워크스페이스 전환 및 세션 종료 시 캐시 전체를 초기화한다.
- [x] `App` + 인메모리 `WikiApi` 하네스 통합 테스트 심(**메인 창** 및 다중 창 **보조 창** 포함)에서 파일 재방문 시 `git.diff` 중복 호출 0회, LRU 용량/바이트 상한 초과 퇴거, Stash 제거 및 워크스페이스 전환 무효화, 워킹 트리 Diff 실시간 갱신 유지를 검증한다.
