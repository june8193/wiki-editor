# 03 — 액티비티 바 Compare 뷰, Ref 피커 및 Files 단일 파일 Diff 탐색

**Spec:** [spec.md](../spec.md)

**What to build:** **액티비티 바**에 **Compare 뷰**를 추가하고, **왼쪽 사이드바**의 **Compare 패널**(Worktree/Local/Remote 검색 피커, `⇄` 스왑, `3-dot`/`2-dot` 전환, 요약 `+N -M`, **Files** 압축 폴더 트리 및 파일명 필터)과 우측 활성 **편집기 영역**의 단일 파일 포커스 **Diff 탭**(이전/다음 파일 이동)을 엔드투엔드로 연결합니다.

**Blocked by:** 01-branch-compare-backend-and-ipc

**Status:** resolved

- [ ] **액티비티 바**에 **Compare 뷰** 아이콘을 추가해 **왼쪽 사이드바**에서 **Compare 패널**을 단독 표시하고(활성 아이콘 재클릭 시 사이드바 접기/펼치기), 비Git 저장소/워크스페이스 미열림 상태 안내를 제공한다.
- [ ] `Base` / `Compare` Ref 선택기 팝오버에서 `Worktrees`, `Local Branches`, `Remote Branches` 그룹 목록 및 실시간 검색 필터링을 지원하고, 초기 진입 시 기본 `Base`와 현재 `Compare`를 자동 선택하며 `⇄` 스왑과 새로고침을 동작시킨다.
- [ ] `3-dot (PR 방식)` ↔ `2-dot (직접 비교)` 전환 시 비교 요약(`files changed`, `+N -M`, 파일 목록)과 열린 Compare **Diff 탭**을 즉시 갱신한다.
- [ ] **Files** 패널에서 파일명 필터 입력창과 경로 압축 폴더 트리(상태 배지 및 파일별 `+N -M`)를 렌더링하고, 파일 클릭 시 활성 **편집기 영역**에 읽기 전용 `branch-compare` **Diff 탭**을 연다.
- [ ] `App` + 인메모리 `WikiApi` 하네스 통합 테스트 심으로 뷰 전환, Ref 피커·스왑, `3-dot`/`2-dot` 전환, 필터링, **Diff 탭** 열기 및 이전/다음 파일(`↑`/`↓`) 순회 이동, 워크스페이스 전환 시 세션 상태 초기화를 검증한다.
