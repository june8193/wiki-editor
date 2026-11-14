# Spec: Wiki Editor v1 — 경량 고성능 마크다운 데스크톱 에디터

## Problem Statement (문제 정의)

VS Code 같은 범용 코드 IDE는 확장 프로그램 호스트, 언어 분석 서버(LSP), 전체 코드 인덱서 등이 상시 동작하여 단순 마크다운 문서 작성 및 위키 관리 용도로는 무겁게 느껴집니다. 반면 일반 텍스트 에디터나 단순 뷰어는 다음 요구사항을 한곳에서 가볍고 빠르게 충족하지 못합니다.

- 순수 마크다운(`Raw text`), 렌더링 뷰(`Preview`), 직관적 문서 편집(`위지윅`) 3가지 모드의 자유로운 전환
- Mermaid 다이어그램 인라인 렌더링, 목차(TOC) 자동 생성 및 헤딩 자동 넘버링
- 표 삽입 및 행/열의 직관적인 추가/삭제
- `/function`, `/struct` 등 사용자 정의 커스텀 슬래시 명령어 및 설정 파일 저장
- 웹 브라우저형 멀티 탭 + 화면 분할(Split View) + 라이트/다크 테마
- 폴더 트리 기반 워크스페이스 관리, 즐겨찾기 등록 및 Git(Pull/Push/Commit 등) 연동

---

## Solution (해결 방안)

Windows 전용 `Electron + React + TypeScript` (`electron-vite`) 기반의 **경량·고성능 마크다운 데스크톱 위키 에디터**를 구축합니다.

무거운 IDE 기능을 배제하고 문서 편집·탐색·Git 동기화에만 집중하며, 체감 성능과 메모리 효율을 확보하기 위해 다음 **4대 성능 보장 설계 원칙**을 적용합니다.

1. **UI 스레드 비차단(Non-blocking I/O)**: 파일 시스템 탐색/감시(`fs`, `chokidar`) 및 Git CLI 명령 실행은 모두 Electron Main 프로세스(또는 워커)에서 비동기로 처리하여 타이핑·스크롤 중 UI 멈춤(Freeze)을 원천 차단합니다.
2. **비활성 탭 경량화(DOM 언마운트 & 메모리 해제)**: 탭을 수십 개 열어도 화면에 실제로 표시되는 활성 탭(단일 뷰 1개 또는 Split 뷰 최대 2개)만 무거운 에디터(CodeMirror/위지윅)와 Mermaid SVG DOM을 마운트합니다. 비활성 탭은 문서 텍스트, 커서/선택 영역, 스크롤 오프셋 등 경량 상태만 메모리에 보관합니다.
3. **가상 스크롤 및 지연/캐시 렌더링**: Raw 모드는 CodeMirror 6의 가상 스크롤(Viewport 렌더링)을 사용해 대용량 마크다운 문서도 렉 없이 편집하며, Mermaid 다이어그램은 디바운싱(Debounce) + 코드 해시 기반 SVG 캐싱으로 변경된 다이어그램 블록만 다시 그립니다.
4. **폴더 트리 지연 로딩(Lazy Loading)**: 대규모 워크스페이스 폴더를 열 때 최상위 depth만 비동기로 읽고, 사용자가 확장(Expand)한 하위 폴더만 온디맨드로 읽어 초기 로딩 지연을 제거합니다.

---

## User Stories (사용자 스토리)

