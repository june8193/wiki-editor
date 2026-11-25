# 01 — 터미널 PTY 백엔드, IPC 계약 및 패키징 설정

**Spec:** [spec.md](../spec.md)

**What to build:** `node-pty` 기반 Main 프로세스 터미널 세션 매니저(Windows 셸 프로필 자동 감지, 지연 생성, 입출력·리사이즈·종료, 워크스페이스 전환/창 닫기 시 자동 종료), **보조 창** 차단 및 경로·셸·URL 보안 검증을 포함한 IPC·프리로드 API(`WikiTerminalApi`), 그리고 `node-pty` 네이티브 모듈 패키징 설정을 엔드투엔드로 구현합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `package.json`에 `node-pty` 런타임 의존성과 `electron-builder` `asarUnpack` 설정을 반영하고, `packaging.test.ts`를 `node-pty`만 허용하는 패키징 계약으로 갱신해 통과한다.
- [ ] Windows 셸 프로필 감지기(`pwsh.exe` 우선 → `powershell.exe` 폴백, `cmd.exe`, Git Bash 등)가 사용 가능한 `TerminalShellProfile` 목록을 반환한다.
- [ ] Main 프로세스 `TerminalService`가 활성 워크스페이스 루트 `cwd`와 허용된 `profileId`로만 PTY 세션을 지연 생성하고, `write`·`resize`·`closeSession` 및 소유 창 한정 `onData`·`onExit` 이벤트를 중계한다.
- [ ] **보조 창** 또는 워크스페이스 미열림 상태의 터미널 IPC 호출을 거부하고, 워크스페이스 전환·**메인 창** 닫힘·앱 종료 시 확인 없이 해당 세션의 모든 PTY 프로세스를 자동 종료한다.
- [ ] `openExternalUrl` IPC가 기존 URI 스킴 보안 검증을 통해 `http`/`https` URL만 기본 브라우저로 열고 비허용 스킴·제어문자를 차단하며, Fake PTY 기반 `TerminalService` + `registerTerminalIpc` 통합 테스트가 모두 통과한다.
