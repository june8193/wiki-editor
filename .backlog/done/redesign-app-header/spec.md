# Spec: 앱 헤더 제거 및 UI 간결화 (메뉴 바 · 사이드바 워크스페이스 전환기 · 드래그 분할)

## Problem Statement (문제 정의)

현재 창 상단에는 OS 기본 타이틀 바와 **애플리케이션 메뉴 바** 아래에 별도의 **앱 헤더**가 중복 배치되어 세로 작업 공간을 차지하고 있습니다. 또한 앱 헤더 내부에 성격이 다른 컨트롤들이 혼재되어 있습니다.

- `폴더 열기`, `테마 전환`, `설정`과 같은 앱 전역 명령은 데스크톱 표준인 **애플리케이션 메뉴 바**에 위치하는 편이 직관적입니다.
- **워크스페이스 전환기**(즐겨찾기·최근 워크스페이스 선택)는 앱 헤더에 있는 반면, 현재 워크스페이스 이름과 즐겨찾기 추가/해제(`★`/`☆`) 버튼은 **왼쪽 사이드바**의 **폴더 트리** 상단 헤더에 분리되어 있어 워크스페이스 관련 UI가 두 곳에 파편화되어 있습니다.
- **화면 분할 모드**(`단일` / `좌우 분할` / `상하 분할`) 버튼 그룹이 앱 헤더에 고정되어 있으나, 문서 탭을 **편집 공간**으로 드래그해 분할하는 상호작용만으로 좌우·상하 분할과 방향 전환을 모두 처리할 수 있다면 상단 버튼을 제거해 UI를 한층 간결하게 만들 수 있습니다. (단, 현재 드래그 분할은 우측 드롭 영역을 통한 `좌우 분할`만 지원하고 `상하 분할` 및 분할 방향 전환 드롭 영역이 없습니다.)

## Solution (해결 방안)

앱 내부의 **앱 헤더**를 완전히 제거하고, 기존 컨트롤들을 역할에 맞게 재배치·단순화하여 편집 공간과 사이드바 중심의 간결한 데스크톱 UI를 구성합니다.

1. **드래그 기반 좌우·상하 화면 분할 및 앱 헤더 분할 버튼 제거**:
   - 앱 헤더의 `단일` / `좌우 분할` / `상하 분할` 버튼 그룹을 제거합니다.
   - 탭 드래그 시 **편집 공간**에 우측 드롭 영역(**좌우 분할**)과 하단 드롭 영역(**상하 분할**)을 제공하여 두 분할 방식을 모두 드래그로 시작할 수 있게 합니다.
   - 이미 분할된 상태에서도 탭 드래그 시 현재 분할의 반대 방향 드롭 영역(좌우 분할 중이면 하단, 상하 분할 중이면 우측)을 표시해 분할 방향 전환을 지원합니다.
   - 보조 편집기 영역(또는 주 편집기 영역)의 탭이 모두 닫히거나 한쪽으로 합쳐지면 기존처럼 자동으로 `단일` 화면으로 복귀합니다.
2. **왼쪽 사이드바 상단에 워크스페이스 전환기 통합**:
   - **폴더 트리** 상단 헤더의 워크스페이스 이름 버튼을 **워크스페이스 전환기** 드롭다운(`{워크스페이스 이름 | 워크스페이스 선택} ▾`)으로 통합하고, 우측에 즐겨찾기 토글(`★`/`☆`) 버튼을 유지합니다.
   - 열린 워크스페이스가 없는 초기 상태에서도 폴더 트리 상단 헤더의 워크스페이스 전환기 드롭다운을 항상 표시하여, 앱 실행 직후 바로 즐겨찾기·최근 워크스페이스를 선택할 수 있게 합니다.
