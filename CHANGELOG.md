# Changelog

모든 주요 변경사항은 이 파일에 기록됩니다.
이 프로젝트는 [Semantic Versioning](https://semver.org/lang/ko/) 및 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 표준을 준수합니다.

---

## [1.2.0] - 2026-11-15

### Added
- 좌측 액티비티 바(`탐색기` · `Git` · `워크스페이스` 단일 뷰 전환, 재클릭 접기/펼치기, Git 변경 파일 수 배지), 즐겨찾기·최근 목록을 통합한 전용 `워크스페이스 뷰`, 좌·우 사이드바 경계 드래그/키보드 리사이저 추가 ([상세 스펙](.backlog/done/sidebar-redesign/spec.md), [티켓 02](.backlog/done/sidebar-redesign/issues/02-activity-bar-and-view-switching.md), [티켓 03](.backlog/done/sidebar-redesign/issues/03-workspace-view.md), [티켓 04](.backlog/done/sidebar-redesign/issues/04-left-sidebar-resize.md), [티켓 05](.backlog/done/sidebar-redesign/issues/05-right-sidebar-collapse-and-resize.md))
- 단일 탭 내 좌측 Raw 편집기와 우측 실시간 Preview를 나란히 표시하는 `Split` 에디터 모드(`Ctrl+4`, `Ctrl+Shift+M` 순환, 탭별 폭 비율 리사이저) 및 원본 줄 번호(`data-source-line`) 기반 양방향 선형 보간 스크롤·목차 동기화 ([상세 스펙](.backlog/done/mermaid-split-view-preview/spec.md), [티켓 01](.backlog/done/mermaid-split-view-preview/issues/01-split-editor-mode-and-resizable-pane.md), [티켓 03](.backlog/done/mermaid-split-view-preview/issues/03-line-synced-bidirectional-split-scroll.md))
- Mermaid 다이어그램 실시간 편집 중 문법 오류 발생 시 직전 정상 렌더링 SVG를 유지하고 인라인 문법 오류 배너만 표시하여 깜빡임 및 레이아웃 높이 흔들림 방지 ([티켓 02](.backlog/done/mermaid-split-view-preview/issues/02-mermaid-live-edit-last-valid-svg.md))
- Raw, 위지윅(WYSIWYG), Preview, Split 모든 에디터 모드에서 스크롤 위치에 따라 우측 문서 목차의 현재 헤딩을 실시간 강조(`aria-current="location"`)하고 가시 영역 이탈 시 자동 스크롤하는 Scroll Spy 지원 ([상세 스펙](.backlog/done/sidebar-scroll-and-outline-spy/spec.md), [티켓 02](.backlog/done/sidebar-scroll-and-outline-spy/issues/02-outline-active-heading-and-preview-spy.md), [티켓 03](.backlog/done/sidebar-scroll-and-outline-spy/issues/03-outline-spy-wysiwyg-raw-and-split-panes.md))
- Git 패널 `Changes` / `Graph` 상하 분할 아코디언(섹션 높이 리사이저 포함), 컬러 SVG 레인 기반 시각적 커밋 그래프(`전체`/`현재 브랜치` 범위 필터, 브랜치·태그 배지, `더 보기` 페이지네이션), 인라인 커밋 상세·변경 파일 목록 및 해시 복사 기능 ([상세 스펙](.backlog/done/git-graph-panel/spec.md), [티켓 01](.backlog/done/git-graph-panel/issues/01-git-panel-changes-graph-split.md), [티켓 02](.backlog/done/git-graph-panel/issues/02-commit-graph-and-branch-filter.md), [티켓 03](.backlog/done/git-graph-panel/issues/03-commit-inline-detail-and-files.md))
- Git `Changes`(Staged/Unstaged/Untracked) 및 `Graph` 커밋 변경 파일 클릭 시 열리는 읽기 전용 Diff 탭 뷰어(좌우 Side-by-Side / 인라인 Unified 비교 전환, `파일 열기` 연동, 활성 편집기 영역 탭 교체 재사용 및 Git 상태 변경 시 자동 동기화) ([티켓 04](.backlog/done/git-graph-panel/issues/04-read-only-diff-viewer-and-changes-integration.md), [티켓 05](.backlog/done/git-graph-panel/issues/05-graph-commit-file-diff-integration.md))
- Raw·위지윅 모드(본문 및 표 셀)에서 `[텍스트](`·`[](` 입력 및 `Ctrl+K` 단축키로 동작하는 링크 자동완성 메뉴(현재 문서 `#섹션` 및 워크스페이스 내 전체 마크다운 파일 상대 경로 검색·추천 정렬)와 Preview 일반 클릭 / Raw·위지윅 `Ctrl+클릭` 문서·섹션 이동 및 깨진 링크 오류 배너 안내 ([상세 스펙](.backlog/done/markdown-link-insertion/spec.md), [티켓 01](.backlog/done/markdown-link-insertion/issues/01-section-link-autocomplete-and-ctrl-k.md), [티켓 02](.backlog/done/markdown-link-insertion/issues/02-workspace-file-link-autocomplete.md), [티켓 03](.backlog/done/markdown-link-insertion/issues/03-markdown-link-navigation-and-missing-target-banner.md))
- 탐색기 폴더 트리 우클릭 컨텍스트 메뉴에 `상대 경로 복사` 및 `절대 경로 복사` 항목 추가

### Changed
- 문서 목차(Outline)를 독립된 우측 사이드바(접기/펼치기 및 너비 조절 지원)로 분리하고, 전역 설정 패널을 화면 중앙 모달 대화상자로 전환 ([티켓 01](.backlog/done/sidebar-redesign/issues/01-outline-to-right-sidebar.md), [티켓 06](.backlog/done/sidebar-redesign/issues/06-settings-modal.md))
- 탐색기 헤더에서 워크스페이스 전환기 팝오버를 제거해 간결화하고, Git 패널의 레거시 내부 접기 토글을 제거하여 상단 고정 공통 제어(브랜치 전환·`Pull`/`Push`/`Sync`) + 하단 분할 섹션 구조로 개편 ([티켓 03](.backlog/done/sidebar-redesign/issues/03-workspace-view.md), [티켓 01](.backlog/done/sidebar-scroll-and-outline-spy/issues/01-viewport-scroll-and-git-header.md), [티켓 01](.backlog/done/git-graph-panel/issues/01-git-panel-changes-graph-split.md))
- 애플리케이션 메뉴 바를 `File`, `Settings`(`설정 패널`, `테마 전환`), `Help` 3개 메뉴 구성으로 단순화
- 번들링 대상 패키지를 `devDependencies`로 이동하고 `electron-builder`의 `npmRebuild`를 비활성화하여 패키징 빌드 속도 및 결과물 구성 최적화

### Removed
- 사용자 정의 커스텀 슬래시 명령어(`/` 자동완성 팝업, 템플릿 엔진, 전역 설정 패널 관리 섹션 및 `config.json`의 `customCommands` 스키마 필드) 제거
- 본문 내 인라인 목차(`<!-- toc -->` / `/toc`) 자동 렌더링·삽입 및 본문 헤딩 번호 쓰기·제거·본문 내 자동 넘버링 표시 기능을 제거하고 우측 문서 목차 사이드바 전용(`목차 번호 표시` 토글 유지)으로 일원화

### Fixed
- 긴 마크다운 문서 스크롤 시 앱 전체 뷰포트가 함께 밀려 올라가 사이드바·탭 바·에디터 헤더·서식 툴바가 화면 밖으로 이탈하던 레이아웃 오버플로우 버그 수정 및 영역별 독립 스크롤 격리 ([티켓 01](.backlog/done/sidebar-scroll-and-outline-spy/issues/01-viewport-scroll-and-git-header.md))
- 이미지(`![alt](...)`)가 포함된 마크다운 헤딩 파싱 시 대체 텍스트(alt)가 문서 목차 제목에서 누락되던 문제 수정
- 워크스페이스 전환 중 백그라운드 마크다운 파일 목록 갱신이 겹칠 때 워크스페이스 전환이 중단되던 문제 수정

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