1. **3모드 마크다운 에디터/뷰어**: As a user, I want to switch seamlessly between Raw text, Preview, and WYSIWYG modes per tab (and view the same file in different modes side-by-side in Split view), so that I can edit and read Markdown documents in the most comfortable way without corrupting the underlying `.md` format.
2. **표 편집 편의성**: As a user, I want to insert Markdown tables and easily add or delete rows and columns in both WYSIWYG and Raw modes, so that tabular documentation is fast and error-free.
3. **Mermaid 다이어그램 렌더링**: As a user, I want `mermaid` fenced code blocks to render automatically as diagrams in Preview and WYSIWYG modes with Light/Dark theme sync and graceful syntax-error fallback, so that I can author visual docs inline.
4. **하이브리드 목차 및 자동 넘버링**: As a user, I want an automatic Table of Contents (Outline sidebar + optional `/toc` block insertion) and hierarchical heading auto-numbering (`1.`, `1.1.`, `1.1.1.`) shown in rendered views—plus an explicit action to write/sync heading numbers back to the `.md` text when desired—so that long wiki documents stay structured.
5. **나만의 커스텀 슬래시 명령어**: As a user, I want to define custom slash commands (e.g., `/function`, `/struct`) in a single global `config.json` (editable via both an in-app Settings UI and direct JSON editing) that insert standardized Markdown templates with `{{cursor}}` positioning, so that I can reuse my own doc structures anywhere.
6. **멀티 탭 · 2분할 Split View · 라이트/다크 모드**: As a user, I want browser-style multi-tabs, a 2-pane Split View (Left/Right or Top/Bottom, each pane having its own independent tab bar with drag/move/open-to-side support), and Light/Dark theme switching, so that I can compare and edit multiple files comfortably.
7. **워크스페이스 폴더 트리 · 파일 CRUD · 즐겨찾기**: As a user, I want to open a local folder as a workspace with a VS Code-style folder tree (creating, renaming, deleting files/folders, `Ctrl+S` manual save with dirty indicator `●`, and an Auto-save toggle) and bookmark favorite workspaces in `config.json`, so that I can switch projects instantly.
8. **Git 워크스페이스 연동**: As a user, I want an integrated Git panel showing modified files, Stage/Unstage controls, commit message input, Commit, Pull, Push, one-click Sync, and branch switching using my system Git credentials, so that I can version-control my wiki without leaving the app.

---

## Implementation Decisions (구현 결정사항)

### 1. 기술 스택 및 프로젝트 구조
- **대상 플랫폼**: Windows 데스크톱 전용
- **런타임 & UI**: Electron + React 19 + TypeScript + Vite (`electron-vite`)
- **스타일링 & 테마**: CSS Variables 기반 라이트/다크 테마 토큰 (앱 전체 UI + CodeMirror + Preview + Mermaid 테마 일괄 연동)
- **에디터 엔진**:
  - **Raw Mode**: CodeMirror 6 (`@codemirror/lang-markdown`, 가상 스크롤, 마크다운 구문 강조, `/` 자동완성 확장)
  - **Preview Mode**: `unified` / `remark-parse` / `remark-gfm` / `rehype` 파이프라인 + 커스텀 Mermaid/TOC/헤딩 넘버링 플러그인
  - **WYSIWYG Mode**: ProseMirror 기반 마크다운 WYSIWYG (Milkdown 또는 TipTap + `tiptap-markdown`, 표 행/열 조작, 슬래시 명령어 메뉴, Mermaid 블록 노드뷰)
  - **원본 단일 진실 공급원(Single Source of Truth)**: 모든 모드는 순수 마크다운(`.md`) 문자열을 입출력 기준으로 삼아 모드 전환 시 데이터 손실이나 불필요한 포맷 변형을 방지합니다.

### 2. 전역 설정 파일 (`config.json`) 단일화
- 별도의 워크스페이스별 설정 파일(`.wiki-editor/` 등) 없이 Electron `app.getPath('userData')/config.json` 단일 파일로 통합 관리합니다. (테스트 시에는 경로 주입으로 임시 디렉토리 사용)
- 앱 내 설정 모달/탭 UI에서 편집할 수 있으며, "설정 파일 직접 열기" 액션을 통해 `config.json`을 에디터 탭으로 열어 직접 수정할 수도 있습니다(파일 감시/저장 시 스키마 검증 후 즉시 반영).