3. **애플리케이션 메뉴 바 구성 및 앱 헤더 완전 제거**:
   - Electron **애플리케이션 메뉴 바**를 `File`(`폴더 열기...`, 종료), `Edit`(기본 편집 동작), `View`(`테마 전환`, 기본 보기/개발자 도구 동작), `Settings`(`설정 패널` 토글), `Window`(기본 창 제어)로 구성합니다.
   - 메뉴 바에서 실행한 명령이 렌더러와 연동되어, 미저장 변경 사항이 있을 때 `File > 폴더 열기`를 실행하면 기존 **확인 다이얼로그**(`저장 후 이동` / `버리고 이동`)가 동일하게 동작하도록 보장합니다.
   - 모든 버튼이 이전된 후 **앱 헤더** 영역 자체를 제거하고 도메인 용어집을 최신 상태에 맞게 갱신합니다.

## User Stories (사용자 스토리)

1. **드래그를 통한 좌우·상하 화면 분할**: As a user, I want to drag a document tab to the right or bottom drop zone of the Pane Workspace in single mode, so that I can split the workspace horizontally (left/right) or vertically (top/bottom) without header split buttons.
2. **분할 방향 드래그 전환**: As a user, I want to drag a tab to the opposite-orientation drop zone while already in Split Mode (bottom zone during horizontal split, right zone during vertical split), so that I can switch between horizontal and vertical split layouts by dragging.
3. **단일 화면 자동 복귀**: As a user, I want the Pane Workspace to automatically collapse back to single mode when all tabs in one pane are closed or merged into the other pane, so that I never need a manual "single mode" button.
4. **왼쪽 사이드바 통합 워크스페이스 전환기**: As a user, I want the workspace name header at the top of the Folder Tree in the Left Sidebar to act as the Workspace Switcher dropdown alongside the favorite star toggle (`★`/`☆`), so that workspace identification, favorite toggling, and switching between favorite/recent workspaces happen in one unified place.
5. **미열림 상태에서의 워크스페이스 즉시 전환**: As a user, I want the Workspace Switcher dropdown at the top of the Left Sidebar to remain visible even when no workspace is currently open, so that I can open a favorite or recent workspace immediately after launching the app.
6. **File 메뉴 폴더 열기 및 미저장 보호**: As a user, I want to trigger "Open Folder" (`폴더 열기...`, `CmdOrCtrl+O`) from the `File` menu in the Application Menu Bar with the same unsaved-changes Confirm Dialog protection, so that opening a new folder follows standard desktop conventions safely.
7. **View 메뉴 테마 전환 및 Settings 메뉴 설정 패널 토글**: As a user, I want to toggle Light/Dark theme from the `View` menu and open/close the Settings Panel from the `Settings` menu in the Application Menu Bar, so that global appearance and preferences are accessible without cluttering the workspace with an App Header.
8. **앱 헤더 없는 간결한 앱 셸**: As a user, I want the internal App Header bar removed so that the main sidebar and Pane Workspace start immediately below the native Application Menu Bar, maximizing vertical screen space for reading and editing documents.

## Implementation Decisions (구현 결정사항)

### 1. 편집 공간 드래그 분할 및 상태 전이 계약
- **탭 이동 시 목표 분할 모드 지정**:
  - `PaneTabStore`의 탭 이동(`moveTab`) 인터페이스가 선택적인 목표 분할 모드(`targetSplitMode?: 'horizontal' | 'vertical'`)를 수용하도록 확장하거나, 드롭 액션에서 분할 방향 전환과 탭 이동을 원자적으로 수행합니다.
  - `단일(single)` 화면에서 주 편집기 영역에 탭이 2개 이상일 때 탭을 드래그하면 **편집 공간** 우측(`좌우 분할`)과 하단(`상하 분할`) 두 개의 드롭 영역을 렌더링합니다.
  - 이미 `좌우 분할(horizontal)` 중일 때 탭을 드래그하면 하단(`상하 분할`) 드롭 영역을, `상하 분할(vertical)` 중일 때 탭을 드래그하면 우측(`좌우 분할`) 드롭 영역을 표시합니다.
  - 이미 분할된 상태에서 반대 방향 드롭 영역에 탭을 드롭하면:
    - 주 편집기 영역의 탭이 2개 이상인 경우 해당 탭을 보조 편집기 영역으로 이동시키면서 분할 방향을 전환합니다.
    - 이미 보조 편집기 영역에 있는 탭을 드래그해 드롭하거나 주 편집기 영역에 탭이 1개뿐인 상태에서 방향 전환 드롭 영역에 드롭한 경우에도, 양쪽 편집기 영역이 비지 않는 한 해당 분할 방향(`horizontal` ↔ `vertical`)으로 즉시 전환합니다.
  - 탭 우클릭 컨텍스트 메뉴(`분할 영역으로 이동`, `분할 영역에 복제 열기`, `닫기`)와 분할 구분선 리사이즈, 한쪽 영역 탭이 모두 비었을 때 `single`로 자동 축소되는 불변식은 그대로 유지합니다.

