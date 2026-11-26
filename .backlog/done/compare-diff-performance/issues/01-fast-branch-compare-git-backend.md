# 01 — Compare 및 Diff 조회 Git 프로세스 최소화·병렬화

**Spec:** [spec.md](../spec.md)

**What to build:** **Compare 패널**의 비교 요약 조회와 `branch-compare` 단일 파일 Diff 조회에서 반복되던 직렬 `git` 프로세스 스폰과 중복 `realpath`·`merge-base`·rename 탐지 실행을 제거·통합하고, 비교 요약의 `mergeBaseHash`를 Diff 요청 및 탭 동기화(**보조 창** 이동 포함)까지 엔드투엔드로 전달합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 공유 `GitDiffRequest`의 `'branch-compare'` 분기에 선택적 `mergeBaseHash?: string | null` 필드를 추가하되, **Diff 탭** 식별 키는 `mergeBaseHash` 유무와 무관하게 기존과 동일하게 유지한다.
- [x] **Compare 패널**에서 파일을 열 때와 Ref/모드 변경으로 열린 `branch-compare` **Diff 탭**을 동기화할 때(및 **보조 창**으로 탭을 분리·이동할 때) 현재 비교 요약의 `mergeBaseHash`를 요청에 포함해 전달한다.
- [x] `GitService`가 정규화된 워크스페이스 경로별 `repoRoot`를 `.git` 존재 확인 기반으로 안전하게 캐싱(실패·`init` 시 자동 재해석, 커스텀 `GIT_DIR` 환경에서는 우회)하고, `diff` 실행 시 중복 `realpath` 호출을 제거한다.
- [x] `diff`가 유효한 `mergeBaseHash`가 포함된 `branch-compare` 요청을 처리할 때 사전 `HEAD`·`merge-base` 자식 프로세스 없이 단일 `git diff` 프로세스 1회만 실행하며, `mergeBaseHash` 미전달 직접 호출 하위 호환과 비정상 `mergeBaseHash` 형식 차단·첫 커밋 전(`isUnborn`) 오류 메시지를 그대로 유지한다.
- [x] `compareSummary`가 사전 리비전 검증을 병렬화하고 변경 파일 상태/이름 변경(`-M`)과 줄 수/바이너리 통계를 단일 `git diff` 호출로 통합해, `3-dot`/`2-dot`·rename·바이너리·동일 Ref·포함 커밋 결과를 기존과 100% 동일하게 반환한다.
- [x] `GitService` + `registerGitIpc` 임시 Git 샌드박스 통합 테스트 심과 `App` 인메모리 하네스 테스트에서 프로세스 실행 횟수 단축, `mergeBaseHash` 전달·검증, 보안 경계 및 기존 비교 동작 회귀 없음을 검증한다.