```ts
export interface CustomCommandConfig {
  /** 슬래시 명령어 트리거 (예: "function", "struct" -> /function, /struct) */
  trigger: string;
  /** 자동완성 목록 표시 이름 */
  label: string;
  /** 선택적 설명 */
  description?: string;
  /** 삽입될 표준 마크다운 템플릿 ({{cursor}}, {{date}}, {{title}} 치환 지원) */
  template: string;
}

export interface FavoriteWorkspace {
  path: string;
  name: string;
  pinnedAt: string; // ISO-8601
}

export interface AppConfig {
  version: 1;
  theme: 'light' | 'dark';
  autoSave: boolean;
  autoSaveDelayMs: number;
  showHeadingNumbers: boolean;
  favoriteWorkspaces: FavoriteWorkspace[];
  recentWorkspaces: string[];
  customCommands: CustomCommandConfig[];
}
```

### 3. IPC 아키텍처 (Main ↔ Preload ↔ Renderer)
- `contextIsolation: true`, `nodeIntegration: false` 보안 원칙을 유지하고 `preload`의 `contextBridge`를 통해 타입 안전한 IPC 브릿지(`window.wikiApi`)를 노출합니다.
- 네임스페이스:
  - `config:*` — 설정 읽기/쓰기, 스키마 검증, 설정 파일 경로 열기, 변경 이벤트 브로드캐스트
  - `workspace:*` — 폴더 선택 다이얼로그, 하위 엔트리 지연 읽기(`readDir`), 파일 읽기/쓰기(`readFile`/`writeFile`), 파일/폴더 생성·이름변경·삭제(`createEntry`, `renameEntry`, `deleteEntry`), 파일 감시(`watch`/`unwatch`)
  - `git:*` — 저장소 여부 확인, 상태 조회(`status`), Stage/Unstage(`add`/`reset`), `commit`, `pull`, `push`, `sync`, 브랜치 목록/체크아웃(`branches`/`checkout`)

### 4. 문서 버퍼(Document Buffer) 및 2분할 Split Pane 상태 모델
- **문서 버퍼 스토어**: 정규화된 파일 경로(`normalizedPath`)를 키로 `content`, `savedContent`, `isDirty`, `version`을 중앙 관리합니다.
  - 동일 문서를 좌측 Pane(Raw)과 우측 Pane(Preview)에 동시에 열어도 두 탭이 동일한 버퍼를 구독하므로 한쪽에서 수정 시 반대쪽이 실시간 동기화됩니다.
- **Pane & Tab 구조**:
  - 최대 2개 Pane(`primary`, `secondary`), 분할 방향(`horizontal` | `vertical`).
  - 각 Pane은 독립된 `tabs: TabItem[]`과 `activeTabId`를 가집니다.
  - 각 `TabItem`은 독립된 `mode: 'raw' | 'preview' | 'wysiwyg'`, `cursor`, `scrollTop` 상태를 보관합니다.
  - 비활성 탭은 React 트리에서 에디터 DOM을 마운트하지 않으며, 활성 Pane의 `activeTabId`만 마운트합니다.

### 5. 하이브리드 목차(TOC) & 자동 넘버링 규칙
- **렌더링 계층**: 사이드바 Outline 패널과 Preview/위지윅 화면에서는 설정(`showHeadingNumbers`)에 따라 코드 블록 밖의 헤딩(`#` ~ `######`)을 파싱하여 계층 번호(`1.`, `1.1.`, ...)를 동적으로 계산해 표시합니다. (원본 `.md` 텍스트는 오염시키지 않음)
- **명시적 텍스트 반영 액션**: 사용자가 "본문에 목차 삽입(`/toc`)" 또는 "본문 헤딩 번호 동기화/제거" 커맨드를 실행하면, AST/라인 파서(코드 펜스 내부 `#` 무시)가 실제 마크다운 텍스트에 목차 블록 또는 번호를 안전하게 삽입·갱신합니다.

### 6. Git 연동 계약
- 시스템에 설치된 `git` 바이너리(Windows 자격 증명 관리자/SSH 포함)를 `Main` 프로세스에서 비동기 호출합니다 (`simple-git` 또는 `execFile('git', ...)`).
- 인증 실패, 충돌(Conflict), 네트워크 오류 발생 시 앱이 멈추거나 크래시하지 않고 구조화된 오류 메시지를 Git 패널에 표시합니다.

