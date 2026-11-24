# 01 — 브랜치·워크트리 비교 Git 백엔드 및 IPC 계약 구현

**Spec:** [spec.md](../spec.md)

**What to build:** 로컬/원격 브랜치 및 연결된 워크트리(Detached HEAD 포함 커밋된 `HEAD`) 목록 조회, `3-dot` / `2-dot` 비교 요약(변경 파일 목록 + 파일별/전체 `+N -M` 통계 + 포함 커밋 목록), 그리고 `branch-compare` 파일 Diff 조회를 공유 스키마부터 Git 서비스, IPC, 프리로드 API까지 엔드투엔드로 구현합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [ ] 공유 Git 타입에 `GitCompareRefList`, `GitCompareSummary`, `GitCompareChangedFile`, `GitCompareMode` 및 `GitDiffRequest`의 `'branch-compare'` 분기를 추가하고, `WikiGitApi`에 `compareRefs`·`compareSummary` 메서드를 노출한다.
- [ ] `compareRefs`가 `refs/heads/*`, `refs/remotes/*`(`*/HEAD` 제외), `git worktree list --porcelain`(워크트리 폴더명·체크아웃 브랜치·Detached HEAD 단축 해시)을 파싱하고, `defaultBaseRef`(`origin/HEAD` → `main` → `master` 폴백)와 `currentRef`를 반환한다.
- [ ] `compareSummary`가 `three-dot`(`base...compare`)과 `two-dot`(`base..compare`) 모드에 따라 변경 파일(`--name-status -M`), 파일별/전체 줄 수 통계(`--numstat`), 바이너리 여부, 포함 커밋 목록(`base..compare`)을 반환한다.
- [ ] `diff`가 `kind: 'branch-compare'` 요청을 받아 `three-dot`/`two-dot` 범위의 단일 파일 패치, 바이너리 여부, 1MB 절단(`isTruncated`), `existsInWorkspace`를 반환한다.
- [ ] 리비전 인젝션(선행 `-`, 공백, 제어문자, `..` 포함 단일 Ref), 경로 탈출/`.git` 접근, 비Git 폴더/첫 커밋 전(`isUnborn`) 예외, 활성 워크스페이스 외 경로 IPC 호출을 차단하며, `GitService` + `registerGitIpc` 실제 임시 Git 샌드박스 통합 테스트가 모두 통과한다.
