# 01 — Main JSONL 로테이션 로거, IPC/서비스 자동 로깅 및 Help 메뉴 버그 리포트·로그 폴더 열기

Spec: [spec.md](../spec.md)
Type: task
Blocked by: None — can start immediately
Status: resolved

**What to build:**
Main 프로세스의 구조화된 JSON Lines 파일 로깅 인프라(`LogService` + 용량 기반 로테이션 + AI 마크다운 버그 리포트 포맷터), 앱 생명주기·미처리 예외·IPC 경계·서비스(`GitService`, `ConfigService`) 자동 로깅, 그리고 **애플리케이션 메뉴 바** `Help` 메뉴의 `Copy Bug Report` 및 `Open Log Folder` 액션을 구현하여 Main 계층의 로그 기록부터 AI 리포트 추출까지 E2E로 동작하게 합니다.

## Acceptance Criteria

- [x] `LogService`는 주입 가능한 로그 디렉토리(실행 시 `app.getPath('userData')/logs`, 테스트 시 `fs.mkdtemp` 임시 디렉토리)에 `app.jsonl` 파일로 JSON Lines 레코드를 직렬 비동기 큐(`enqueue`)로 기록하며, 동시 호출 시 순서가 보존되고 로깅 I/O 오류가 앱 실행을 중단시키지 않습니다(Fail-safe).
- [x] `app.jsonl` 파일 크기가 2MB를 초과하면 `app.1.jsonl` → `app.2.jsonl` 순으로 자동 회전하며 최대 3개 파일만 유지합니다.
- [x] IPC 핸들러 등록 래퍼가 모든 `config:*`, `workspace:*`, `git:*` 호출의 실행 소요 시간(`durationMs`), 성공 여부, 에러 스택/코드를 자동 기록하며, `writeFile`·`createEntry`·`saveRaw`의 문서 본문(`content`, `initialContent`) 및 `config.json` 원문(`raw`)은 기록하지 않고 `contentLength` 메타데이터만 남깁니다.
- [x] `GitService`는 CLI 실행 실패 시 사용자용 메시지로 변환하기 전 원본 `stderr`, `stdout`, 종료 코드/시그널을 `error` 레벨로 기록하고, `ConfigService`는 손상된 설정 백업(`.corrupt.*.bak`) 복구 시 `warn` 레벨 로그를 기록합니다.
- [x] 앱 시작(`ready`)·종료(`will-quit`), `process.on('uncaughtException')`, `process.on('unhandledRejection')`, `webContents.on('render-process-gone')` 이벤트가 누락 없이 로그에 기록됩니다.
- [x] `formatBugReport`와 **애플리케이션 메뉴 바** `Help > Copy Bug Report`는 앱/런타임 버전, OS 정보, `app.jsonl` 절대 경로, 최근 에러/경고 최대 10건(스택 트레이스 포함), 최근 동작 Breadcrumb 최대 50건을 마크다운으로 포맷해 클립보드에 복사하고 네이티브 완료 메시지 박스를 표시합니다.
- [x] **애플리케이션 메뉴 바** `Help > Open Log Folder`는 로그 폴더 생성을 보장한 뒤 OS 탐색기에서 열고, 기존 `Help > Version` 항목은 그대로 유지됩니다.
- [x] 격리된 임시 디렉토리 기반 TDD 테스트와 `npm test`, `npm run typecheck`, `npm run build`가 모두 통과합니다.

## Answer

- **구현 내용**:
  - `src/shared/logging.ts`, `src/main/asyncQueue.ts`: 공유 로그 스키마(`LogEntry`, `SerializedError`, `serializeError`) 및 `LogService`·`ConfigService` 공용 직렬 비동기 큐(`createAsyncQueue`) 정의
  - `src/main/logging/LogService.ts`: 주입 가능한 `logDir` 기반 JSON Lines 로거, 2MB 초과 시 최대 3파일(`app.jsonl` → `app.1.jsonl` → `app.2.jsonl`) 자동 로테이션, Fail-safe 오류 격리 및 역순 병합 파싱(`readEntries`)
  - `src/main/ipc/ipcHelpers.ts`, `registerConfigIpc.ts`, `registerWorkspaceIpc.ts`, `registerGitIpc.ts`: `config:*`, `workspace:*`, `git:*` IPC 호출 소요 시간(`durationMs`)·성공/실패 자동 로깅 및 본문(`content`, `initialContent`, `raw`) 마스킹(`contentLength` 메타데이터만 기록)
  - `src/main/git/GitService.ts`, `src/main/config/ConfigService.ts`: Git CLI 원본 실패(`stderr`, `stdout`, `code`, `signal`) `error` 로깅 및 손상된 `config.json` 백업 복구 시 `warn` 로깅
  - `src/main/logging/processLifecycleLogging.ts`, `helpMenuActions.ts`, `formatBugReport.ts`, `src/main/menu.ts`, `src/main/index.ts`: 앱 `ready`/`will-quit`, `uncaughtException`, `unhandledRejection`, `render-process-gone` 수집, `formatBugReport` AI 마크다운 포맷터 및 `Help` 메뉴 `Copy Bug Report`·`Open Log Folder`·`Version` 연결
- **검증 결과**: `npm test`(35개 테스트 파일 191개 테스트 통과), `npm run typecheck`, `npm run build` 모두 통과 및 병렬 2축 `/code-review` 2회차 지적사항 0건 (커밋 `4f7376e`, `b3166a4`)
