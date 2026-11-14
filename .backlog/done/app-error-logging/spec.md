# Spec: App Error & Activity Logging (앱 동작 및 에러 로깅)

## Problem Statement (문제 정의)

현재 Wiki Editor에는 파일이나 메모리에 남는 로깅 기능이 전혀 존재하지 않습니다.
- Main 프로세스에서 발생한 오류는 IPC Promise rejection으로 Renderer에 전달될 뿐 디스크에 기록되지 않으며, `uncaughtException`·`unhandledRejection`·`render-process-gone` 등 크래시·비정상 종료 이벤트도 추적되지 않습니다.
- Renderer에서는 오류 발생 시 **오류 배너** 또는 **Git 패널**에 단발성 메시지 문자열만 표시한 뒤 사라지므로, 스택 트레이스·원본 Git CLI 출력(`stderr`/`stdout`/종료 코드)·직전 사용자 동작 흐름(Breadcrumb)이 유실됩니다.
- 그 결과 사용자가 버그나 에러를 겪었을 때 AI 에이전트에게 원인을 추적할 수 있는 맥락(환경 정보, 에러 스택, 직전 동작 이력, 전체 로그 파일)을 리포트하기 어렵습니다.

---

## Solution (해결 방안)

1. **구조화된 상시 JSONL 파일 로깅 (`LogService`)**:
   - Electron `app.getPath('userData')/logs/app.jsonl`(Windows 기준 `%APPDATA%\wiki-editor\logs\app.jsonl`)에 JSON Lines 포맷으로 에러·경고 및 주요 사용자 동작 흐름(Breadcrumb)을 상시 기록합니다.
   - `app.jsonl` 파일 크기가 `2MB`를 초과하면 `app.1.jsonl` → `app.2.jsonl` 순으로 자동 회전(최대 3개 파일 보관)하여 디스크 사용량을 제한합니다.
2. **프라이버시·안전 보장**:
   - 문서 본문(`content`, `initialContent`) 및 `config.json` 원문(`raw`)은 로그에 기록하지 않고 글자 수(`contentLength`)만 남깁니다.
   - 파일·워크스페이스 절대 경로와 Git CLI 오류 상세는 로컬 AI가 즉시 원인을 찾을 수 있도록 원문 그대로 보존합니다.
3. **애플리케이션 메뉴 바 `Help` 메뉴 기반 AI 버그 리포트 추출**:
   - **애플리케이션 메뉴 바**의 `Help` 메뉴에 **`Copy Bug Report`**(환경 정보 + `app.jsonl` 절대 경로 + 최근 에러/경고 최대 10건 + 최근 동작 Breadcrumb 최대 50건을 마크다운으로 포맷해 클립보드에 복사 후 네이티브 완료 메시지 박스 표시)와 **`Open Log Folder`**(로그 폴더 생성 보장 후 OS 탐색기 열기)를 제공합니다.

---

## User Stories (사용자 스토리)

