# Wayfinder Map: Wiki Editor v1

## Destination

Windows 전용 경량·고성능 마크다운 데스크톱 위키 에디터(`wiki-editor v1`)의 전체 요구사항(3모드 마크다운 에디터, Mermaid, 표 편집, 하이브리드 목차/자동 넘버링, 커스텀 슬래시 명령어, 멀티 탭/2분할 Split UI, 라이트/다크 모드, 폴더 트리/즐겨찾기, Git 연동)을 포괄하는 상세 스펙([spec.md](spec.md))과 순차 구현 가능한 수직 슬라이스 티켓 체계를 확정하고 v1 개발 착수 준비를 완료한다.

## Notes

- **타겟 환경**: Windows 전용 데스크톱 앱
- **스펙 문서**: [spec.md](spec.md)
- **개발 규칙**: 모든 구현 티켓은 [GEMINI.md](../../GEMINI.md)의 TDD(Red-Green-Refactor) 및 테스트 격리 원칙을 준수한다.
- **실행 파이프라인**: 선행 의존성이 없는 프론티어 티켓부터 `/ticket-runner` 또는 개별 세션으로 순차 구현한다.
- **제약 사항**: 도메인 문서(`CONTEXT.md`, `docs/adr/`)는 별도로 생성하지 않는다.

## Decisions so far

- [기술 스택 확정: Windows 전용 Electron + React + TypeScript](spec.md#1-기술-스택-및-프로젝트-구조) — 단일 TS 언어로 파일/Git/에디터를 제어하고 TDD를 구성하며, 4대 경량화 원칙(Main 프로세스 비동기 I/O, 비활성 탭 DOM 언마운트, 가상 스크롤+Mermaid 디바운스 캐싱, 폴더 트리 지연 로딩)으로 체감 성능 보장.
- [마크다운 3모드 전환 및 Split 연동 방식 확정](spec.md#4-문서-버퍼document-buffer-및-2분할-split-pane-상태-모델) — 탭마다 `Raw / Preview / 위지윅` 3모드를 자유롭게 전환하고, 동일 파일을 Split 뷰에서 서로 다른 모드(예: 좌측 Raw + 우측 Preview)로 열어 중앙 버퍼로 실시간 동기화.
- [하이브리드 목차(TOC) 및 자동 넘버링 확정](spec.md#5-하이브리드-목차toc--자동-넘버링-규칙) — 기본은 사이드바 Outline과 렌더링 화면에서만 번호/목차를 동적 표시해 원본 `.md`를 유지하고, 필요 시 `/toc` 삽입 및 본문 헤딩 번호 동기화 액션 제공.
- [커스텀 슬래시 명령어 및 단일 전역 config.json 확정](spec.md#2-전역-설정-파일-configjson-단일화) — `/function`, `/struct` 등 명령어는 표준 마크다운 템플릿 스니펫으로 삽입되며, 단일 `config.json`에 저장하고 앱 내 설정 UI와 JSON 직접 편집을 모두 지원.
- [멀티 탭 + 좌/우(상/하) 2분할 Split View 확정](spec.md#4-문서-버퍼document-buffer-및-2분할-split-pane-상태-모델) — 최대 2개 Pane 각각에 독립 탭 바를 두고 탭 이동/분할 열기 지원.
- [워크스페이스 폴더 트리 CRUD 및 저장 방식 확정](spec.md#user-stories-사용자-스토리) — 생성/이름변경/삭제 지원, `Ctrl+S` 수동 저장(미저장 `●` 배지) + 자동 저장(Auto-save) 설정 토글 모두 지원.
- [핵심 Git 패널 연동 수준 확정](spec.md#6-git-연동-계약) — 변경 파일 목록, 선택/전체 Stage, 커밋 메시지/Commit, Pull, Push, 원클릭 Sync, 브랜치 전환을 시스템 Git 연동으로 제공.
- [위지윅 에디터 엔진 확정: TipTap v3 (`@tiptap/react` + `@tiptap/markdown`)](issues/04-three-mode-markdown-editor-and-table.md#answer) — React 19 호환성, GFM 표 행/열 조작(단일 헤더 행 불변식 보존) 및 마크다운 라운드트립 정확도 검증 완료.

## Child Tickets (수직 슬라이스 구현 백로그)

- [x] [01 — Electron + React + TS 스캐폴딩, 전역 설정(config.json) 및 라이트/다크 테마](issues/01-electron-react-scaffold-and-config.md) (`26b8158`)
- [x] [02 — 워크스페이스 폴더 트리(지연 로딩·파일 CRUD·저장) 및 즐겨찾기 관리](issues/02-workspace-folder-tree-and-favorites.md) (`5a02e7b`)
- [x] [03 — 멀티 탭 및 좌/우(상/하) 2분할 Split View 레이아웃 (비활성 탭 경량화)](issues/03-multi-tab-and-split-pane-layout.md) (`6f0b8cc`)
- [x] [04 — 3모드 마크다운 에디터(Raw·Preview·위지윅) 및 표(행·열 추가/삭제) 편집](issues/04-three-mode-markdown-editor-and-table.md) (`20dd0f1`)
- [x] [05 — Mermaid 다이어그램 렌더링 및 하이브리드 목차(TOC)·헤딩 자동 넘버링](issues/05-mermaid-toc-and-auto-numbering.md) (`d76f41e`)
- [06 — 나만의 커스텀 슬래시 명령어(/function, /struct 등) 자동완성 및 설정 UI 연동](issues/06-custom-slash-commands.md)
- [07 — 워크스페이스 Git 연동 패널 (Status, Stage, Commit, Pull, Push, Branch)](issues/07-git-workspace-integration.md)

## Not yet specified

- Electron Windows 설치 패키징 방식(`electron-builder` NSIS vs Portable `.exe`) — v1 핵심 기능 구현 완료 후 결정.

## Out of scope

- macOS / Linux 빌드 지원 (Windows 전용 타겟)
- 3분할 이상의 N-grid 중첩 화면 분할
- 워크스페이스별 개별 설정 파일(`.wiki-editor/`) 오버라이드
- Git 3-way 인라인 충돌 병합 에디터 및 커밋 그래프 시각화
- 클라우드 동기화 및 실시간 다중 사용자 동시 편집