### 2. 왼쪽 사이드바 워크스페이스 전환기 통합 계약
- **폴더 트리 상단 헤더 통합**:
  - **폴더 트리** 패널 상단에 항상 `.sidebar-header`의 타이틀 행을 렌더링합니다.
  - 타이틀 행 좌측에는 **워크스페이스 전환기** 드롭다운 트리거 버튼(`aria-label="워크스페이스 전환"`, 표시 텍스트 `{workspace?.name ?? '워크스페이스 선택'} ▾`)을 배치합니다.
  - 타이틀 행 우측에는 워크스페이스가 열려 있을 때(`workspace !== null`)만 즐겨찾기 토글 버튼(`★`/`☆`, `즐겨찾기 추가` / `즐겨찾기 해제`)을 표시합니다.
  - 드롭다운을 열면 기존과 동일하게 `즐겨찾기 워크스페이스` 섹션(항목 선택 및 개별 `즐겨찾기 해제` 버튼 포함)과 `최근 워크스페이스` 섹션을 가진 팝오버(`role="region"`, `aria-label="워크스페이스 목록"`)가 왼쪽 사이드바 안에서 잘리지 않고 표시됩니다.
  - 워크스페이스가 열려 있을 때만 타이틀 행 아래에 `+ 파일`, `+ 폴더`, `새로고침` 액션 버튼과 파일 트리를 렌더링하며, 열려 있지 않을 때는 빈 상태 안내(`열린 워크스페이스 없음`, `File 메뉴의 '폴더 열기' 또는 상단 워크스페이스 선택으로 시작하세요.`)를 표시합니다.

### 3. 애플리케이션 메뉴 바 및 IPC 브릿지 계약
- **네이티브 메뉴 구성**:
  - Main 프로세스에서 애플리케이션 메뉴 템플릿을 생성·적용합니다:
    - `File`: `폴더 열기...` (`accelerator: 'CmdOrCtrl+O'`), 구분선, 창 닫기/종료(`role: 'quit'` / `'close'`)
    - `Edit`: 기본 편집 role (`undo`, `redo`, 구분선, `cut`, `copy`, `paste`, `selectAll`)
    - `View`: `테마 전환`, 구분선, 기본 보기 role (`reload`, `forceReload`, `toggleDevTools`, 구분선, `resetZoom`, `zoomIn`, `zoomOut`, 구분선, `togglefullscreen`)
    - `Settings`: `설정 패널` (우측 전역 설정 패널 열기/닫기 토글)
    - `Window`: 기본 창 제어 role (`minimize`, `zoom`, `close`)
- **Main → Preload → Renderer 메뉴 명령 전달**:
  - 메뉴 항목(`폴더 열기...`, `테마 전환`, `설정 패널`) 클릭 시 Main 프로세스는 포커스된(또는 활성) 창의 `webContents`로 메뉴 명령 IPC 이벤트를 전송합니다.
  - `window.wikiApi` 브릿지를 통해 렌더러가 애플리케이션 메뉴 명령을 구독(및 언마운트 시 구독 해제)할 수 있는 타입 안전한 인터페이스를 제공합니다.
  - 렌더러는 각 명령 수신 시 기존 핸더(`handleSelectFolder` — 미저장 변경 사항 확인 다이얼로그 포함, `toggleTheme`, `setIsSettingsOpen((open) => !open)`)를 실행합니다.
