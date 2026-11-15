# 01 — 문서 목차를 우측 사이드바로 이동

**Spec:** [spec.md](../spec.md)

**What to build:** 왼쪽 사이드바 하단에 있던 문서 목차를 편집 공간 오른쪽의 우측 사이드바로 옮깁니다. 헤딩 클릭 스크롤, 목차(TOC) 삽입, 헤딩 넘버링 적용·제거, 헤딩 번호 표시 토글이 기존과 동일하게 동작하고, 활성 문서가 없거나 마크다운이 아닐 때는 사이드바를 유지한 채 빈 상태 메시지를 표시합니다. 이 단계에서 `lucide-react` 의존성도 도입합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] `lucide-react`가 런타임 의존성으로 추가되고 타입체크·빌드가 통과합니다.
- [x] 문서 목차(`문서 목차 (Outline)`)가 왼쪽 사이드바에서 사라지고, 편집 공간 오른쪽의 우측 사이드바(`aria-label="우측 사이드바"` 등 접근 가능한 랜드마크)에 기본 펼침 상태로 렌더링됩니다.
- [x] 우측 사이드바에서 헤딩 클릭 시 해당 위치로 스크롤하는 동작, TOC 삽입, 헤딩 넘버링 적용·제거, 헤딩 번호 표시 토글이 기존 `<App />` 통합 테스트 기준으로 회귀 없이 동작합니다.
- [x] 활성 문서가 없으면 "열린 문서 없음", 마크다운이 아니면 "마크다운 문서가 아닙니다" 같은 빈 상태 메시지를 표시하고 우측 사이드바 자체는 사라지지 않습니다.
- [x] 우측 사이드바 기본 너비는 240px입니다(접기·리사이즈는 05번 티켓 범위).
- [x] `CONTEXT.md`에서 **문서 목차**의 위치 설명을 우측 사이드바로 고치고 **우측 사이드바** 용어를 추가하며, **왼쪽 사이드바** 정의에서 문서 목차를 제거합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commit: `d46ffcc`
- Verification: `npm run typecheck`, `npm test` (`37 passed (37)`, `217 passed (217)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings in 1 iteration.
