# Changelog

모든 주요 변경사항은 이 파일에 기록됩니다.
이 프로젝트는 [Semantic Versioning](https://semver.org/lang/ko/) 및 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 표준을 준수합니다.

---

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