- **앱 헤더 제거 및 도메인 문서 동기화**:
  - 렌더러 최상단의 `<header class="app-header">` 요소를 완전히 제거합니다.
  - 도메인 용어집에서 `앱 헤더` 제거 및 `애플리케이션 메뉴 바`, `워크스페이스 전환기`, `화면 분할 모드` 설명을 변경된 구조에 맞게 업데이트합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 구현 세부사항이 아닌 사용자 관점의 외부 관찰 가능 동작(드래그 앤 드롭 분할, 사이드바 워크스페이스 전환, 애플리케이션 메뉴 명령 수신 시 UI 반응)을 검증합니다.
- **사전 합의된 테스트 심 (Pre-agreed Seams)**:
  1. **`<App />` + 인메모리 `window.wikiApi` 통합 심 (React Testing Library)**:
     - **Catches**: 앱 헤더 제거 여부, 메뉴 명령 이벤트(`폴더 열기`, `테마 전환`, `설정 패널`)에 따른 미저장 확인 다이얼로그·테마 전환·설정 패널 토글, 왼쪽 사이드바 폴더 트리 상단의 통합 워크스페이스 전환기 동작(미열림/열림 상태), 편집 공간 우측·하단 드롭 영역을 통한 좌우/상하 분할 및 방향 전환 등 E2E UI 회귀.
     - **Misses**: Electron Main 프로세스의 실제 네이티브 메뉴 템플릿 생성 및 `ipcRenderer` 채널 이름 매핑 오류.
  2. **`createWikiApi(ipcRenderer)` 및 애플리케이션 메뉴 템플릿 빌더 경계 심 (Vitest)**:
     - **Catches**: `File` / `Edit` / `View` / `Settings` / `Window` 메뉴 항목 구조·단축키·클릭 시 IPC 브로드캐스트 누락 및 Preload 브릿지의 메뉴 이벤트 구독/해제 불일치.
     - **Misses**: 실제 OS 창 프레임에서의 네이티브 메뉴 시각적 렌더링.
  3. **`PaneTabStore` 공개 인터페이스 심 (Vitest)**:
     - **Catches**: 탭 이동/분할 시 목표 분할 방향(`horizontal` | `vertical`) 전이 오류, 이미 분할된 상태에서의 방향 전환 불변식 위반, 보조 영역 탭 종료 시 단일 화면(`single`) 자동 복귀 실패.
     - **Misses**: DOM `dragStart`/`drop` 이벤트 바인딩 및 드롭 영역 조건부 표시.
- **참고할 기존 테스트 패턴 (Prior Art)**:
  - `<App />` 통합 테스트의 인메모리 `createInMemoryWikiApi` 하네스 패턴
  - `PaneTabStore` 단위 테스트의 분할 모드 전이 및 탭 이동 검증 패턴
  - `createWikiApi` 단위 테스트의 가짜 `IpcRendererLike` 이벤트 발행 및 구독 해제 검증 패턴

## Out of Scope (범위 제외 사항)

- 커스텀 프레임리스(Frameless) 타이틀 바 제작 (OS 기본 타이틀 바와 네이티브 애플리케이션 메뉴 바를 그대로 사용)
- 3개 이상의 편집기 영역(N-grid) 분할 지원
- 탭 우클릭 컨텍스트 메뉴에 좌우/상하 분할 하위 메뉴를 별도로 추가하는 작업 (컨텍스트 메뉴는 현행 유지)

## Further Notes (기타 참고사항)

- **레이아웃 및 팝오버 오버플로우 주의**: 워크스페이스 전환기 팝오버가 왼쪽 사이드바 내부로 이동할 때, 사이드바 컨테이너의 `overflow: hidden`에 의해 팝오버가 잘리지 않도록 스타일과 레이어(`z-index`) 및 너비를 왼쪽 사이드바에 맞게 조정해야 합니다.
