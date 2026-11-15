# 06 — 전역 설정 패널을 가운데 모달로 전환

**Spec:** [spec.md](../spec.md)

**What to build:** `Settings > 설정 패널` 메뉴(`toggle-settings`)로 열리는 전역 설정 패널을 우측 고정 패널에서 화면 가운데 모달(오버레이 + 대화상자)로 바꿉니다. 이렇게 하면 우측 영역은 문서 목차 전용이 됩니다. `닫기` 버튼, `Esc`, 배경 클릭으로 모달을 닫습니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 메뉴 `toggle-settings`를 실행하면 `role="dialog"`, `aria-modal="true"`, 접근 가능한 이름 `전역 설정 패널`을 가진 모달이 화면 가운데에 열리고, 다시 실행하면 닫힙니다(토글 의미 유지).
- [x] `닫기` 버튼, `Esc` 키, 배경(오버레이) 클릭으로 모달이 닫힙니다. 모달 내부를 클릭해서는 닫히지 않습니다.
- [x] 모달이 열려 있는 동안 편집기 단축키가 동작하지 않습니다(확인 다이얼로그의 `isShortcutDisabled` 처리 방식을 따름).
- [x] 모달은 편집 공간 레이아웃의 너비를 차지하지 않습니다(우측 고정 패널 제거).
- [x] 모달에서 `설정 파일 직접 열기`를 실행해 `config.json`을 편집기에 여는 기존 흐름이 동작하며, 이때 모달이 닫혀 편집기가 보입니다.
- [x] 모달 위에 확인 다이얼로그가 떠야 하는 경우 확인 다이얼로그가 가려지지 않도록 레이어를 정합니다.
- [x] 기존 설정 패널 관련 `<App />` 통합 테스트(테마·자동 저장·헤딩 번호 토글, `설정 파일 직접 열기`, `닫기`)가 모달 기준으로 통과하고, `Esc`·배경 클릭으로 닫는 테스트가 추가됩니다.
- [x] `CONTEXT.md`의 **전역 설정 패널** 정의를 "우측 패널"에서 "가운데 모달"로 고칩니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `f4d0f1a`, `4426910`
- Verification: `npm run typecheck`, `npm test` (`38 passed (38)`, `235 passed (235)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings after 2 iterations.
