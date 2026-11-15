# 01 — 문서 편집기 Split 모드(Raw + Preview) 및 비율 조절 구분선 구현

**Spec:** [spec.md](../spec.md)

**What to build:** 단일 **문서 편집기** 안에서 좌측 Raw 원문 에디터와 우측 실시간 Preview를 나란히 표시하는 4번째 **에디터 모드** `Split`을 추가합니다. **에디터 헤더** 버튼(`Raw | 위지윅 | Preview | Split`)과 단축키(`Ctrl+4`, `Ctrl+Shift+M` 순환), 비마크다운 문서 잠금, 탭별 좌우 폭 비율 조절 구분선(기본 `0.5`, 드래그·방향키 조절, 더블클릭 시 `0.5` 초기화), `/toc` 삽입 커서 연동, 그리고 좌측에서 마크다운 및 **Mermaid 다이어그램 블록** 코드를 수정하면 우측 Preview가 실시간으로 갱신되는 E2E 경로와 도메인 용어집 갱신을 완결합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `EditorMode`에 `'split'`이 추가되고, **에디터 헤더** 모드 전환기에 `Raw (Ctrl+1)`, `위지윅 (Ctrl+2)`, `Preview (Ctrl+3)`, `Split (Ctrl+4)` 버튼이 순서대로 표시되며 `Ctrl/Cmd+4` 및 `Ctrl/Cmd+Shift+M` 순환(`raw -> wysiwyg -> preview -> split -> raw`)으로 전환됩니다.
- [ ] `config.json`, `.json`, `.txt` 등 비마크다운 **문서 버퍼**에서는 `Split` 버튼과 단축키 전환이 비활성화되어 `Raw` 모드로만 유지됩니다.
- [ ] `Split` 모드에서 좌측에는 기존 Raw 에디터(**표 편집 툴바**, **슬래시 명령어 메뉴**, 구문 강조 포함, `data-testid="document-editor"`)가, 우측에는 실시간 Preview(`aria-label="마크다운 미리보기"`, `data-testid="split-markdown-preview"`)가 나란히 렌더링되어 좌측에서 마크다운·Mermaid 코드를 수정하면 우측 렌더링 결과가 실시간 갱신됩니다.
- [ ] 좌우 영역 사이의 내부 분할 구분선(`role="separator"`, 기본 비율 `0.5`)을 마우스 드래그 및 `ArrowLeft`/`ArrowRight`(`±0.05`)로 `0.15 ~ 0.85` 범위에서 조절할 수 있고, 구분선을 더블클릭하면 `0.5`로 초기화되며, 설정한 비율은 탭별 뷰 상태(`splitPreviewRatio`)로 유지됩니다.
- [ ] `Split` 모드에서 **문서 목차** 패널의 `본문에 목차(/toc) 삽입`을 실행하면 현재 Raw 커서 줄 위치를 기준으로 목차가 삽입·갱신되며, 모드 전환 시 `editor-mode-changed` UI 동작 로그가 정상 기록됩니다.
- [ ] 도메인 용어집의 **에디터 모드** 설명에 `Split` 모드가 반영되고, 관련 단위·통합 테스트가 모두 통과합니다.
