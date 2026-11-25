# 04 — 터미널 스마트 복사/붙여넣기 및 URL·파일 링크 열기

**Spec:** [spec.md](../spec.md)

**Blocked by:** 02-terminal-panel-shell-and-multi-tabs

**Status:** resolved

**What to build:** **터미널 패널**에 VS Code 스타일 스마트 복사/붙여넣기(선택 텍스트 유무에 따른 `Ctrl+C` 복사/SIGINT 분기, `Ctrl+V` 및 우클릭 붙여넣기)와 `Ctrl+클릭` 링크 열기(외부 `http`/`https` URL 브라우저 열기, 활성 워크스페이스 내 로컬 파일 경로 및 `:line` **편집기 영역** 탭 열기)를 구현합니다.

- [ ] 터미널에 선택 영역이 있을 때 `Ctrl+C`가 선택 텍스트를 클립보드에 복사(SIGINT 미전송)하고, 선택 영역이 없을 때만 PTY로 `\x03`(SIGINT)을 전송한다.
- [ ] `Ctrl+V` 및 터미널 본문 우클릭으로 클립보드 텍스트를 활성 터미널 세션에 붙여넣는다.
- [ ] 터미널 출력의 `http`/`https` URL을 `Ctrl+클릭`하면 `openExternalUrl` IPC를 통해 기본 브라우저로 열며, 안전하지 않은 스킴은 차단한다.
- [ ] 터미널 출력의 워크스페이스 내 로컬 파일 경로(`path`, `path:line`, `path:line:col`)를 `Ctrl+클릭`하면 경로 보안 검증을 거쳐 활성 **편집기 영역**에 문서 탭으로 열고(지정 줄 번호가 있으면 해당 위치로 이동), 워크스페이스 외부 경로는 무시한다.
- [ ] `TerminalPanel` 컴포넌트 테스트 및 `App` + 인메모리 `WikiApi` 통합 테스트(스마트 복사/붙여넣기, URL/파일 링크 열기, 경로 보안 경계)가 모두 통과한다.
