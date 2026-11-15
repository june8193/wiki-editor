# 01 — 창 간 공유 문서 버퍼 허브 및 참조 카운트·자동 저장 단일화

**Spec:** [spec.md](../spec.md)

**What to build:** 여러 창 인스턴스가 `workspace` 및 `config` **문서 버퍼**(`content`, `savedContent`, `isDirty`, `isSaving`, `version`)와 창별 열린 탭 참조 목록을 실시간으로 공유하고, 전체 창 기준 마지막 남은 탭을 닫을 때만 미저장 **확인 다이얼로그**를 띄우며, `autoSave` 시 중복 파일 쓰기가 일어나지 않도록 중앙 공유 문서 버퍼 코디네이터 및 IPC 계약을 구축합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 중앙 공유 문서 버퍼 코디네이터 및 IPC 계약을 통해 여러 창 인스턴스가 `workspace` 및 `config` **문서 버퍼**(`content`, `savedContent`, `isDirty`, `isSaving`, `version`)를 실시간으로 공유합니다.
- [x] 한 창에서 문서를 편집·저장하거나 파일 이름 변경·삭제·외부 디스크 변경 재조정이 일어나면 같은 문서를 열고 있는 다른 창의 **문서 편집기** 본문, 미저장 배지(`●`), **에디터 헤더** 저장 상태가 즉시 동기화됩니다.
- [x] 창별 열린 탭 참조 목록(창 파괴 시 자동 정리 포함)을 추적하여, 여러 창(또는 같은 창의 여러 **편집기 영역**)에 동일 문서 탭이 열려 있을 때 탭 하나를 닫으면 확인 없이 즉시 닫히고, 전체 창 기준 마지막 남은 탭을 닫을 때만 미저장 **확인 다이얼로그**가 표시됩니다.
- [x] `autoSave` 활성화 시 동일 미저장 **문서 버퍼**가 여러 창에 열려 있어도 중복 디스크 쓰기 경쟁 없이 단일화된 자동 저장이 수행됩니다.
- [x] 기존 단일 창 시나리오가 회귀 없이 동작하며, 멀티윈도우 `<App />` 통합 테스트 심과 메인 프로세스 공유 버퍼 IPC 테스트 심이 위 동작들을 검증합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `d71e8f6`, `6b5f980`, `99a058b`, `d8e2e54`, `35cbdb7`, `0f02153`, `ba42096`, `34aa99b`, `16f100f`, `b8ff0b5`, `cef325b`, `eb7281f`
- Verification: `npm run typecheck`, `npm test` (`42 passed (42)`, `266 passed (266)`), `npm run build` passed; parallel `/code-review` converged to 0 Spec findings and 0 Standards hard violations (Round 7 after follow-up).
