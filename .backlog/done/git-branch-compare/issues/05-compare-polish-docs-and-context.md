# 05 — Compare 뷰 통합 마무리, 보조 창 호환 검증 및 CONTEXT/매뉴얼 문서화

**Spec:** [spec.md](../spec.md)

**What to build:** **Compare 뷰**에서 연 **Diff 탭**이 **보조 창** 이동·복제, 다중 **메인 창** 세션 격리 등 앱 전체 라이프사이클과 매끄럽게 동작하도록 마감 검증하고, 공식 도메인 용어집(`CONTEXT.md`)과 사용자 매뉴얼(`docs/manual.md`)을 갱신합니다.

**Blocked by:** 02-diff-viewer-word-highlight-and-syntax, 04-compare-commits-tab-and-inline-detail

**Status:** resolved

- [ ] `branch-compare` **Diff 탭**을 **보조 창**으로 이동하거나 다른 **편집기 영역**으로 복제·분할했을 때 단어 단위 하이라이트, 신택스 하이라이팅, `좌우 비교`/`인라인` 전환 및 `파일 열기`가 정상 동작한다.
- [ ] `CONTEXT.md`에 **Compare 뷰**, **Compare 패널** 공식 용어를 추가하고 **액티비티 바**·**왼쪽 사이드바**·**Diff 뷰어** 설명을 현행화한다.
- [ ] `docs/manual.md`에 **Compare 뷰** 사용법(Worktree/Local/Remote Ref 선택, `3-dot` vs `2-dot`, **Files**/**Commits** 탭, 이전/다음 파일 이동, 다른 저장소는 `'새 창에서 열기'`로 비교)을 추가한다.
- [ ] 전체 단위/통합 테스트(`npm test`), 타입체크(`npm run typecheck`), 빌드(`npm run build`)가 모두 통과한다.
