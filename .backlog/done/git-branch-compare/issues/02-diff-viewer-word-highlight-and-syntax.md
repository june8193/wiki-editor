# 02 — 공통 Diff 뷰어 단어 단위(Intra-line) 하이라이트 및 신택스 하이라이팅

**Spec:** [spec.md](../spec.md)

**What to build:** **Changes 섹션**·**Stashes 섹션**·**Graph 섹션** 및 향후 **Compare 뷰**가 모두 공유하는 **Diff 뷰어**에 수정된 줄 내부의 실제 변경 단어·토큰 강조(Intra-line diff)와 파일 확장자 기반 코드 구문 강조(Syntax Highlighting)를 적용합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [ ] 연속된 삭제(`-`) 줄과 추가(`+`) 줄 쌍을 매칭해 토큰 단위 LCS 기반으로 실제 변경된 구간만 강조 표시(과도하게 긴 줄은 성능 보호를 위해 줄 전체 강조로 폴백)한다.
- [ ] 이미 설치된 `@codemirror/language-data` 및 `@lezer/highlight`를 이용해 파일 확장자별 신택스 하이라이팅을 적용하고, 미지원 확장자·비정상적으로 긴 줄은 일반 텍스트로 안전하게 폴백한다.
- [ ] **좌우 비교(Side-by-Side)**와 **인라인(Inline)** 보기 모드 모두에서 단어 단위 하이라이트와 신택스 하이라이팅이 정상 렌더링되며, 라이트/다크 테마 토큰으로 가독성을 유지한다.
- [ ] 선택적 헤더 네비게이션 props(이전/다음 파일 버튼 및 `{index} / {total}` 카운터)를 **Diff 뷰어**가 수용할 수 있도록 인터페이스를 확장한다(기존 호출부는 네비게이션 미전달 시 기존과 동일하게 동작).
- [ ] `GitDiffViewer` 컴포넌트 테스트 심에서 단어 단위 하이라이트, 신택스 하이라이팅, 좌우/인라인 토글, 네비게이션 콜백, 삭제 파일 `파일 열기` 비활성을 검증한다.
