# Spec: 통합 터미널 (Integrated Terminal)

## Problem Statement (문제 정의)

현재 `wiki-editor`는 마크다운 문서 편집과 **Git 뷰**(Changes, Stashes, Graph, Compare)를 제공하지만, 내장 터미널이 없어 사용자가 앱 빌드·테스트 실행·개발 서버 구동을 위해 무거운 외부 IDE나 별도 터미널 창을 함께 띄워야 합니다.

- 사용자는 **메인 창**의 **Git 패널**에서 변경 사항과 Diff를 확인하는 흐름을 끊지 않고, 같은 화면 안에서 바로 빌드·테스트·CLI 작업을 수행하기를 원합니다.
- 단순 `child_process` 파이프 방식은 TTY가 아니어서 ANSI 컬러·진행률 바·`Tab` 자동완성·`↑/↓` 히스토리·인터랙티브 CLI(`y/n`, dev 서버, `Ctrl+C` 중단)가 깨져 실제 개발용으로 쓰기 어렵습니다.

## Solution (해결 방안)

VS Code와 동일한 `node-pty` (Main 프로세스 ConPTY) + `@xterm/xterm` (Renderer) 엔진을 기반으로, **메인 창**의 **편집 공간** 하단에 가볍고 반응성 높은 **터미널 패널**을 통합합니다.

1. **중앙 편집 공간 하단 배치 (메인 창 전용)**:
   - **왼쪽 사이드바**(Git 패널 포함)와 **우측 사이드바** 사이의 중앙 **편집 공간** 하단에 **터미널 패널**을 배치하여, Git 패널의 세로 공간을 온전히 유지한 채 **Diff 뷰어**와 터미널을 동시에 볼 수 있습니다.
   - **보조 창**에는 터미널을 제공하지 않으며, 상단 수평 **터미널 리사이저**로 높이를 조절하고 접힘 상태에서도 실행 중인 백그라운드 프로세스를 유지합니다.
2. **다중 터미널 탭 및 셸 프로필 선택**:
   - 여러 개의 **터미널 탭**을 동시에 열어 dev 서버와 빌드·테스트를 병행할 수 있으며, `+` 버튼(기본 셸)과 `+ ▾` 드롭다운(감지된 Windows 셸 프로필: `pwsh.exe`, `powershell.exe`, `cmd.exe`, Git Bash 등)을 지원합니다.
   - `config.json`의 `defaultTerminalProfile` 설정과 **전역 설정 패널** UI로 기본 셸 프로필을 지정할 수 있습니다.
3. **VS Code 스타일 인터랙션 및 보안**:
   - **애플리케이션 메뉴 바**(`터미널 토글`, `새 터미널`) 및 단축키(`Ctrl+`` / `Ctrl+Shift+``)로 빠르게 열고 전환합니다.
   - **스마트 복사/붙여넣기**(선택 텍스트 있을 때 `Ctrl+C` 복사, 미선택 시 SIGINT; `Ctrl+V` 및 우클릭 붙여넣기)와 **`Ctrl+클릭` 링크 열기**(안전한 `http`/`https` URL은 기본 브라우저로, 활성 워크스페이스 내 로컬 파일 경로는 **편집기 영역** 탭으로 열기)를 제공합니다.
4. **깔끔한 프로세스 수명 관리**:
   - 터미널을 열기 전에는 PTY 프로세스를 생성하지 않으며(지연 생성), 워크스페이스 전환 및 **메인 창**·앱 종료 시 확인 다이얼로그 없이 소유한 PTY 프로세스를 자동 종료합니다.

## User Stories (사용자 스토리)

