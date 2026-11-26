# 04 — Git Diff 뷰어 EUC-KR 및 혼합 인코딩 패치 지원

**Spec:** [spec.md](../spec.md)

**What to build:** **Diff 뷰어**가 `unstaged`, `staged`, `commit`, `stash`, `branch-compare` 및 미추적 새 파일 등 모든 Git Diff 모드에서 EUC-KR 파일과 UTF-8 ↔ EUC-KR 전환 패치를 한글 깨짐 없이 디코딩하도록 `GitService.diff`를 확장합니다.

**Blocked by:** 01-text-encoding-codec-and-workspace-fs

**Status:** ready-for-agent

- [ ] 통합 패치(unified diff) 출력이 줄 단위 엄격 UTF-8 검증 후 CP949 폴백으로 디코딩되어, 순수 EUC-KR 파일 변경분은 물론 한 커밋 내에서 `UTF-8` ↔ `EUC-KR`로 인코딩이 바뀐 Diff도 `-`/`+` 줄 모두 깨지지 않는다.
- [ ] 미추적(untracked) EUC-KR 새 파일의 가상 Diff 생성 시 전체 버퍼 자동 감지로 올바르게 디코딩된다.
- [ ] `GIT_DIFF_MAX_BYTES` 크기 제한으로 패치가 절단될 때 UTF-8 및 CP949 멀티바이트 문자 경계가 깨지지 않도록 안전하게 절단한다.
- [ ] 기존 바이너리 파일 판별(`hasNullByte` 및 `Binary files ... differ`)과 경로 보안 동작이 회귀 없이 유지되며, 격리된 Git 샌드박스 테스트가 모두 통과한다.
