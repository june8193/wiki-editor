# Changelog

모든 주요 변경사항은 이 파일에 기록됩니다.
이 프로젝트는 [Semantic Versioning](https://semver.org/lang/ko/) 및 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 표준을 준수합니다.

---

## [1.1.0] - 2026-11-15

### Added
- 구조화된 상시 JSONL 앱·에러 로깅(`LogService`, 2MB×3 파일 자동 로테이션, 문서·설정 원문 제외 마스킹) 및 Main 생명주기·IPC·Git·설정 복구 자동 수집 ([상세 스펙](.backlog/done/app-error-logging/spec.md), [티켓 01](.backlog/done/app-error-logging/issues/01-main-log-service-and-help-report.md))
- Preload `window.wikiApi.log` 브리지 기반 렌더러 미처리 예외·오류 배너·Git·Mermaid 오류 수집 및 주요 UI 동작(탭·에디터 모드·화면 분할·워크스페이스) Breadcrumb 로깅 ([티켓 02](.backlog/done/app-error-logging/issues/02-renderer-breadcrumbs-and-error-logging.md))
- 애플리케이션 메뉴 바 `Help` 메뉴 추가: AI 진단용 마크다운 리포트를 클립보드에 복사하는 `Copy Bug Report`, 로그 폴더를 여는 `Open Log Folder`, 앱·런타임 버전을 표시하는 `Version` 다이얼로그 ([티켓 01](.backlog/done/app-error-logging/issues/01-main-log-service-and-help-report.md))
- 문서 탭 드래그 기반 상하 분할(`vertical`) 드롭 영역 및 분할 상태에서의 좌우↔상하 방향 전환 드롭 지원 ([티켓 01](.backlog/done/redesign-app-header/issues/01-drag-split-horizontal-and-vertical.md))
- 앱 실행 시 마지막으로 열었던 최근 워크스페이스 자동 복원 (유효하지 않은 경로는 최근 목록에서 자동 정리)

### Changed
- 내부 앱 헤더(`<header class="app-header">`)를 제거하고 `File`(`폴더 열기...`), `Edit`, `View`(`테마 전환`), `Settings`(`설정 패널`), `Window`, `Help` 구성의 네이티브 애플리케이션 메뉴 바로 일원화하여 세로 편집 공간 확대 ([상세 스펙](.backlog/done/redesign-app-header/spec.md), [티켓 03](.backlog/done/redesign-app-header/issues/03-application-menu-bar-and-headerless-shell.md))
- 워크스페이스 전환기 드롭다운을 왼쪽 사이드바 폴더 트리 상단 헤더로 통합하여 미열림 초기 상태에서도 즐겨찾기·최근 워크스페이스 즉시 전환 지원 ([티켓 02](.backlog/done/redesign-app-header/issues/02-sidebar-workspace-switcher.md))
- 상단 화면 분할 모드 버튼 그룹을 제거하고 드래그 앤 드롭 및 탭 컨텍스트 메뉴 중심으로 화면 분할 UX 단순화 ([티켓 01](.backlog/done/redesign-app-header/issues/01-drag-split-horizontal-and-vertical.md))

## [1.0.0] - 2026-11-14

### Added
- Electron + React 19 + TypeScript 기반 데스크톱 위키 에디터 스캐폴딩, `config.json` 전역 설정 관리, `window.wikiApi` IPC 브릿지 및 라이트/다크 테마 ([상세 스펙](.backlog/done/wiki-editor-v1/spec.md))
- 워크스페이스 폴더 트리(지연 로딩), 파일/폴더 CRUD, 즐겨찾기, `Ctrl+S` 저장 및 자동 저장(Auto-save) 지원 ([티켓 02](.backlog/done/wiki-editor-v1/issues/02-workspace-folder-tree-and-favorites.md))
- 중앙 문서 버퍼 스토어 기반 멀티 탭 및 2분할 Split View 레이아웃 ([티켓 03](.backlog/done/wiki-editor-v1/issues/03-multi-tab-and-split-pane-layout.md))
- Raw(CodeMirror 6), WYSIWYG(TipTap), Preview 3모드 마크다운 에디터 및 표 행/열 편집 기능 ([티켓 04](.backlog/done/wiki-editor-v1/issues/04-three-mode-markdown-editor-and-table.md))
- Mermaid 다이어그램 인라인 렌더링, 사이드바 Outline 목차(TOC) 및 하이브리드 헤딩 자동 넘버링 ([티켓 05](.backlog/done/wiki-editor-v1/issues/05-mermaid-toc-and-auto-numbering.md))
- 사용자 정의 커스텀 슬래시 명령어 엔진, 에디터 자동완성 및 설정 UI ([티켓 06](.backlog/done/wiki-editor-v1/issues/06-custom-slash-commands.md))
- 워크스페이스 Git 연동 패널(변경 파일 상태, Stage/Unstage, Commit, Pull/Push/Sync, 브랜치 전환) ([티켓 07](.backlog/done/wiki-editor-v1/issues/07-git-workspace-integration.md))
- `electron-builder` 언팩 빌드 스크립트(`build:unpack`) 및 UI 용어 문서 추가

