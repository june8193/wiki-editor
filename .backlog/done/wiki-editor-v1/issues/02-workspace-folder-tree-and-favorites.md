# 02 — 워크스페이스 폴더 트리(지연 로딩·파일 CRUD·저장) 및 즐겨찾기 관리

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 01-electron-react-scaffold-and-config
Status: resolved

**What to build:**
VS Code처럼 로컬 폴더를 워크스페이스로 열어 지연 로딩(Lazy Loading) 기반 폴더 트리를 탐색하고, 새 문서/폴더 생성·이름 변경·삭제, 파일 열기/저장(`Ctrl+S` 수동 저장 + 미저장 `●` 배지 + Auto-save 설정 토글), 그리고 전역 `config.json`에 즐겨찾는 워크스페이스를 등록·전환하는 E2E 흐름을 구현합니다.

## Acceptance Criteria

- [x] `WorkspaceFsService`가 Main 프로세스에서 비동기로 디렉토리 엔트리를 1-depth씩 지연 조회(폴더 우선 정렬, `.git`/`node_modules` 등 시스템 폴더 필터/표시 정책 일관성)하며, 워크스페이스 루트 밖 경로 접근(Path Traversal)을 차단합니다.
- [x] 폴더 다이얼로그로 로컬 워크스페이스를 열 수 있으며, 좌측 사이드바 폴더 트리에서 마우스 클릭으로 폴더 확장/축소, 새 파일(`.md`)·새 폴더 생성, 이름 변경(F2/우클릭 메뉴), 삭제(확인 후 휴지통/삭제)를 수행할 수 있습니다.
- [x] 전역 `config.json`의 `favoriteWorkspaces` 및 `recentWorkspaces`와 연동되어 현재 워크스페이스를 즐겨찾기 추가/해제하고, 사이드바/런처 드롭다운에서 원클릭으로 다른 즐겨찾기 워크스페이스로 전환할 수 있습니다.
- [x] 문서 저장은 `Ctrl+S` 수동 저장(미저장 변경 시 `isDirty` 상태 및 `●` 배지 표시)과 설정의 `autoSave` 토글(디바운스 자동 저장)을 모두 지원하며, `config.json` 자체를 열어 편집·저장할 경우 즉시 스키마 검증 후 앱 설정에 반영됩니다.
- [x] 모든 파일 시스템 CRUD, 경로 보안 검증, 즐겨찾기, Auto-save 테스트는 `fs.mkdtemp` 임시 디렉토리에서 격리 수행(TDD)되고 모두 통과합니다.

## Answer

- **구현 내용**:
  - `src/shared/workspace.ts`, `src/shared/config.ts`, `src/shared/ipc.ts`: 워크스페이스 엔트리/요약/변경 이벤트 타입, 경로 정규화·비교 헬퍼, `validateConfigRaw`, `favoriteWorkspaces`/`recentWorkspaces` 관리 헬퍼, `workspace:*` 및 추가 `config:*` IPC 계약 정의
  - `src/main/workspace/WorkspaceFsService.ts`, `src/main/config/ConfigService.ts`, `src/main/ipc/registerWorkspaceIpc.ts`, `src/main/ipc/registerConfigIpc.ts`: 1-depth 지연 폴더 조회(폴더 우선 정렬, `.git`/`node_modules` 등 무시 및 심볼릭 링크/dangling symlink 경로 탈출 차단), 파일 CRUD(`readFile`, `writeFile`, `createEntry`, `renameEntry`, `deleteEntry`), 파일 감시(`watch`/`unwatch`), 즐겨찾기/최근 워크스페이스 및 `saveRaw` 구현
  - `src/preload/wikiApi.ts`, `src/renderer/src/hooks/`, `src/renderer/src/components/`: `WorkspaceSwitcher`, `FolderTreeSidebar`, `DocumentEditor`, `ConfirmDialog`, `SettingsPanel` 연동으로 폴더 트리 탐색/CRUD, 즐겨찾기 전환, `Ctrl+S`/`●` 배지/디바운스 Auto-save 및 `config.json` 직접 편집·검증 반영 구현
- **검증 결과**: `npm test`(9개 파일 51개 테스트), `npm run typecheck`, `npm run build` 모두 통과 (최종 커밋 `5a02e7b`, 4회 `/code-review` Standards/Spec 루프 통과)
