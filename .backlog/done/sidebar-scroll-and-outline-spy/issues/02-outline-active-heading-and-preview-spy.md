# 02 — 문서 목차 활성 헤딩 강조·자동 스크롤 및 Preview 추적

**Spec:** [spec.md](../spec.md)

**What to build:** 스크롤 위치 기반 활성 헤딩 인덱스 판정 순수 로직을 구현하고, **우측 사이드바**의 **문서 목차**에서 활성 헤딩을 시각적·접근성 속성(`aria-current="location"`)으로 강조하며 가시 영역 밖일 때 최소 이동(`nearest`)으로 자동 스크롤합니다. 이를 **Preview** 모드 스크롤과 **문서 목차** 항목 클릭 이동(하단 짧은 섹션 클릭 보호 포함)에 연결하여 엔드투엔드로 동작하게 하고 `CONTEXT.md`를 갱신합니다.

**Blocked by:** 01-viewport-scroll-and-git-header

**Status:** resolved

- [x] 픽셀 오프셋 및 1-based 줄 번호 입력에 대해 첫 헤딩 이전 서문(`null`), 상단 기준선 통과, 비스크롤 짧은 문서(`scrollTop === 0`), 스크롤 최하단 도달(`scrollTop > 0`)을 정확히 판정하는 순수 함수와 단위 테스트가 추가됩니다.
- [x] **문서 목차**는 전달받은 활성 헤딩 인덱스에 해당하는 항목 버튼에만 `aria-current="location"`과 활성 스타일을 적용하고, 활성 헤딩이 변경될 때 `scrollIntoView({ block: 'nearest' })`로 최소 자동 스크롤을 수행합니다(열린 문서 없음·비마크다운·헤딩 없음·서문 구간에서는 어떤 항목도 활성화되지 않음).
- [x] **Preview** 모드에서 문서 본문을 스크롤하면 현재 상단 섹션 헤딩이 **문서 목차**에 실시간 반영되며, 활성 헤딩 인덱스가 변하지 않는 스크롤 구간에서는 불필요한 상태 갱신을 일으키지 않습니다.
- [x] **문서 목차**에서 헤딩 항목을 클릭하면(문서 하단의 짧은 섹션 포함) 클릭한 헤딩이 즉시 활성 상태로 강조 유지되며, 이후 사용자의 실제 추가 스크롤 시 일반 스크롤 판정으로 자연스럽게 복귀합니다.
- [x] `CONTEXT.md`의 **문서 목차** 설명에 문서 스크롤 위치에 따른 현재 헤딩 강조 및 자동 스크롤 동작이 반영됩니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.

## Comments

- Commits: `be8bfc6`, `56f5e1b`, `e525099`, `f3133fd`, `245ff83`
- Verification: `npm run typecheck`, `npm test` (`39 passed (39)`, `246 passed (246)`), `npm run build` passed; parallel `/code-review` completed 5 iterations with 0 hard Standards violations and 0 functional Spec gaps (remaining subjective judgement-call notes deferred/consumed in Ticket 03).