1. As a 개발자·위키 작성자, I want **메인 창**의 **애플리케이션 메뉴 바** 또는 `Ctrl+`` 단축키로 **편집 공간** 하단에 **터미널 패널**을 열고 닫기를 원하며, so that **Git 패널**의 세로 공간을 유지한 채 **Diff 뷰어** 아래에서 빌드와 테스트를 즉시 실행할 수 있습니다.
2. As a 개발자, I want 터미널에서 `Tab` 자동완성, `↑/↓` 명령 히스토리, ANSI 컬러·진행률 바, `Ctrl+C` 중단 및 인터랙티브 CLI가 네이티브 터미널처럼 동작하기를 원하며, so that 별도 IDE를 띄우지 않고도 쾌적하게 개발 작업을 수행할 수 있습니다.
3. As a 개발자, I want **터미널 패널** 상단의 `+` 버튼과 `+ ▾` 프로필 드롭다운으로 여러 **터미널 탭**을 열고 전환·닫기를 원하며, so that dev 서버를 실행한 채 다른 탭에서 빌드나 Git CLI 명령을 병행할 수 있습니다.
4. As a Windows 사용자, I want 설치된 셸(`pwsh.exe` 우선 → `powershell.exe` 폴백, `cmd.exe`, Git Bash)이 자동 감지되고 **전역 설정 패널**(`config.json`)에서 기본 프로필을 선택할 수 있기를 원하며, so that 매번 셸을 바꿀 필요 없이 선호하는 환경으로 터미널을 시작할 수 있습니다.
5. As a 사용자, I want 상단 **터미널 리사이저**를 드래그하거나 키보드로 조절해 터미널 높이를 맞추고, 패널을 접었다가 다시 열어도 실행 중이던 프로세스와 출력이 유지되기를 원하며, so that 화면 공간을 유연하게 배분하면서도 백그라운드 작업이 끊기지 않습니다.
6. As a 사용자, I want 텍스트를 선택한 상태에서 `Ctrl+C`로 복사하고 선택이 없을 때는 `Ctrl+C`로 명령을 중단하며 `Ctrl+V`·우클릭으로 붙여넣기를 원하며, so that VS Code 터미널과 동일한 손에 익은 방식으로 조작할 수 있습니다.
7. As a 개발자, I want 터미널 출력의 `http`/`https` URL이나 워크스페이스 내 파일 경로(`path:line` 포함)를 `Ctrl+클릭`해 브라우저 또는 **편집기 영역** 탭으로 바로 열기를 원하며, so that 빌드 에러나 로컬 서버 주소로 즉시 이동할 수 있습니다.
8. As a 사용자, I want 워크스페이스를 전환하거나 **메인 창**·앱을 닫을 때 실행 중이던 터미널 프로세스가 확인 창 없이 자동으로 정리되기를 원하며, so that 좀비 프로세스나 불필요한 프롬프트 없이 깔끔하게 작업 환경을 전환·종료할 수 있습니다.

## Implementation Decisions (구현 결정사항)

### 1. 공유 데이터 모델 및 IPC 계약 (합의된 계약 인코딩)

```ts
export interface TerminalShellProfile {
  id: string
  label: string
  executable: string
  args: string[]
  isDefault: boolean
}

export interface TerminalCreateRequest {
  profileId?: string
  cols: number
  rows: number
}

export interface TerminalSessionInfo {
  id: string
  profileId: string
  title: string
  cwd: string
  pid: number
  isRunning: boolean
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number | null
  signal?: number
}

