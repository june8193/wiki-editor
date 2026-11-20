# 01 — Vitest 멀티 프로젝트 환경 라우팅 및 `vmThreads` 워커 재사용 구성

**Spec:** [spec.md](../spec.md)

**What to build:** Vitest 멀티 프로젝트 설정을 정비하여 브라우저 DOM에 전혀 의존하지 않는 렌더러 순수 상태 스토어 및 유틸리티 단위 테스트(`.test.ts`)들이 가벼운 `node` 환경 프로젝트에서 즉시 실행되도록 라우팅하고, 실제 DOM이 필요한 `renderer` 프로젝트는 워커당 `jsdom`을 1회만 생성하면서 파일 간 모듈 격리를 유지하는 `vmThreads` 풀로 전환합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 렌더러 하위의 순수 유틸리티 및 순수 상태 스토어 단위 테스트(`.test.ts`) 중 `DOMPurify`, `CodeMirror`, `TipTap`, React 렌더링, 브라우저 전역(`window`/`document`)에 직간접 의존이 없는 스위트들이 `node` 프로젝트에 포함되어 `jsdom` 부팅 없이 실행됩니다.
- [ ] DOM 살균기(`DOMPurify`), 코드 편집기 뷰(`CodeMirror` / `ProseMirror`), 브라우저 레이아웃·캔버스·이벤트 객체에 의존하는 렌더러 `.test.ts` 및 모든 `.test.tsx` 스위트는 누락이나 중복 수집 없이 `renderer` 프로젝트(`jsdom`)에서 실행됩니다.
- [ ] `renderer` 프로젝트에 `vmThreads` 풀이 적용되어 워커 스레드당 `jsdom` 환경 생성 횟수가 줄어들고, Vitest 실행 결과에서 과도한 `jsdom` 반복 생성 경고가 해소됩니다.
- [ ] 프로덕션 코드를 변경하지 않으며, 기존 전체 테스트 케이스(`741`개)가 단 한 건의 누락이나 이중 수집 없이 모두 통과하고 `npm run typecheck`, `npm test`, `npm run build`가 정상 성공합니다.
