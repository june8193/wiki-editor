# 02 — 시점별 Git 스냅샷 블롭 읽기 및 온디맨드 심볼·식별자 검색 백엔드·IPC 구현

**Spec:** [spec.md](../spec.md)

**What to build:** 상주 인덱서나 메인 프로세스 파서 번들 추가 없이, 지정된 Git 시점(`commit`, `branch-compare`의 `base`/`compare`/`mergeBase`, `stash` 및 미추적 `^3`, `staged` 인덱스)의 단일 파일 원문을 읽는 블롭 스냅샷 API와 워킹트리(열린 미저장 **문서 버퍼**·미추적 파일 반영) 또는 특정 Git Ref 범위에서 식별자 일치·선언부 후보를 온디맨드로 조회하는 검색 API를 공유 스키마, 메인 서비스, IPC, 프리로드 브리지, 인메모리 테스트 하네스까지 엔드투엔드로 구현합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 공유 스키마에 `CodeSourceScope`, `GitBlobSnapshotRequest`, `GitBlobSnapshot`, `SymbolQueryRequest`, `SymbolCandidateMatch` 계약을 정의하고 `WikiGitApi`·`WikiWorkspaceApi`·IPC·프리로드 브리지·인메모리 테스트 하네스에 노출한다.
- [ ] Git 블롭 스냅샷 읽기가 `commit`, `branch-compare`, `stash`(미추적 `^3` 포함), `staged` 인덱스 시점의 파일 원문을 반환하며, 바이너리 판별, `2MB` 상한 절단(`isTruncated`), `existsInWorkspace`, 엄격 UTF-8 후 EUC-KR 자동 디코딩을 일관되게 처리한다.
- [ ] 온디맨드 심볼·식별자 검색이 Git 저장소 및 지정 Ref에서는 `git grep -n -w -I`를, 비Git 폴더 및 워킹트리 열린 미저장 **문서 버퍼**·미추적 파일에 대해서는 기존 경량 스캐너를 결합해 일치·선언 후보를 반환한다.
- [ ] 모든 스캔·Git 조회에 Single-flight 취소(`AbortSignal`·하위 프로세스 종료), 결과 상한, `.git`·`.wiki-editor`·`node_modules` 제외, Ref·경로 인젝션 차단 및 활성 워크스페이스 세션 격리를 적용한다.
- [ ] `package.json`의 런타임 `dependencies`가 `node-pty` 단독 구성으로 유지되고 메인 프로세스에 렌더러 파서 번들이 유입되지 않으며, 실제 임시 Git 샌드박스 통합 테스트가 모두 통과한다.
