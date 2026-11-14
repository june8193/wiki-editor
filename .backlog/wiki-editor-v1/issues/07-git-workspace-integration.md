# 07 — 워크스페이스 Git 연동 패널 (Status, Stage, Commit, Pull, Push, Branch)

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 02-workspace-folder-tree-and-favorites
Status: resolved

**What to build:**
열려 있는 워크스페이스의 Git 저장소 상태를 사이드바 Git 패널에서 확인하고, 변경 파일 선택/전체 Stage 및 Unstage, 커밋 메시지 입력 후 Commit, Pull, Push, 원클릭 Sync, 현재 브랜치 확인 및 전환을 비동기로 수행할 수 있는 Git 통합 기능을 구현합니다.

## Acceptance Criteria

- [x] `GitService`가 Electron Main 프로세스에서 인자 배열(`execFile('git', ...)` 또는 `simple-git`)을 사용해 비동기로 동작하며 UI 스레드를 차단하지 않고 셸 인젝션을 방지합니다.
- [x] 워크스페이스가 Git 저장소인 경우 Git 패널에 현재 브랜치명, Ahead/Behind 카운트, Staged 변경 파일 및 Unstaged/Untracked 파일 목록(상태 배지 `M`/`A`/`D`/`?`)이 표시됩니다. (비-Git 폴더일 때는 안내 메시지 및 `git init` 초기화 버튼 옵션 제공)
- [x] 파일별/전체 Stage(`+`) 및 Unstage(`-`), 커밋 메시지 입력 검증(빈 메시지 방지) 후 `Commit`, 그리고 `Pull`, `Push`, 원클릭 `Sync(Pull -> Push)` 버튼이 로딩 인디케이터와 함께 동작합니다.
- [x] 브랜치 선택 드롭다운(또는 모달)에서 로컬 브랜치 목록 조회 및 체크아웃(전환)을 지원하며, 미저장/충돌/인증 실패 등 Git 오류 발생 시 앱이 멈추지 않고 구체적인 오류 메시지를 패널에 표시합니다.
- [x] Pull/Checkout 등으로 워크스페이스 파일이 변경되면 열려 있는 에디터 버퍼/폴더 트리가 안전하게 새로고침(충돌 없는 저장 파일 자동 갱신, 미저장 버퍼는 경고/확인)됩니다.
- [x] 모든 `GitService` 통합 테스트는 `fs.mkdtemp`로 생성한 격리된 임시 Git 저장소 및 로컬 bare remote 환경에서 실제 Git 명령을 실행해 TDD로 검증되며(본 리포지토리 `.git` 비접촉), UI 패널 테스트도 모두 통과합니다.

## Answer

- **구현 내용**:
  - `src/shared/git.ts`, `src/shared/ipc.ts`, `src/preload/wikiApi.ts`: Git 상태/변경 파일/브랜치/Sync 결과 타입 및 `git:*` 12개 IPC 채널과 `window.wikiApi.git` 브릿지 정의
  - `src/main/fs/pathSecurity.ts`, `src/main/git/GitService.ts`, `gitPorcelain.ts`, `gitErrors.ts`, `registerGitIpc.ts`: `execFile('git', args)` 인자 배열 실행, `--` 구분자 및 경로 검증(서브디렉토리 워크스페이스/리네임 unstage/초기 unborn HEAD 지원), `GIT_TERMINAL_PROMPT=0`·`LC_MESSAGES=C`·`core.quotePath=false` 적용 및 구조화된 오류 매핑
  - `src/renderer/src/hooks/useGitController.ts`, `src/renderer/src/components/GitSidebarPanel.tsx`, `useEditorWorkspace.ts`, `App.tsx`: 비-Git 안내 및 `git init`, 브랜치·Ahead/Behind·Staged/Changes 표시, 개별/전체 Stage·Unstage, 빈 커밋 방지 + Commit, Pull/Push/Sync 로딩·오류 배너, Pull/Checkout 전 미저장 확인 다이얼로그 및 디스크 변경 시 클린 버퍼 자동 갱신·미저장 버퍼 충돌 경고 구현
- **검증 결과**: `npm test`(29개 파일 175개 테스트, 임시 디렉토리 + 로컬 bare remote 실제 git 통합 테스트 포함), `npm run typecheck`, `npm run build` 모두 통과 (최종 커밋 `cb05d60`, 3회 `/code-review` Standards/Spec 루프 통과)
