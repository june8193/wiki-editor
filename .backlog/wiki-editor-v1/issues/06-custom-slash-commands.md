# 06 — 나만의 커스텀 슬래시 명령어(/function, /struct 등) 자동완성 및 설정 UI 연동

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 04-three-mode-markdown-editor-and-table
Status: ready-for-agent

**What to build:**
Raw 모드와 위지윅 모드에서 `/` 입력 시 전역 `config.json`에 등록된 나만의 커스텀 슬래시 명령어(`/function`, `/struct` 등) 자동완성 팝업을 띄워 표준 마크다운 템플릿 스니펫을 삽입(`{{cursor}}` 커서 위치 지정 포함)하고, 앱 내 설정 UI와 `config.json` 직접 편집 양쪽에서 자유롭게 명령어를 추가·수정·삭제할 수 있게 구현합니다.

## Acceptance Criteria

- [ ] `SlashCommandEngine`이 `/` 입력 접두어 필터링, 명령어 매칭, 템플릿 플레이스홀더(`{{cursor}}`, `{{date}}`, `{{title}}`) 치환 및 삽입 후 정확한 커서 오프셋 계산을 수행합니다.
- [ ] **에디터 통합(Raw & 위지윅)**: 두 편집 모드 모두에서 `/` 입력 시 커서 위치 근처에 키보드 탐색(↑/↓/Enter/Esc) 및 마우스 클릭이 가능한 슬래시 명령어 팝업이 열리고, 선택 시 트리거 텍스트(`/func...`)를 대체하며 템플릿 마크다운이 삽입됩니다. (기본 내장 예시로 `function`, `struct`, `table`, `mermaid` 등 제공 또는 초기 시드 포함, 사용자 수정 가능)
- [ ] **설정 UI 관리**: 설정 모달/패널의 "커스텀 명령어" 섹션에서 트리거명(중복/공백 검증), 라벨, 설명, 멀티라인 마크다운 템플릿을 추가·수정·삭제·미리보기할 수 있으며 저장 즉시 `config.json`에 반영되고 에디터 자동완성에 실시간 적용됩니다.
- [ ] **JSON 파일 직접 편집 연동**: 사용자가 설정 UI의 "설정 파일(config.json) 열기"로 에디터 탭에서 JSON을 직접 수정하고 저장(`Ctrl+S`)하면 즉시 유효성 검사 후 새 커스텀 명령어가 적용됩니다(유효하지 않은 JSON 저장 시 에러 알림 표시 및 기존 유효 설정 보존).
- [ ] `SlashCommandEngine`, 설정 유효성 검증 및 저장, 팝업 인터랙션 테스트가 모두 통과합니다.