export interface WikiTerminalApi {
  listProfiles(): Promise<TerminalShellProfile[]>
  createSession(request: TerminalCreateRequest): Promise<TerminalSessionInfo>
  write(sessionId: string, data: string): Promise<void>
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  closeSession(sessionId: string): Promise<void>
  openExternalUrl(url: string): Promise<boolean>
  onData(listener: (event: TerminalDataEvent) => void): () => void
  onExit(listener: (event: TerminalExitEvent) => void): () => void
}
```

- `AppMenuCommand`에 `'toggle-terminal' | 'new-terminal'` 명령을 추가합니다.
- `AppConfig`에 `defaultTerminalProfile?: string | null` 필드를 추가하고 정규화·검증 규칙에 통합합니다(미지정 또는 미존재 프로필 ID일 때 자동 감지 기본 프로필로 폴백).

### 2. 아키텍처, 보안 및 수명 주기 불변식

- **네이티브 패키징 정책 갱신**: `node-pty`를 유일한 런타임 `dependencies`로 추가하고 `electron-builder` 설정에 `asarUnpack` 대상을 반영하며, 패키징 계약 테스트(`packaging.test.ts`)의 의도된 정책 검증을 함께 갱신합니다.
- **메인 창 세션 격리 및 보조 창 차단**:
  - **터미널 패널** UI는 **메인 창**에만 마운트되며 **보조 창**에는 노출하지 않습니다.
  - Main 프로세스의 터미널 IPC 핸들러는 호출 창이 **메인 창**인지 및 활성 워크스페이스가 열려 있는지 검증하여 **보조 창**이나 워크스페이스 미열림 상태의 요청을 거부합니다.
  - PTY 데이터·종료 이벤트(`onData`, `onExit`)는 세션을 소유한 **메인 창**의 `webContents`로만 전송합니다.
- **실행 경로(`cwd`) 및 셸 허용 목록 보안**:
  - PTY 생성 시 작업 디렉토리(`cwd`)는 렌더러 입력을 받지 않고 Main 프로세스가 소유한 현재 활성 워크스페이스 루트 경로로만 고정합니다.
  - 실행 셸은 임의 경로 실행을 금지하고 Main 프로세스가 사전 감지한 `TerminalShellProfile` 허용 목록의 `profileId`로만 해석합니다.
- **외부 URL 및 로컬 파일 링크 보안**:
  - `openExternalUrl`은 기존 URI 스킴 보안 검증을 재사용해 `http`/`https`만 허용하고 `file:`, `javascript:`, `cmd:` 등 비허용 스킴과 제어문자를 차단합니다.
  - 로컬 파일 경로 `Ctrl+클릭`은 기존 워크스페이스 경로 보안 검증을 거쳐 활성 워크스페이스 내부 파일일 때만 **편집기 영역** 탭으로 엽니다.
- **프로세스 수명 주기**:
  - 터미널 열기 전에는 PTY를 생성하지 않으며, 탭 닫기(`closeSession`), 워크스페이스 전환, **메인 창** 닫힘, 앱 종료 시 소유한 모든 PTY 프로세스를 즉시 종료하고 정리합니다.
  - **터미널 패널** 접힘(`display: none` 또는 숨김 유지) 시에는 DOM 인스턴스와 PTY 세션을 파괴하지 않고 유지하며, 다시 펼칠 때 `fit` 재계산 및 리사이즈 동기화를 수행합니다.

### 3. UI 및 테마 동기화 규칙

- **레이아웃**: **메인 창** 중앙 **편집 공간** 내부에서 **편집기 영역** 아래에 배치하고, 상단 **터미널 리사이저**로 높이(최소·최대 범위 가드, 키보드 `ArrowUp`/`ArrowDown`, 더블클릭 기본 높이 복원)를 조절합니다.
- **테마 동기화**: 라이트/다크 테마 전환 시 `xterm.js` 터미널 팔레트(배경·전경·커서·선택 영역·ANSI 색상)를 현재 테마 CSS 토큰과 동기화합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 PTY 버퍼링이나 xterm 내부 구현 세부사항이 아니라, 공개 IPC 계약·세션 격리/보안 경계·사용자 관점 UI 인터랙션을 기준으로 검증합니다.
- **사전 합의된 테스트 심(Pre-agreed Seams)**:
  1. **`TerminalService` + `registerTerminalIpc` 통합 테스트 심** (Fake/Mock PTY 팩토리 + 창/워크스페이스 세션 하네스):
     - *Catches*: 셸 프로필 감지 및 폴백, 지연 생성, 쓰기/리사이즈/종료 IPC 왕복, **보조 창** 차단, 워크스페이스 전환·창 닫기 시 PTY 일괄 종료, `http`/`https` 외 외부 URL 차단.
     - *Misses*: 실제 Windows ConPTY 바이너리 상호작용 및 렌더러 `xterm.js` DOM 렌더링.
  2. **`App` + 인메모리 `WikiApi` 하네스 통합 테스트 심**:
     - *Catches*: **메인 창** **편집 공간** 하단 **터미널 패널** 배치, **보조 창** 미노출, 메뉴/단축키(`Ctrl+`` / `Ctrl+Shift+``) 토글·생성, 다중 탭 전환·닫기, 접힘 중 상태 유지, 워크스페이스 전환 시 세션 초기화, **전역 설정 패널** 기본 프로필 저장, 로컬 파일 링크 클릭 시 **편집기 영역** 탭 열기.
     - *Misses*: 실제 PTY 프로세스 출력 스트리밍 및 `xterm.js` 캔버스/DOM 픽셀 렌더링.
  3. **`TerminalPanel` 컴포넌트 테스트 심** (경량 `xterm.js` 어댑터 모킹):
     - *Catches*: 스마트 복사/붙여넣기(`Ctrl+C` 선택 유무 분기, `Ctrl+V`/우클릭 붙여넣기), **터미널 리사이저** 드래그/키보드/더블클릭 높이 조절, 테마 변경 시 팔레트 동기화, `+ ▾` 프로필 드롭다운 선택.
     - *Misses*: 실제 `xterm.js` 터미널 버퍼 스크롤/리플로우 및 Main 프로세스 IPC.
  4. **`packaging.test.ts` 패키징 계약 테스트 심**:
     - *Catches*: `node-pty` 런타임 의존성 허용 목록 및 `electron-builder` `asarUnpack`/`files` 패키징 설정 누락 또는 의도치 않은 런타임 의존성 추가 회귀.
     - *Misses*: 실제 패키징된 `.exe` 실행 시 네이티브 바이너리 로드.
- **참고할 기존 테스트 패턴(Prior art)**:
  - 백엔드 서비스/IPC 통합 테스트: 워크스페이스·Git IPC 핸들러의 세션 격리 및 보안 검증 테스트 패턴.
  - 렌더러 통합 테스트: `App` + 인메모리 `WikiApi` 하네스 기반 앱 셸·다중 창 테스트 패턴.
  - 패키징 계약 테스트: `package.json` 기반 `packaging.test.ts` 패턴.

## Out of Scope (범위 제외 사항)

- 터미널 내부 좌우/상하 화면 분할 (Split Terminal)
- **보조 창**에서의 **터미널 패널** 지원
- 터미널 출력 내 찾기 (`Ctrl+F` 검색 바)
- 워크스페이스별 터미널 높이·열림 상태 영속화(`workspace-state.json`) 및 앱 재시작 시 셸 세션 복원
- 창 닫기·워크스페이스 전환 시 실행 중 프로세스 확인 다이얼로그 표시

## Further Notes (기타 참고사항)

- 확정된 레이아웃 레퍼런스: 대화 중 승인된 `terminal-layout-prototype.html` 프로토타입의 **A. 중앙 편집 공간 하단 배치** 구조.
- 구현 완료 시 `CONTEXT.md`에 공식 용어(**터미널 패널**, **터미널 탭**, **터미널 리사이저**)를 등재하고, 사용자 매뉴얼 규칙에 따라 `docs/manual.md`를 함께 갱신합니다.
