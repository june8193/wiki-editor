# 05 — 사용자 매뉴얼 및 도메인 용어집 갱신

**Spec:** [spec.md](../spec.md)

**What to build:** EUC-KR 인코딩 자동 감지, **에디터 헤더** 인코딩 메뉴(`다시 열기` / `인코딩 변경`), 손실 보호 다이얼로그 및 검색·Git Diff 연동을 `docs/manual.md`와 `CONTEXT.md`에 반영하고 전체 타입체크·테스트를 최종 검증합니다.

**Blocked by:** 03-editor-header-encoding-ui-and-dialogs, 04-git-diff-euckr-decoding

**Status:** ready-for-agent

- [ ] 사용자 매뉴얼(`docs/manual.md`)에 EUC-KR 지원 범위, **에디터 헤더** 인코딩 확인·전환 방법(`다시 열기` vs `인코딩 변경`), 표현 불가 문자 저장 안내가 사용자 관점으로 문서화되어 있다.
- [ ] 도메인 용어집(`CONTEXT.md`)의 **문서 버퍼**, **에디터 헤더**, **확인 다이얼로그**, **검색 패널**, **Diff 뷰어** 설명이 EUC-KR 인코딩 지원 사항과 일치하도록 갱신되어 있다.
- [ ] `npm run typecheck` 및 `npm test` 전체 스위트가 실패 없이 통과한다.
