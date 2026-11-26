# 01 — Compare 폴더트리 폴더 행 음영 제거 및 스타일 통일

**Spec:** [spec.md](../spec.md)

**What to build:** **Compare 패널**의 폴더 트리에서 폴더 행 버튼이 브라우저 기본 회색 음영 없이 **Git 뷰** **Changes 섹션** 폴더 트리와 동일한 투명 배경, 테두리 없음, 호버/포커스 스타일로 렌더링되도록 수정하고 회귀 테스트로 검증합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] **Compare 패널** 폴더 트리의 폴더 행 버튼이 정의되지 않은 클래스 대신 **Git 뷰** 폴더 트리 폴더 행의 공통 스타일 클래스(`git-tree-dir-btn` 및 컨테이너 구조)를 사용하여 기본 버튼 배경 음영이 제거됩니다.
- [ ] 기존 폴더 접기/펼치기, 들여쓰기(`depth`), 폴더/열린 폴더 아이콘, `aria-expanded` 상태, `title` 툴팁 동작이 그대로 유지됩니다.
- [ ] App 통합 테스트에서 **Compare 패널** 폴더 행에 올바른 스타일 클래스가 적용되고 잘못된 클래스가 남아 있지 않음을 검증합니다.
- [ ] 관련 테스트 및 전체 타입 체크가 통과합니다.
