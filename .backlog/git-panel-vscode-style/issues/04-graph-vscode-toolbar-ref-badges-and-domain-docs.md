# 04 — Graph 섹션 툴바, 우측 병합 Ref 배지, 인라인 상세 통일 및 도메인 문서 갱신

**Spec:** [spec.md](../spec.md)

**What to build:** **Graph 섹션** 헤더에 범위 전환(`Auto` / `현재 브랜치`)과 `Fetch` · `Pull` · `Push` · `새로고침` 아이콘 툴바를 배치하고, 24px 컴팩트 커밋 행 · 우측 정렬 병합 Ref 배지(`◎ master` + `☁`, 일반 브랜치 체크아웃 시 중복 `HEAD` 생략 · Detached HEAD 시 `HEAD`, 태그 아이콘 배지) · VS Code 파일 행 스타일의 인라인 커밋 상세로 개편하며, 도메인 용어집(`CONTEXT.md`)을 최종 구현에 맞게 갱신합니다.

**Blocked by:** 03-changes-file-list-tree-view-and-hover-actions

**Status:** ready-for-agent

- [ ] 순수 Ref 배지 정규화 모듈이 동일 커밋의 로컬 브랜치와 `<remote>/<branch>` 원격 추적 참조를 `◎ <branch>` + `☁`(원격명 툴팁)로 병합하고, 일치 로컬 브랜치가 없는 원격 참조는 독립 원격 배지로 유지하며, 일반 브랜치 체크아웃 시 중복 `HEAD` 배지를 생략하고 Detached HEAD일 때만 `HEAD` 배지를 노출함을 단위 테스트로 검증합니다.
- [ ] **Graph 섹션** 헤더에 범위 전환(`Auto` / `현재 브랜치`, 기존 `'all'`/`'current'` 범위 계약 유지)과 `lucide-react` 아이콘 툴바(`Fetch`, `Pull`, `Push`, `새로고침`, 실행 중 비활성화)가 접기 버튼과 분리되어 렌더링되고 각 버튼이 해당 Git 작업을 정상 실행합니다.
- [ ] 커밋 행이 24px 컴팩트 높이로 컬러 SVG 레인 + 커밋 제목 + 흐린 작성자 + 우측 정렬 Ref 배지로 렌더링되며, 260px 기본 **왼쪽 사이드바** 너비에서도 제목 말줄임과 우측 배지 배치가 깨지지 않습니다.
- [ ] 커밋 행 클릭 시 펼쳐지는 인라인 커밋 상세의 해시 복사 버튼(`lucide-react` 아이콘)과 변경 파일 목록이 03번 티켓과 동일한 VS Code 파일 행 및 상태 표기 스타일로 표시되며, 파일 클릭 시 기존처럼 커밋 **Diff 탭**이 열립니다.
- [ ] 도메인 용어집(`CONTEXT.md`)의 **Git 패널**, **Changes 섹션**, **Graph 섹션**, **확인 다이얼로그** 설명이 개편된 UI 및 동작에 맞게 정확히 갱신됩니다.
- [ ] `<App />` 통합 테스트 및 단위 테스트, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
