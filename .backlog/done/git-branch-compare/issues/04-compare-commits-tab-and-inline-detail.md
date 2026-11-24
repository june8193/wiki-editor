# 04 — Compare 패널 Commits 서브 탭 및 인라인 커밋 상세 Diff 연동

**Spec:** [spec.md](../spec.md)

**What to build:** **Compare 패널**에 **Commits** 서브 탭을 구현해 비교 범위 내 커밋 목록을 표시하고, 커밋 클릭 시 **Graph 섹션**과 동일한 인라인 커밋 상세(해시 복사, 본문, 변경 파일 목록)를 펼쳐 해당 커밋의 **Diff 탭**을 열 수 있도록 연결합니다.

**Blocked by:** 03-compare-view-shell-and-files-diff

**Status:** resolved

- [ ] **Compare 패널**에서 `Files (N)` / `Commits (M)` 서브 탭을 전환할 수 있으며, `Base`·`Compare`·`3-dot`/`2-dot` 변경 시 두 탭의 카운트와 데이터가 함께 갱신된다.
- [ ] **Commits** 탭에서 커밋 목록(단축 해시, 제목, 작성자, 상대/포맷 시각)을 표시하고, 커밋이 0건일 때 빈 상태 안내를 표시한다.
- [ ] 커밋 행을 클릭하면 기존 커밋 상세 조회 API를 재사용해 인라인 상세(전체/단축 해시 복사 버튼, 제목·본문, 변경 파일 목록)를 토글해 펼친다.
- [ ] 인라인 커밋 상세의 파일 행을 클릭하면 활성 **편집기 영역**에 해당 커밋 맥락(`commit <shortHash>`)이 표시되는 읽기 전용 `commit` **Diff 탭**을 연다.
- [ ] `App` + 인메모리 `WikiApi` 하네스 통합 테스트 심으로 `Files` ↔ `Commits` 전환, 커밋 인라인 상세 펼치기/해시 복사, 커밋 파일 클릭 시 **Diff 탭** 열기를 검증한다.
