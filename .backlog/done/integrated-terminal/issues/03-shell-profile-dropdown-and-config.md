# 03 — 셸 프로필 드롭다운 및 전역 설정 기본 프로필 연동

**Spec:** [spec.md](../spec.md)

**Blocked by:** 02-terminal-panel-shell-and-multi-tabs

**Status:** resolved

**What to build:** **터미널 패널** 헤더의 `+ ▾` 드롭다운에서 감지된 셸 프로필을 선택해 새 **터미널 탭**을 여는 기능과, `config.json` 및 **전역 설정 패널**에 `defaultTerminalProfile` 설정을 추가해 기본 셸을 지정·유지하는 기능을 구현합니다.

- [ ] `AppConfig`에 `defaultTerminalProfile?: string | null` 필드를 추가하고 엄격 검증·정규화를 적용하며, 지정된 프로필이 시스템에 없거나 `null`일 때는 자동 감지 기본 프로필(`pwsh.exe` → `powershell.exe`)로 안전하게 폴백한다.
- [ ] **전역 설정 패널**에 감지된 셸 프로필 목록(`자동 감지 (기본)` 포함)을 선택할 수 있는 기본 터미널 프로필 설정 UI를 추가하고 `config.json`에 즉시 저장한다.
- [ ] **터미널 패널** 헤더의 `+ ▾` 드롭다운에서 감지된 프로필 목록을 표시하고, 선택한 프로필로 새 **터미널 탭**을 생성하며, 기본 `+` 버튼 및 `Ctrl+Shift+`` 단축키는 설정된 `defaultTerminalProfile`을 우선 사용한다.
- [ ] `ConfigService` 및 `App` + 인메모리 `WikiApi` 통합 테스트가 모두 통과한다.