---

## Testing Decisions (테스트 결정사항)

- **TDD 원칙 (`GEMINI.md`)**: 모든 티켓은 **Red(실패 테스트 선작성) → Green(최소 구현) → Refactor(리팩토링)** 순서로 개발합니다.
- **철저한 테스트 격리**:
  - 파일 시스템(`WorkspaceFsService`), 설정 파일(`ConfigService`), Git(`GitService`) 테스트는 반드시 임시 디렉토리(`fs.mkdtemp`) 또는 인메모리 어댑터를 사용하며, 실제 사용자 데이터나 본 리포지토리의 `.git`/작업 파일에 절대 영향을 주지 않습니다.
  - Git 테스트는 임시 디렉토리에 `git init`으로 로컬 테스트 저장소(필요 시 로컬 bare remote 포함)를 생성해 commit, branch, pull, push, conflict 에러 핸들링을 실제 Git 바이너리로 통합 검증합니다.
- **핵심 테스트 심(Test Seams)**:
  - Pure Domain / Core Services (Vitest):
    - `ConfigService`: 기본값 초기화, JSON 파싱 실패 복구, 커스텀 명령어 CRUD, 즐겨찾기 추가/중복 방지/제거
    - `WorkspaceFsService`: 지연 폴더 트리 조회, 경로 탈출(Path Traversal) 방지, 생성/이름변경/삭제
    - `GitService`: 상태 파싱, Stage/Unstage, Commit, Branch 전환, Local bare remote 대상 Pull/Push, 비-Git 폴더 예외 처리
    - `MarkdownTocEngine`: 코드 펜스 내부 `#` 무시, 헤딩 트리 추출, 계층 넘버링 생성/제거, `/toc` 블록 생성
    - `SlashCommandEngine`: `/` 트리거 매칭, 템플릿 변수(`{{cursor}}`, `{{date}}`, `{{title}}`) 치환 및 커서 오프셋 계산
    - `TableMarkdownManipulator`: 마크다운 표 파싱, 행/열 추가·삭제 시 정렬 및 구분선(`| --- |`) 정합성 유지
  - UI & Store (Vitest + React Testing Library):
    - 멀티 탭 열기/닫기/전환, 미저장 `●` 표시, Split View 분할/방향전환/탭 이동, 비활성 탭 DOM 미마운트 확인
    - 동일 파일 다중 Pane 실시간 버퍼 동기화 및 Raw/Preview/위지윅 전환 시 데이터 보존
    - 라이트/다크 테마 전환, 슬래시 명령어 팝업 선택 삽입, Git 패널 액션

---

## Out of Scope (범위 제외 사항)

- macOS / Linux 크로스플랫폼 빌드 및 패키징 (Windows 전용)
- 3분할 이상의 자유로운 바둑판(N-grid) 중첩 레이아웃
- 워크스페이스별 개별 설정 파일(`.wiki-editor/`) 오버라이드
- Git 3-way 인라인 머지 충돌 해결 에디터, 인터랙티브 리베이스, 커밋 그래프 시각화
- 실시간 다중 사용자 동시 편집(Multiplayer/CRDT) 및 클라우드 동기화 서버
- 플러그인/마켓플레이스 동적 로딩 시스템

---

## Further Notes (기타 참고사항)

- **보안 고려사항**:
  - Preview/위지윅 렌더링 시 XSS 방지를 위해 `rehype-sanitize` 적용 (허용된 Mermaid SVG 및 안전한 마크다운 HTML 요소만 렌더링).
  - IPC 파일 접근 시 워크스페이스 루트 경로 검증 및 `shell` 실행 시 셸 인젝션 방지를 위해 문자열 결합(`exec`) 대신 인자 배열(`execFile`)을 사용합니다.
- **성능 측정 기준**:
  - 10,000줄 이상 마크다운 문서 편집 시 Raw 모드 타이핑 지연 없음
  - 탭 20개 오픈 시 활성 Pane 외 에디터 인스턴스 DOM 수 `<= 2` 유지