1. **상시 구조화 로깅 및 용량 관리**: As a Wiki Editor user, I want errors, warnings, and major operational breadcrumbs to be continuously recorded to a size-rotated `app.jsonl` file in `userData/logs`, so that diagnostic context is preserved even after an unexpected failure or restart without unbounded disk growth.
2. **원클릭 AI 버그 리포트 복사**: As a Wiki Editor user encountering a bug, I want to click `Help > Copy Bug Report` in the **애플리케이션 메뉴 바** and receive a confirmation dialog, so that I can immediately paste a structured Markdown report (environment info, log file path, recent errors with stack traces, and recent UI/IPC breadcrumbs) to an AI assistant.
3. **로그 폴더 직접 열기**: As a Wiki Editor user or local AI agent, I want to open the logs directory via `Help > Open Log Folder` in the **애플리케이션 메뉴 바**, so that I can inspect or attach the full `app.jsonl` and rotated archive files when deeper investigation is needed.
4. **Main 프로세스 오류·원본 Git/설정 복구 추적**: As a maintainer diagnosing a bug report, I want IPC failures (with timing), uncaught exceptions, renderer crashes, raw Git CLI `stderr`/exit codes, and corrupted `config.json` recovery events to be logged automatically, so that root causes are visible rather than hidden behind simplified UI messages.
5. **문서 내용 제외 및 동작 흐름 재구성**: As a user writing private notes, I want document contents and raw config payloads to be excluded from logs while key UI actions (**탭 바** 전환, **에디터 모드** 전환, **화면 분할 모드** 변경, **Mermaid 다이어그램 블록** 오류, **오류 배너**/**Git 패널** 오류 표시) are captured as breadcrumbs, so that AI can reconstruct reproduction steps without leaking note contents.

---

## Implementation Decisions (구현 결정사항)

### 1. 핵심 로그 스키마 및 IPC 계약

대화 및 설계 검토를 통해 확정된 공유 타입 계약은 다음과 같습니다.

```ts
export type LogLevel = 'info' | 'warn' | 'error'
export type LogProcess = 'main' | 'renderer'
export type LogCategory = 'app' | 'ipc' | 'git' | 'workspace' | 'config' | 'ui' | 'error'

export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string | number
  stderr?: string
  stdout?: string
}

export interface LogEntry {
  timestamp: string // ISO-8601
  level: LogLevel
  process: LogProcess
  category: LogCategory
  message: string
  data?: Record<string, unknown>
  error?: SerializedError
}

export interface RendererLogPayload {
  level: LogLevel
  category: LogCategory
  message: string
  data?: Record<string, unknown>
  error?: SerializedError
}

export interface WikiLogApi {
  write(payload: RendererLogPayload): Promise<void>
}
```

### 2. 저장소, 동시성, 로테이션 및 장애 격리 불변식 (`LogService`)
- **주입 가능한 로그 디렉토리**: 실행 시 `join(app.getPath('userData'), 'logs')`를 사용하며, 테스트 시에는 임시 디렉토리 경로를 주입해 실제 사용자 데이터를 오염시키지 않습니다.
- **직렬 비동기 쓰기 큐(`enqueue`)**: 동시 다발적인 Main·IPC·Renderer 로그 기록 요청이 들어와도 단일 Promise 체인 큐로 직렬화하여 기록 순서를 보장합니다.
- **용량 기반 로테이션**: `app.jsonl` 크기가 `2MB`(`2 * 1024 * 1024` bytes)를 초과하면 기존 `app.1.jsonl`을 `app.2.jsonl`로, `app.jsonl`을 `app.1.jsonl`로 회전하고 최대 3개 파일(`app.jsonl`, `app.1.jsonl`, `app.2.jsonl`)만 유지합니다.
- **Fail-safe 원칙**: 로그 디렉토리 생성 실패나 디스크 쓰기 오류가 발생하더라도 예외를 호출자에게 전파하지 않아 파일 저장·Git 동기화·UI 조작 등 앱의 핵심 동작이 중단되지 않습니다.

### 3. 데이터 보호(Redaction) 및 기록 기준
- **본문 제외**: **문서 버퍼** 저장·생성(`writeFile`, `createEntry`)의 `content`/`initialContent`와 `config.json` 원문 저장(`saveRaw`)의 `raw` 문자열은 로그에 기록하지 않고 글자 수(`contentLength` 등 메타데이터)만 기록합니다.
- **경로 및 Git 오류 원문 유지**: 로컬 AI 에이전트가 경로 오류나 Git 충돌·인증 문제를 즉시 진단할 수 있도록 워크스페이스/파일 절대 경로와 Git CLI 오류 상세(`stderr`, `stdout`, `code`, `signal`)는 마스킹 없이 기록합니다.

### 4. Main 프로세스 자동 수집 범위
- **앱 생명주기 및 크래시**: 앱 시작(`ready`)·종료(`will-quit`), `process.on('uncaughtException')`, `process.on('unhandledRejection')`, `webContents.on('render-process-gone')` 이벤트를 기록합니다.
- **IPC 경계 자동 래퍼**: IPC 핸들러 등록 공통 유틸리티에서 `config:*`, `workspace:*`, `git:*` 모든 호출의 시작/완료 소요 시간(`durationMs`), 성공 여부, 정제된 메타데이터, 실패 시 직렬화된 에러(`SerializedError`)를 자동 기록합니다. (`log:write` 채널 자체는 무한 루프를 막기 위해 별도 IPC 감사 로그를 남기지 않습니다.)
- **서비스 내부 원본 맥락 보존**:
  - Git 서비스는 사용자 친화적 메시지(`GitFormattedError`)로 변환하기 전 원본 CLI 실패 정보(`stderr`, `stdout`, `code`, `signal`)를 `error` 레벨로 기록합니다.
  - 설정 서비스는 손상된 `config.json`을 `.corrupt.*.bak`으로 백업하고 기본값으로 복구할 때 `warn` 레벨로 기록합니다.

### 5. Preload 브리지 및 Renderer 프로세스 수집 범위
- **보안 유지 IPC 브리지**: `contextIsolation: true`, `nodeIntegration: false` 보안 원칙을 유지하며 `log:write` IPC 채널과 `window.wikiApi.log.write(payload)` 메서드를 노출합니다.
- **안전한 폴백**: Renderer 로깅 헬퍼는 `window.wikiApi?.log`가 존재하지 않는 기존 테스트 환경에서도 오류 없이 noop으로 동작합니다.
- **Renderer 오류 수집**: `window.addEventListener('error')`, `window.addEventListener('unhandledrejection')`, **오류 배너** 표시, **Git 패널** 오류 표시, **Mermaid 다이어그램 블록** 렌더링 실패 시 스택/메시지를 Main `LogService`로 전송합니다.
- **UI 동작 Breadcrumb**: **탭 바** 조작(열기/닫기/전환/이동/복제), **에디터 모드** 전환(`Raw`, `위지윅`, `Preview`), **화면 분할 모드**(`single`, `horizontal`, `vertical`) 변경, 워크스페이스 전환 등 주요 상태 전이를 `info` 레벨(`category: 'ui'`)로 기록합니다.

### 6. 애플리케이션 메뉴 바 (`Help`) 및 AI 마크다운 리포트 포맷
- **메뉴 구성**: **애플리케이션 메뉴 바** `Help` 하위 메뉴에 `Copy Bug Report`, `Open Log Folder`, `Version` 항목을 제공합니다.
- **리포트 포맷 (`formatBugReport`)**: 최근 로그 파일(`app.2.jsonl` → `app.1.jsonl` → `app.jsonl` 순으로 병합 파싱)에서 항목을 추출해 아래 섹션으로 구성된 마크다운 문자열을 생성합니다.
  1. `Environment`: Wiki Editor 버전, Electron / Chromium / Node.js 버전, OS 플랫폼·릴리즈·아키텍처, 리포트 생성 시각
  2. `Log File Path`: `app.jsonl` 절대 경로
  3. `Recent Errors & Warnings`: 최근 `error`/`warn` 항목 최대 10건 (시각, 프로세스, 카테고리, 메시지, 스택, 코드/stderr/stdout, 컨텍스트 데이터)
  4. `Recent Activity (Breadcrumbs)`: 최근 전체 로그 항목 최대 50건의 시간순 타임라인
- **사용자 피드백**: `Copy Bug Report` 클릭 시 클립보드에 리포트를 복사한 뒤 네이티브 확인 메시지 박스(`dialog.showMessageBox`)로 복사 완료 및 로그 파일 경로를 안내합니다. `Open Log Folder` 클릭 시 로그 디렉토리를 보장한 뒤 OS 탐색기로 엽니다.

---

## Testing Decisions (테스트 결정사항)

- **TDD 원칙 (`GEMINI.md`)**: 모든 티켓은 **Red(실패 테스트 선작성) → Green(최소 구현) → Refactor(리팩토링)** 순서로 진행합니다.
- **테스트 격리**: 모든 파일 기반 로그 테스트는 `fs.mkdtemp` 임시 디렉토리를 주입해 수행하며, 실제 OS `userData` 디렉토리(`%APPDATA%\wiki-editor`)에 절대 기록하지 않습니다.
- **사전 합의 테스트 심(Pre-agreed Seams)**:
  - **`LogService` & `formatBugReport` 공개 인터페이스 (임시 디렉토리 기반 단위/통합 심)**: Catches JSONL 직렬화·파싱 오류, 동시 로깅 시 순서 역전·유실, 2MB 초과 시 `app.jsonl` → `app.1.jsonl` → `app.2.jsonl` 회전 및 개수 제한 실패, 최근 에러(최대 10건)·최근 동작(최대 50건)·환경 정보·로그 파일 경로를 포함한 AI 마크다운 리포트 포맷 오류 / Misses 실제 Electron `ipcMain`·`clipboard`·`shell` 바인딩.
  - **IPC 핸들러 래퍼 및 Main 서비스 로깅 심 (`registerIpcHandlers`, `registerLogIpc`, `GitService`, `ConfigService`)**: Catches `config:*`·`workspace:*`·`git:*` IPC 호출의 성공·실패·소요 시간 자동 기록 누락, 파일 쓰기/설정 저장 시 문서 본문이 평문으로 로그에 노출되는 마스킹 버그, `GitService` 실패 시 원본 `stderr`/종료 코드 누락, `ConfigService` 손상 복구 시 `warn` 로그 누락, `log:write` IPC를 통한 렌더러 로그 적재 실패 / Misses 렌더러 DOM 이벤트 및 네이티브 메뉴 클릭.
  - **애플리케이션 메뉴 바 `Help` 메뉴 심 (`createApplicationMenuTemplate`, `createBugReportCopiedMessageBoxOptions`)**: Catches `Help` 하위 메뉴의 `Copy Bug Report`·`Open Log Folder`·`Version` 항목 구성 및 클릭 콜백 연결 누락, 복사 완료 네이티브 메시지 박스 옵션 불일치 / Misses OS 네이티브 메뉴 렌더링.
  - **Preload & `<App />` 통합 심 (`createWikiApi`, `<App />` + React Testing Library)**: Catches `window.wikiApi.log.write` IPC 라우팅 오류, 렌더러 미처리 예외(`error`, `unhandledrejection`) 및 주요 UI 동작(**탭 바** 전환, **에디터 모드** 전환, **화면 분할 모드** 변경, **Mermaid 다이어그램 블록** 오류, **오류 배너** 표시) 발생 시 로그 전송 누락 / Misses 실제 Chromium 렌더러 프로세스 강제 종료(`render-process-gone`).
- **참고할 기존 테스트 패턴(Prior Art)**:
  - Node 단위/통합 테스트: 임시 디렉토리(`fs.mkdtemp`)와 가짜 `IpcMainLike`/`IpcRendererLike`를 주입해 검증하는 기존 Main 서비스·IPC·Preload·메뉴 테스트 패턴
  - UI 통합 테스트: 가상 파일시스템 및 모의 `WikiApi`를 주입해 `<App />` 전체 상호작용을 검증하는 기존 React Testing Library 통합 테스트 패턴

---

## Out of Scope (범위 제외 사항)

- Sentry 등 외부 원격 서버로의 자동 크래시/텔레메트리 전송
- 앱 내부의 별도 로그 뷰어 패널/모달 UI 또는 **전역 설정 패널** 내 로깅 활성화/레벨 토글 UI
- 키보드 타이핑 단위(`input`/`keydown`) 고빈도 로깅 및 마크다운 문서 본문 텍스트 기록
- 사용자 홈 디렉터리 경로의 추가 익명화(`~`) 마스킹

---

## Further Notes (기타 참고사항)

- **성능 영향 최소화**: 파일 쓰기는 비동기 I/O 직렬 큐에서 처리되어 메인 이벤트 루프나 렌더러 타이핑 스레드를 블로킹하지 않습니다. 또한 빈번한 타이핑 중 문서 변경 이벤트 자체는 로깅 대상에서 제외하고 저장/모드 전환 등 이산적 이벤트만 기록합니다.
- **실행 시 Windows 저장 경로**:
  - 로그 폴더: `C:\Users\<username>\AppData\Roaming\wiki-editor\logs`
  - 활성 로그 파일: `C:\Users\<username>\AppData\Roaming\wiki-editor\logs\app.jsonl`
