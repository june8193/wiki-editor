# 01 — Git 패널 상단 공통 영역 분리 및 Changes·Graph 상하 분할 아코디언

**Spec:** [spec.md](../spec.md)

**What to build:** Git 패널 최상단 헤더에서 액티비티 바와 중복되던 전체 접기 토글을 제거하고, 브랜치 선택·전환과 `Pull` / `Push` / `Sync` 버튼을 상단 고정 공통 영역에 배치합니다. 그 아래 본문을 **Changes 섹션**(변경 파일 수 배지 + 커밋 입력폼 + 스테이지됨/변경 사항 목록)과 **Graph 섹션**(접기/펼치기 헤더 + 초기 빈 안내 영역) 상하 분할 아코디언으로 나누고, 두 섹션이 모두 펼쳐져 있을 때 중간 가로 **섹션 리사이저**로 높이 비율을 조절합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] **Git 패널** 최상위 영역의 기존 접근 가능한 이름(`aria-label="Git 소스 제어"`)이 유지되고, 최상단 헤더에는 전체 접기 토글 없이 `Git` 타이틀·브랜치 배지·`↑ahead ↓behind` 배지·`Git 상태 새로고침` 버튼이 고정 표시됩니다.
- [x] 워크스페이스 미열림, 상태 로딩 중, 비저장소(`!status.isRepo`) 상태에서는 분할 아코디언을 렌더링하지 않고 기존 안내 문구 및 `Git 저장소 초기화 (git init)` 버튼이 회귀 없이 동작합니다.
- [x] 저장소(`status.isRepo === true`)일 때 브랜치 선택·`브랜치 전환` 및 `Pull` / `Push` / `Sync` 버튼(진행 중 상태 배너 및 오류 배너 포함)이 상단 고정 공통 영역에 위치하여, **Changes 섹션**을 접은 상태에서도 브랜치 전환과 원격 동기화가 동작합니다.
- [x] **Changes 섹션** 헤더의 접기/펼치기 버튼(`aria-expanded`)에 `Changes` 라벨과 총 변경 파일 수(`staged + unstaged + untracked`) 배지가 표시되며, 본문에 커밋 메시지 입력폼(`Ctrl+Enter` 제출 포함)과 `스테이지됨`·`변경 사항` 목록이 독립 세로 스크롤 영역으로 렌더링됩니다.
- [x] **Graph 섹션** 헤더의 접기/펼치기 버튼(`aria-expanded`)에 `Graph` 라벨이 표시되고 개별적으로 접고 펼칠 수 있습니다(실제 커밋 그래프 데이터 연동은 02번 티켓 범위).
- [x] 섹션 높이 비율 제한 순수 함수가 기본값 `0.5`(`50%`), 제한 범위 `0.2~0.8`(`20%~80%`)을 계산하며 경계값 단위 테스트가 있습니다.
- [x] 두 섹션이 모두 펼쳐져 있을 때만 중간에 가로 **섹션 리사이저**(`role="separator"`, `aria-orientation="horizontal"`, `aria-valuenow/min/max`, 접근 가능한 이름 예: `Git 섹션 높이 조절`)가 표시되며, 포인터 드래그(`row-resize`), 상·하 방향키 조절, 더블클릭 기본값(`50%`) 복원이 동작합니다.
- [x] 한쪽 섹션을 접으면 **섹션 리사이저**가 숨겨지고 펼쳐진 섹션이 남은 높이를 모두 차지하며, 다시 펼치면 직전 높이 비율이 유지됩니다(세션 메모리 전용, `config.json` 비저장).
- [x] `<App />` 통합 테스트가 상단 공통 영역 동작(**Changes 섹션** 접힘 중 브랜치 전환·동기화), 두 섹션 접기/펼치기 전이, **섹션 리사이저** 키보드 조절·더블클릭 복원을 검증합니다.
- [x] `CONTEXT.md`의 **Git 패널** 정의를 갱신하고 **Changes 섹션**, **Graph 섹션**, **섹션 리사이저** 용어를 추가합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `cf27f5c`, `ca0a22a`
- Verification: `npm run typecheck`, `npm test` (`40 passed (40)`, `247 passed (247)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings after 2 iterations.
